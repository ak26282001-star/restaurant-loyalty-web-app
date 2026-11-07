-- =============================================================================
-- Phase 3: intelligence. Clover POS connection, order → visit matching,
-- "try these items" challenges, customer features, and AI recommendation issuing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- POS connections. Tokens live in a separate table that only the service role
-- can read, so no dashboard query can ever return them.
-- ---------------------------------------------------------------------------
create table pos_connections (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id) on delete cascade,
  location_id      uuid references locations(id) on delete set null,
  provider         text not null check (provider in ('clover')),
  environment      text not null check (environment in ('sandbox', 'na', 'eu', 'la')),
  merchant_id      text not null,
  status           text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  connected_by     uuid references auth.users(id),
  connected_at     timestamptz not null default now(),
  last_webhook_at  timestamptz,
  last_order_at    timestamptz,
  menu_synced_at   timestamptz,
  last_error       text,
  unique (provider, merchant_id)
);
create index on pos_connections (restaurant_id);

create table pos_credentials (
  connection_id            uuid primary key references pos_connections(id) on delete cascade,
  access_token             text not null,
  access_token_expires_at  timestamptz,
  refresh_token            text,
  refresh_token_expires_at timestamptz,
  updated_at               timestamptz not null default now()
);

-- Every webhook update we receive, for idempotency and troubleshooting.
create table pos_webhook_log (
  id            bigint generated always as identity primary key,
  provider      text not null,
  restaurant_id uuid references restaurants(id) on delete cascade,
  merchant_id   text not null,
  object_id     text not null,           -- e.g. "O:GHIVJT2ABCRSC"
  event_type    text not null,           -- CREATE | UPDATE | DELETE
  event_ts      bigint not null,         -- Clover's ts, Unix ms
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  detail        text,
  received_at   timestamptz not null default now(),
  unique (provider, merchant_id, object_id, event_type, event_ts)
);
create index on pos_webhook_log (restaurant_id, received_at desc);

-- Clover sends a one-time verification code when the webhook URL is set up in its dashboard.
create table pos_webhook_verifications (
  id          bigint generated always as identity primary key,
  provider    text not null,
  code        text not null,
  received_at timestamptz not null default now()
);

alter table pos_connections           enable row level security;
alter table pos_credentials           enable row level security;
alter table pos_webhook_log           enable row level security;
alter table pos_webhook_verifications enable row level security;
create policy "pos manager read" on pos_connections for select using (is_staff(restaurant_id, 'manager'));
create policy "pos log manager read" on pos_webhook_log for select using (is_staff(restaurant_id, 'manager'));
-- pos_credentials and pos_webhook_verifications: no policies, and no grants to API roles.
revoke all on pos_credentials, pos_webhook_verifications from anon, authenticated;

alter table orders add column if not exists pos_provider text;
alter table ai_recommendations add column if not exists reward_id uuid references rewards(id);

