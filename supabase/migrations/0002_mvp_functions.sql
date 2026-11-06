-- =============================================================================
-- MVP server-side functions: check-in, visit confirmation, reward claim/redeem.
-- All value-moving logic runs here, inside one transaction, with the membership
-- row locked, so concurrent taps or retries can never double-award points.
-- Called only from server routes using the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Create a customers row when someone signs up through Supabase Auth.
-- ---------------------------------------------------------------------------
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into customers (id, phone, email)
  values (new.id, new.phone, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Tier for a visit count, using restaurants.settings.tiers thresholds.
-- ---------------------------------------------------------------------------
create or replace function tier_for(p_visits int, p_tiers jsonb)
returns tier_level language sql immutable as $$
  select case
    when p_visits >= coalesce((p_tiers->>'legend')::int, 40)  then 'legend'::tier_level
    when p_visits >= coalesce((p_tiers->>'vip')::int, 15)     then 'vip'::tier_level
    when p_visits >= coalesce((p_tiers->>'regular')::int, 5)  then 'regular'::tier_level
    else 'member'::tier_level
  end;
$$;

-- ---------------------------------------------------------------------------
-- Confirm a visit: award points, advance streak and tier. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function confirm_visit(p_visit_id uuid, p_confirmed_by uuid default null, p_spend_cents int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_visit     visits%rowtype;
  v_member    memberships%rowtype;
  v_settings  jsonb;
  v_points    int;
  v_streak    int;
  v_tier      tier_level;
  v_balance   int;
  v_spend     int;
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

  v_tier := tier_for(v_member.visit_count + 1, v_settings->'tiers');
  -- Tiers never drop on a visit; nightly re-evaluation handles downgrades.
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

  return jsonb_build_object(
    'status', 'confirmed',
    'visit_id', v_visit.id,
    'points_awarded', v_points,
    'points_balance', v_balance,
    'streak', v_streak,
    'tier', v_tier,
    'tier_upgraded', v_tier <> v_member.tier
  );
end $$;

-- ---------------------------------------------------------------------------
-- Check in from a tap. Creates the membership on first visit, enforces the
-- cooldown, and auto-confirms when the tap is trusted (SUN tag or geofence).
-- ---------------------------------------------------------------------------
create or replace function check_in(
  p_customer_id uuid, p_restaurant_id uuid, p_tag_id uuid,
  p_trusted boolean, p_tap_event_id bigint default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_member    memberships%rowtype;
  v_cooldown  int;
  v_recent    visits%rowtype;
  v_location  uuid;
  v_visit_id  uuid;
begin
  if not exists (select 1 from tags where id = p_tag_id and restaurant_id = p_restaurant_id and is_active) then
    raise exception 'tag_not_found' using errcode = 'P0002';
  end if;

  insert into memberships (restaurant_id, customer_id, joined_via_tag_id)
  values (p_restaurant_id, p_customer_id, p_tag_id)
  on conflict (restaurant_id, customer_id) do nothing;

  -- Row lock serialises concurrent check-ins for the same member.
  select * into v_member from memberships
   where restaurant_id = p_restaurant_id and customer_id = p_customer_id
   for update;

  select coalesce((settings->>'visit_cooldown_minutes')::int, 240) into v_cooldown
    from restaurants where id = p_restaurant_id;

  select * into v_recent from visits
   where restaurant_id = p_restaurant_id and customer_id = p_customer_id
     and status in ('pending', 'confirmed')
     and visited_at > now() - make_interval(mins => v_cooldown)
   order by visited_at desc limit 1;

  if found then
    if v_recent.status = 'pending' then
      if p_trusted then
        return confirm_visit(v_recent.id);   -- upgrade the pending visit, don't create another
      end if;
      return jsonb_build_object('status', 'pending', 'visit_id', v_recent.id);
    end if;
    return jsonb_build_object('status', 'cooldown', 'visit_id', v_recent.id,
      'next_eligible_at', v_recent.visited_at + make_interval(mins => v_cooldown));
  end if;

  select location_id into v_location from tags where id = p_tag_id;

  insert into visits (restaurant_id, location_id, customer_id, tap_event_id, source, status)
  values (p_restaurant_id, v_location, p_customer_id, p_tap_event_id, 'tap', 'pending')
  returning id into v_visit_id;

  if p_trusted then
    return confirm_visit(v_visit_id);
  end if;
  return jsonb_build_object('status', 'pending', 'visit_id', v_visit_id);
end $$;

-- ---------------------------------------------------------------------------
-- Spend points on a catalogue reward.
-- ---------------------------------------------------------------------------
create or replace function claim_reward(p_customer_id uuid, p_template_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tpl     reward_templates%rowtype;
  v_member  memberships%rowtype;
  v_reward  rewards%rowtype;
  v_balance int;
begin
  select * into v_tpl from reward_templates where id = p_template_id and is_active;
  if not found or v_tpl.points_cost is null then
    raise exception 'reward_not_claimable' using errcode = 'P0001';
  end if;

  select * into v_member from memberships
   where restaurant_id = v_tpl.restaurant_id and customer_id = p_customer_id
   for update;
  if not found then
    raise exception 'not_a_member' using errcode = 'P0001';
  end if;
  if v_member.tier < v_tpl.min_tier then
    raise exception 'tier_too_low' using errcode = 'P0001';
  end if;
  if v_member.points_balance < v_tpl.points_cost then
    raise exception 'insufficient_points' using errcode = 'P0001';
  end if;

  insert into rewards (restaurant_id, membership_id, template_id, origin, title, expires_at)
  values (v_tpl.restaurant_id, v_member.id, v_tpl.id, 'manual', v_tpl.name,
          now() + make_interval(days => v_tpl.valid_days))
  returning * into v_reward;

  v_balance := award_points(v_member.id, -v_tpl.points_cost, 'redemption', 'reward', v_reward.id,
                            'claim:' || v_reward.id);

  return jsonb_build_object('reward_id', v_reward.id, 'redeem_code', v_reward.redeem_code,
                            'title', v_reward.title, 'expires_at', v_reward.expires_at,
                            'points_balance', v_balance);
end $$;

-- ---------------------------------------------------------------------------
-- Staff redeem a reward by its code.
-- ---------------------------------------------------------------------------
create or replace function redeem_reward(p_staff_user_id uuid, p_restaurant_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_reward rewards%rowtype;
begin
  if not exists (select 1 from staff_members where restaurant_id = p_restaurant_id and user_id = p_staff_user_id) then
    raise exception 'not_staff' using errcode = '42501';
  end if;

  select * into v_reward from rewards
   where redeem_code = upper(trim(p_code)) and restaurant_id = p_restaurant_id
   for update;
  if not found then
    raise exception 'reward_not_found' using errcode = 'P0002';
  end if;
  if v_reward.status <> 'active' then
    raise exception 'reward_%', v_reward.status using errcode = 'P0001';
  end if;
  if v_reward.expires_at < now() then
    update rewards set status = 'expired' where id = v_reward.id;
    raise exception 'reward_expired' using errcode = 'P0001';
  end if;

  update rewards set status = 'redeemed', redeemed_at = now(), redeemed_by = p_staff_user_id
   where id = v_reward.id;

  return jsonb_build_object('reward_id', v_reward.id, 'title', v_reward.title, 'status', 'redeemed');
end $$;

revoke execute on function confirm_visit(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function check_in(uuid, uuid, uuid, boolean, bigint) from public, anon, authenticated;
revoke execute on function claim_reward(uuid, uuid) from public, anon, authenticated;
revoke execute on function redeem_reward(uuid, uuid, text) from public, anon, authenticated;
