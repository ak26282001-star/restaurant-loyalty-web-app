-- =============================================================================
-- Phase 2: engagement. Challenges, streak milestone bonuses, push reminders,
-- and Realtime for live balance updates.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Settings: streak milestone bonuses ({"<streak length>": points}).
-- ---------------------------------------------------------------------------
alter table restaurants alter column settings set default jsonb_build_object(
  'points_per_visit', 10,
  'points_per_currency_unit', 1,
  'visit_cooldown_minutes', 240,
  'streak_window_days', 14,
  'tiers', jsonb_build_object('regular', 5, 'vip', 15, 'legend', 40),
  'streak_bonuses', jsonb_build_object('3', 20, '5', 50, '10', 100),
  'ai', jsonb_build_object(
    'enabled', true, 'auto_issue', false, 'max_discount_percent', 25,
    'max_offers_per_customer_per_week', 2, 'monthly_reward_budget', 500
  )
);

-- ---------------------------------------------------------------------------
-- Push subscriptions and a log that stops the same reminder being sent twice.
-- ---------------------------------------------------------------------------
create table push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id) on delete cascade,
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  endpoint        text unique not null,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  failure_count   int not null default 0,
  last_success_at timestamptz,
  created_at      timestamptz not null default now()
);
create index on push_subscriptions (customer_id, restaurant_id);

create table notification_log (
  id              bigint generated always as identity primary key,
  membership_id   uuid not null references memberships(id) on delete cascade,
  kind            text not null,            -- 'streak_at_risk', ...
  ref             text not null,            -- what it is about, e.g. the last visit time
  sent_count      int not null default 0,
  created_at      timestamptz not null default now(),
  unique (membership_id, kind, ref)
);

alter table push_subscriptions enable row level security;
alter table notification_log   enable row level security;
create policy "push self read"   on push_subscriptions for select using (customer_id = auth.uid());
create policy "push self delete" on push_subscriptions for delete using (customer_id = auth.uid());
create policy "notifications staff read" on notification_log for select using (
  exists (select 1 from memberships m where m.id = membership_id and is_staff(m.restaurant_id, 'manager'))
);