-- ---------------------------------------------------------------------------
-- Phone numbers: Supabase Auth stores E.164 digits without "+", e.g. 447700900001.
-- POS systems store free text. Normalise to the same digits; never match on a
-- partial number, which could credit the wrong person.
-- ---------------------------------------------------------------------------
create or replace function normalize_phone(p_raw text, p_default_cc text)
returns text language plpgsql immutable as $$
declare
  d text := regexp_replace(coalesce(p_raw, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if btrim(p_raw) like '+%' then return d; end if;            -- already international
  if d like '00%' then return substr(d, 3); end if;          -- 00 international prefix
  if p_default_cc is null or p_default_cc = '' then return d; end if;
  if d like p_default_cc || '%' and length(d) > 10 then return d; end if;  -- country code without "+"
  return p_default_cc || ltrim(d, '0');                       -- national number, drop trunk 0
end $$;

-- ---------------------------------------------------------------------------
-- "Try these items" challenges now that orders carry line items.
-- (Same function as 0003 plus the try_items branch.)
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

    when 'try_items' then
      v_target := coalesce((r->>'need')::int, jsonb_array_length(r->'menu_item_ids'));
      select count(distinct oi.menu_item_id) into v_value
        from order_items oi join orders o on o.id = oi.order_id
       where o.customer_id = p_member.customer_id and o.restaurant_id = p_member.restaurant_id
         and o.ordered_at >= v_from and o.ordered_at < v_until
         and oi.menu_item_id::text in (select jsonb_array_elements_text(r->'menu_item_ids'));

    else
      return null;
  end case;

  return jsonb_build_object('value', v_value, 'target', v_target);
end $$;

-- ---------------------------------------------------------------------------
-- Record a paid POS order and credit the member it belongs to.
--   • Idempotent on (restaurant, POS order id).
--   • Matches the customer by phone (normalised) or email.
--   • A pending tap within 30 minutes of the order is confirmed with the real bill;
--     an already-confirmed visit in the same sitting gets the spend added;
--     otherwise the order itself becomes a confirmed visit.
-- p_items: [{"pos_item_id": "...", "name": "...", "price_cents": 450, "quantity": 1}]
-- ---------------------------------------------------------------------------
create or replace function record_pos_order(
  p_restaurant_id uuid, p_location_id uuid, p_provider text, p_pos_order_id text,
  p_total_cents int, p_ordered_at timestamptz, p_phones text[], p_emails text[], p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_settings  jsonb;
  v_cc        text;
  v_customer  uuid;
  v_order_id  uuid;
  v_member    memberships%rowtype;
  v_visit     visits%rowtype;
  v_item      jsonb;
  v_menu_id   uuid;
  v_cooldown  int;
  v_spend_pts int;
  v_res       jsonb;
  v_status    text;
begin
  select id into v_order_id from orders where restaurant_id = p_restaurant_id and pos_order_id = p_pos_order_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'order_id', v_order_id);
  end if;

  select settings into v_settings from restaurants where id = p_restaurant_id;
  v_cc := nullif(v_settings->>'country_calling_code', '');

  select c.id into v_customer from customers c
   where c.phone is not null
     and c.phone = any (select normalize_phone(x, v_cc) from unnest(coalesce(p_phones, '{}')) x)
   limit 1;
  if v_customer is null then
    select c.id into v_customer from customers c
     where c.email is not null and lower(c.email) = any (select lower(x) from unnest(coalesce(p_emails, '{}')) x)
     limit 1;
  end if;

  insert into orders (restaurant_id, customer_id, pos_order_id, pos_provider, total_cents, ordered_at)
  values (p_restaurant_id, v_customer, p_pos_order_id, p_provider, p_total_cents, p_ordered_at)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_menu_id := null;
    if nullif(v_item->>'pos_item_id', '') is not null then
      insert into menu_items (restaurant_id, pos_item_id, name, price_cents)
      values (p_restaurant_id, v_item->>'pos_item_id', coalesce(v_item->>'name', 'Item'), (v_item->>'price_cents')::int)
      on conflict (restaurant_id, pos_item_id) do update set name = excluded.name
      returning id into v_menu_id;
    end if;
    insert into order_items (order_id, menu_item_id, quantity, unit_price_cents)
    values (v_order_id, v_menu_id, greatest(coalesce((v_item->>'quantity')::int, 1), 1), coalesce((v_item->>'price_cents')::int, 0));
  end loop;

  if v_customer is null then
    return jsonb_build_object('status', 'unmatched', 'order_id', v_order_id);
  end if;

  -- The customer gave their number at this restaurant's till, so they join its programme.
  insert into memberships (restaurant_id, customer_id) values (p_restaurant_id, v_customer)
  on conflict (restaurant_id, customer_id) do nothing;
  select * into v_member from memberships
   where restaurant_id = p_restaurant_id and customer_id = v_customer for update;

  v_cooldown := coalesce((v_settings->>'visit_cooldown_minutes')::int, 240);

  -- 1. A tap waiting for confirmation around the time of the order.
  select * into v_visit from visits
   where restaurant_id = p_restaurant_id and customer_id = v_customer and status = 'pending'
     and visited_at between p_ordered_at - interval '30 minutes' and p_ordered_at + interval '30 minutes'
   order by abs(extract(epoch from visited_at - p_ordered_at)) limit 1;

  if found then
    update orders set visit_id = v_visit.id where id = v_order_id;
    v_res := confirm_visit(v_visit.id, null, p_total_cents);
    v_status := 'confirmed_pending_visit';
  else
    -- 2. Already confirmed visit in the same sitting (e.g. geofenced tap, or a second bill).
    select * into v_visit from visits
     where restaurant_id = p_restaurant_id and customer_id = v_customer and status = 'confirmed'
       and visited_at between p_ordered_at - make_interval(mins => v_cooldown) and p_ordered_at + interval '30 minutes'
     order by visited_at desc limit 1;

    if found then
      update orders set visit_id = v_visit.id where id = v_order_id;
      update visits set spend_cents = coalesce(spend_cents, 0) + p_total_cents where id = v_visit.id;
      v_spend_pts := floor(p_total_cents / 100.0 * coalesce((v_settings->>'points_per_currency_unit')::numeric, 1))::int;
      if v_spend_pts > 0 then
        perform award_points(v_member.id, v_spend_pts, 'spend', 'order', v_order_id, 'order:' || v_order_id);
      end if;
      v_res := jsonb_build_object('points_awarded', v_spend_pts, 'challenges_completed', evaluate_challenges(v_member.id));
      v_status := 'added_to_visit';
    else
      -- 3. The order is the visit.
      insert into visits (restaurant_id, location_id, customer_id, source, status, visited_at)
      values (p_restaurant_id, p_location_id, v_customer, 'pos', 'pending', p_ordered_at)
      returning * into v_visit;
      update orders set visit_id = v_visit.id where id = v_order_id;
      v_res := confirm_visit(v_visit.id, null, p_total_cents);
      v_status := 'new_visit';
    end if;
  end if;

  return v_res || jsonb_build_object('status', v_status, 'order_id', v_order_id, 'visit_id', v_visit.id,
                                     'membership_id', v_member.id,
                                     'points_balance', (select points_balance from memberships where id = v_member.id));
end $$;

-- ---------------------------------------------------------------------------
-- Customer features, recomputed nightly. Deterministic and explainable:
--   overdue_ratio = days since last visit / the guest's usual gap between visits
--   churn_risk    = sigmoid(1.6·(overdue − 1.5) + 0.4·[no visit in 90d] − 0.3·ln(1 + visits))
-- ---------------------------------------------------------------------------
create or replace function recompute_customer_features(p_restaurant_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tz  text;
  v_n   int;
begin
  select timezone into v_tz from restaurants where id = p_restaurant_id;

  with v as (
    select m.id as membership_id, vi.visited_at, vi.spend_cents
      from memberships m
      join visits vi on vi.customer_id = m.customer_id and vi.restaurant_id = m.restaurant_id
     where m.restaurant_id = p_restaurant_id and vi.status = 'confirmed'
       and vi.visited_at > now() - interval '365 days'
  ),
  gaps as (
    select membership_id,
           extract(epoch from visited_at - lag(visited_at) over (partition by membership_id order by visited_at)) / 86400 as gap
      from v
  ),
  g as (
    select membership_id, avg(gap) as avg_gap, stddev_samp(gap) as sd, count(*) as n
      from gaps where gap is not null group by membership_id
  ),
  med as (select percentile_cont(0.5) within group (order by avg_gap) as median_gap from g where n >= 2),
  fav as (
    select membership_id, jsonb_agg(jsonb_build_object('menu_item_id', menu_item_id, 'name', name, 'share', round(share::numeric, 2))
                                   order by cnt desc) as items
      from (
        select m.id as membership_id, oi.menu_item_id, mi.name, sum(oi.quantity) as cnt,
               sum(oi.quantity)::float / sum(sum(oi.quantity)) over (partition by m.id) as share,
               row_number() over (partition by m.id order by sum(oi.quantity) desc, mi.name) as rk
          from memberships m
          join orders o on o.customer_id = m.customer_id and o.restaurant_id = m.restaurant_id
          join order_items oi on oi.order_id = o.id
          join menu_items mi on mi.id = oi.menu_item_id
         where m.restaurant_id = p_restaurant_id and o.ordered_at > now() - interval '180 days'
         group by m.id, oi.menu_item_id, mi.name
      ) t where rk <= 3
     group by membership_id
  ),
  dp as (
    select distinct on (membership_id) membership_id, daypart_of(visited_at, v_tz) as daypart
      from v group by membership_id, daypart_of(visited_at, v_tz)
     order by membership_id, count(*) desc
  ),
  wd as (
    select membership_id, array_agg(dow order by c desc) filter (where rk <= 2) as days
      from (select membership_id, extract(dow from visited_at at time zone v_tz)::int as dow, count(*) as c,
                   row_number() over (partition by membership_id order by count(*) desc) as rk
              from v group by 1, 2) t
     group by membership_id
  ),
  resp as (
    select membership_id,
           count(*) filter (where status = 'redeemed')::numeric / nullif(count(*), 0) as rate
      from rewards where restaurant_id = p_restaurant_id and issued_at > now() - interval '180 days'
     group by membership_id
  ),
  base as (
    select m.id, m.visit_count, m.tier, m.last_visit_at,
           extract(epoch from now() - m.last_visit_at) / 86400 as recency,
           (select count(*) from v where v.membership_id = m.id and v.visited_at > now() - interval '90 days') as f90,
           (select coalesce(sum(spend_cents), 0) from v where v.membership_id = m.id and v.visited_at > now() - interval '90 days') as mon90,
           g.avg_gap, g.sd, g.n,
           case when g.n >= 2 then g.avg_gap else coalesce((select median_gap from med), 14) end as expected_gap
      from memberships m left join g on g.membership_id = m.id
     where m.restaurant_id = p_restaurant_id
  ),
  scored as (
    select b.*,
           case when b.last_visit_at is null then null else b.recency / greatest(b.expected_gap, 1) end as overdue
      from base b
  )
  insert into customer_features as cf (membership_id, restaurant_id, recency_days, frequency_90d, monetary_90d_cents,
    avg_gap_days, gap_stddev_days, overdue_ratio, churn_risk, segment, favourite_items, preferred_daypart,
    preferred_weekdays, reward_response_rate, computed_at)
  select s.id, p_restaurant_id,
         floor(s.recency)::int, s.f90, s.mon90,
         round(s.avg_gap::numeric, 2), round(s.sd::numeric, 2), round(s.overdue::numeric, 2),
         case when s.overdue is null then null else round((1 / (1 + exp(-(
           1.6 * (s.overdue - 1.5) + 0.4 * (s.f90 = 0)::int - 0.3 * ln(1 + s.visit_count)))))::numeric, 3) end,
         case
           when s.last_visit_at is null then 'new'
           when s.visit_count <= 2 and s.recency <= 30 then 'new'
           when s.overdue >= 3 or s.recency > 90 then 'lapsed'
           when s.overdue >= 1.5 then 'at_risk'
           when s.tier in ('vip', 'legend') then 'vip'
           else 'regular'
         end,
         coalesce(fav.items, '[]'::jsonb), dp.daypart, wd.days, round(resp.rate, 3), now()
    from scored s
    left join fav on fav.membership_id = s.id
    left join dp on dp.membership_id = s.id
    left join wd on wd.membership_id = s.id
    left join resp on resp.membership_id = s.id
  on conflict (membership_id) do update set
    recency_days = excluded.recency_days, frequency_90d = excluded.frequency_90d,
    monetary_90d_cents = excluded.monetary_90d_cents, avg_gap_days = excluded.avg_gap_days,
    gap_stddev_days = excluded.gap_stddev_days, overdue_ratio = excluded.overdue_ratio,
    churn_risk = excluded.churn_risk, segment = excluded.segment, favourite_items = excluded.favourite_items,
    preferred_daypart = excluded.preferred_daypart, preferred_weekdays = excluded.preferred_weekdays,
    reward_response_rate = excluded.reward_response_rate, computed_at = excluded.computed_at;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Issue an approved AI recommendation as a reward in the member's wallet. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function issue_recommendation(p_recommendation_id uuid, p_decided_by uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_rec    ai_recommendations%rowtype;
  v_tpl    reward_templates%rowtype;
  v_reward uuid;
begin
  select * into v_rec from ai_recommendations where id = p_recommendation_id for update;
  if not found then
    raise exception 'recommendation_not_found' using errcode = 'P0002';
  end if;
  if v_rec.status = 'issued' then
    return jsonb_build_object('status', 'issued', 'reward_id', v_rec.reward_id, 'already_issued', true);
  end if;
  if v_rec.status <> 'proposed' and v_rec.status <> 'approved' then
    raise exception 'recommendation_%', v_rec.status using errcode = 'P0001';
  end if;

  select * into v_tpl from reward_templates where id = v_rec.template_id and is_active and restaurant_id = v_rec.restaurant_id;
  if not found then
    raise exception 'reward_not_claimable' using errcode = 'P0001';
  end if;

  insert into rewards (restaurant_id, membership_id, template_id, origin, title, message, recommendation_id, expires_at)
  values (v_rec.restaurant_id, v_rec.membership_id, v_tpl.id, v_rec.kind, v_rec.title, v_rec.message, v_rec.id,
          now() + make_interval(days => v_tpl.valid_days))
  returning id into v_reward;

  update ai_recommendations
     set status = 'issued', reward_id = v_reward, decided_by = p_decided_by, decided_at = now()
   where id = v_rec.id;

  return jsonb_build_object('status', 'issued', 'reward_id', v_reward);
end $$;

revoke execute on function record_pos_order(uuid, uuid, text, text, int, timestamptz, text[], text[], jsonb) from public, anon, authenticated;
revoke execute on function recompute_customer_features(uuid) from public, anon, authenticated;
revoke execute on function issue_recommendation(uuid, uuid) from public, anon, authenticated;
revoke execute on function challenge_progress_value(challenges, memberships) from public, anon, authenticated;

-- Owner feedback when rejecting an AI offer; recent reasons are fed back into the prompt.
alter table ai_recommendations add column if not exists owner_feedback text;