-- Managers see challenge progress for their restaurant (stats on the dashboard).
-- The lookup goes through a security-definer function: a policy on challenge_progress that
-- queried challenges directly would recurse, because challenges' own policy for personalised
-- challenges queries challenge_progress.
create or replace function challenge_restaurant_id(p_challenge_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select restaurant_id from challenges where id = p_challenge_id;
$$;

create policy "progress staff read" on challenge_progress for select using (
  is_staff(challenge_restaurant_id(challenge_id), 'manager')
);

-- ---------------------------------------------------------------------------
-- Daypart of a moment in the restaurant's timezone.
-- ---------------------------------------------------------------------------
create or replace function daypart_of(p_ts timestamptz, p_tz text)
returns text language sql stable as $$
  select case
    when h between 5 and 10  then 'breakfast'
    when h between 11 and 14 then 'lunch'
    when h between 15 and 16 then 'afternoon'
    when h between 17 and 21 then 'dinner'
    else 'late'
  end
  from (select extract(hour from p_ts at time zone p_tz)::int as h) t;
$$;

-- ---------------------------------------------------------------------------
-- Current progress of one member on one challenge: {"value": n, "target": n}.
-- Recomputed from confirmed visits, so it is always consistent and idempotent.
-- Returns null for kinds that need data the app doesn't collect yet (try_items).
-- ---------------------------------------------------------------------------
create or replace function challenge_progress_value(p_challenge challenges, p_member memberships)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r       jsonb := p_challenge.rule;
  v_tz    text;
  v_from  timestamptz := p_challenge.starts_at;
  v_until timestamptz := coalesce(p_challenge.ends_at, 'infinity');
  v_value bigint;
  v_target bigint;
begin
  select timezone into v_tz from restaurants where id = p_challenge.restaurant_id;
  if (r ? 'within_days') then
    v_from := greatest(v_from, now() - make_interval(days => (r->>'within_days')::int));
  end if;

  case p_challenge.kind
    when 'visit_count' then
      v_target := (r->>'visits')::int;
      select count(*) into v_value from visits
       where customer_id = p_member.customer_id and restaurant_id = p_member.restaurant_id
         and status = 'confirmed' and visited_at >= v_from and visited_at < v_until;

    when 'spend_amount' then
      v_target := (r->>'spend_cents')::int;
      select coalesce(sum(spend_cents), 0) into v_value from visits
       where customer_id = p_member.customer_id and restaurant_id = p_member.restaurant_id
         and status = 'confirmed' and visited_at >= v_from and visited_at < v_until;

    when 'time_window' then
      v_target := (r->>'visits')::int;
      select count(*) into v_value from visits
       where customer_id = p_member.customer_id and restaurant_id = p_member.restaurant_id
         and status = 'confirmed' and visited_at >= v_from and visited_at < v_until
         and (not (r ? 'weekdays') or extract(dow from visited_at at time zone v_tz)::int
              in (select jsonb_array_elements_text(r->'weekdays')::int))
         and (not (r ? 'daypart') or daypart_of(visited_at, v_tz) = r->>'daypart');

    when 'streak' then
      v_target := (r->>'length')::int;
      v_value := p_member.current_streak;

    else
      return null;
  end case;

  return jsonb_build_object('value', v_value, 'target', v_target);
end $$;

-- ---------------------------------------------------------------------------
-- Update every relevant challenge for a member and pay out new completions.
-- Returns the challenges completed by this call.
-- ---------------------------------------------------------------------------
create or replace function evaluate_challenges(p_membership_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_member    memberships%rowtype;
  v_ch        challenges%rowtype;
  v_progress  jsonb;
  v_row       challenge_progress%rowtype;
  v_tpl       reward_templates%rowtype;
  v_reward_id uuid;
  v_done      jsonb := '[]'::jsonb;
begin
  select * into v_member from memberships where id = p_membership_id;

  for v_ch in
    select c.* from challenges c
     where c.restaurant_id = v_member.restaurant_id
       and c.is_active
       and c.starts_at <= now()
       and (c.ends_at is null or c.ends_at > now())
       and (not c.is_personalised or exists (
             select 1 from challenge_progress p where p.challenge_id = c.id and p.membership_id = v_member.id))
  loop
    v_progress := challenge_progress_value(v_ch, v_member);
    continue when v_progress is null;

    insert into challenge_progress (challenge_id, membership_id, progress)
    values (v_ch.id, v_member.id, v_progress)
    on conflict (challenge_id, membership_id) do update
      set progress = excluded.progress
      where challenge_progress.status = 'active'
    returning * into v_row;

    -- Already completed (the upsert skipped the update), or not there yet.
    continue when v_row.id is null or v_row.status <> 'active'
               or (v_progress->>'value')::bigint < (v_progress->>'target')::bigint;

    update challenge_progress set status = 'completed', completed_at = now() where id = v_row.id;

    if v_ch.bonus_points > 0 then
      perform award_points(v_member.id, v_ch.bonus_points, 'challenge', 'challenge', v_ch.id, 'challenge:' || v_row.id);
    end if;

    v_reward_id := null;
    if v_ch.reward_template_id is not null then
      select * into v_tpl from reward_templates where id = v_ch.reward_template_id and is_active;
      if found then
        insert into rewards (restaurant_id, membership_id, template_id, origin, title, message, expires_at)
        values (v_member.restaurant_id, v_member.id, v_tpl.id, 'challenge', v_tpl.name,
                'Challenge complete: ' || v_ch.title, now() + make_interval(days => v_tpl.valid_days))
        returning id into v_reward_id;
      end if;
    end if;

    v_done := v_done || jsonb_build_object('challenge_id', v_ch.id, 'title', v_ch.title,
                                           'bonus_points', v_ch.bonus_points, 'reward_id', v_reward_id);
  end loop;

  return v_done;
end $$;

-- ---------------------------------------------------------------------------
-- confirm_visit, now with streak milestone bonuses and challenge evaluation.
-- ---------------------------------------------------------------------------
create or replace function confirm_visit(p_visit_id uuid, p_confirmed_by uuid default null, p_spend_cents int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_visit      visits%rowtype;
  v_member     memberships%rowtype;
  v_settings   jsonb;
  v_points     int;
  v_streak     int;
  v_bonus      int := 0;
  v_tier       tier_level;
  v_balance    int;
  v_spend      int;
  v_challenges jsonb;
begin
  select * into v_visit from visits where id = p_visit_id for update;
  if not found then
    raise exception 'visit_not_found' using errcode = 'P0002';
  end if;

  select * into v_member from memberships
   where restaurant_id = v_visit.restaurant_id and customer_id = v_visit.customer_id
   for update;

  if v_visit.status = 'confirmed' then
    return jsonb_build_object('status', 'confirmed', 'visit_id', v_visit.id, 'already_confirmed', true,
      'points_balance', v_member.points_balance, 'streak', v_member.current_streak, 'tier', v_member.tier);
  end if;
  if v_visit.status = 'rejected' then
    raise exception 'visit_rejected' using errcode = 'P0001';
  end if;

  select settings into v_settings from restaurants where id = v_visit.restaurant_id;
  v_spend := coalesce(p_spend_cents, v_visit.spend_cents);

  v_points := coalesce((v_settings->>'points_per_visit')::int, 10)
            + coalesce(floor(v_spend / 100.0 * coalesce((v_settings->>'points_per_currency_unit')::numeric, 1))::int, 0);

  v_streak := case
    when v_member.last_visit_at is null then 1
    when v_visit.visited_at - v_member.last_visit_at
         <= make_interval(days => coalesce((v_settings->>'streak_window_days')::int, 14))
      then v_member.current_streak + 1
    else 1
  end;

  -- Streaks grow one visit at a time, so hitting a milestone means equality.
  v_bonus := coalesce(
    (coalesce(v_settings->'streak_bonuses', '{"3": 20, "5": 50, "10": 100}'::jsonb) ->> v_streak::text)::int, 0);

  v_tier := tier_for(v_member.visit_count + 1, v_settings->'tiers');
  if v_tier < v_member.tier then v_tier := v_member.tier; end if;

  update visits
     set status = 'confirmed', confirmed_by = p_confirmed_by, spend_cents = v_spend
   where id = v_visit.id;

  update memberships
     set visit_count    = visit_count + 1,
         current_streak = v_streak,
         longest_streak = greatest(longest_streak, v_streak),
         last_visit_at  = greatest(coalesce(last_visit_at, v_visit.visited_at), v_visit.visited_at),
         tier           = v_tier
   where id = v_member.id;

  v_balance := award_points(v_member.id, v_points, 'visit', 'visit', v_visit.id, 'visit:' || v_visit.id);
  if v_bonus > 0 then
    v_balance := award_points(v_member.id, v_bonus, 'streak_bonus', 'visit', v_visit.id, 'streak:' || v_visit.id);
  end if;

  v_challenges := evaluate_challenges(v_member.id);
  select points_balance into v_balance from memberships where id = v_member.id;

  return jsonb_build_object(
    'status', 'confirmed',
    'visit_id', v_visit.id,
    'points_awarded', v_points,
    'streak_bonus', v_bonus,
    'points_balance', v_balance,
    'streak', v_streak,
    'tier', v_tier,
    'tier_upgraded', v_tier <> v_member.tier,
    'challenges_completed', v_challenges
  );
end $$;

-- ---------------------------------------------------------------------------
-- Members whose streak ends within the next 36 hours and who can get a push.
-- Each streak is reminded at most once (keyed by the last visit time).
-- ---------------------------------------------------------------------------
create or replace function streak_reminder_candidates()
returns table (membership_id uuid, customer_id uuid, restaurant_id uuid, restaurant_name text, restaurant_slug text,
               streak int, expires_at timestamptz, ref text)
language sql stable security definer set search_path = public as $$
  select m.id, m.customer_id, m.restaurant_id, r.name, r.slug::text, m.current_streak,
         m.last_visit_at + make_interval(days => coalesce((r.settings->>'streak_window_days')::int, 14)),
         m.last_visit_at::text
    from memberships m
    join restaurants r on r.id = m.restaurant_id
   where m.current_streak >= 2
     and m.last_visit_at + make_interval(days => coalesce((r.settings->>'streak_window_days')::int, 14))
         between now() and now() + interval '36 hours'
     and exists (select 1 from push_subscriptions s
                  where s.customer_id = m.customer_id and s.restaurant_id = m.restaurant_id)
     and not exists (select 1 from notification_log n
                      where n.membership_id = m.id and n.kind = 'streak_at_risk' and n.ref = m.last_visit_at::text);
$$;

revoke execute on function confirm_visit(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function evaluate_challenges(uuid) from public, anon, authenticated;
revoke execute on function challenge_progress_value(challenges, memberships) from public, anon, authenticated;
revoke execute on function streak_reminder_candidates() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: stream a member's own balance, rewards and challenge progress.
-- RLS still applies to Realtime, so each customer only receives their own rows.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table memberships, rewards, challenge_progress;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Security hardening for Phase 1 policies.
-- Row-level policies decide WHICH rows a user may touch; these column grants
-- decide WHAT they may change. Without them, a signed-in customer could raise
-- their own points_balance through the public REST API.
-- ---------------------------------------------------------------------------
revoke update on memberships from anon, authenticated;
grant  update (marketing_opt_in, preferred_channel) on memberships to authenticated;

revoke update on customers from anon, authenticated;
grant  update (first_name, birthday, locale) on customers to authenticated;

-- Staff may reject a pending visit; confirming goes through confirm_visit (which awards points).
-- Creating visits is only done by check_in and the POS integration.
drop policy "visits staff" on visits;
create policy "visits staff read" on visits for select using (is_staff(restaurant_id));
create policy "visits staff reject" on visits for update
  using (is_staff(restaurant_id) and status = 'pending')
  with check (is_staff(restaurant_id) and status = 'rejected');
revoke insert, delete on visits from anon, authenticated;
revoke update on visits from anon, authenticated;
grant  update (status, confirmed_by) on visits to authenticated;

-- Staff can see rewards; only managers can issue or change them directly.
drop policy "rewards staff" on rewards;
create policy "rewards staff read" on rewards for select using (is_staff(restaurant_id));
create policy "rewards manager write" on rewards for all
  using (is_staff(restaurant_id, 'manager')) with check (is_staff(restaurant_id, 'manager'));
