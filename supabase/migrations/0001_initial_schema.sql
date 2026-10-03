-- =============================================================================
-- Tap-to-open restaurant loyalty: initial schema
-- Target: Supabase Postgres 15+. Multi-tenant (one row in `restaurants` per brand).
-- Customers authenticate via Supabase Auth (phone OTP / magic link) -> auth.users.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type staff_role         as enum ('owner', 'manager', 'staff');
create type tag_kind           as enum ('nfc', 'nfc_sun', 'qr');
create type visit_source       as enum ('tap', 'pos', 'staff', 'receipt_qr');
create type visit_status       as enum ('pending', 'confirmed', 'rejected');
create type reward_kind        as enum ('free_item', 'percent_off', 'amount_off', 'points_multiplier', 'experience');
create type reward_status      as enum ('active', 'redeemed', 'expired', 'revoked');
create type reward_origin      as enum ('tier', 'streak', 'challenge', 'surprise', 'winback', 'vip', 'manual');
create type challenge_kind     as enum ('visit_count', 'try_items', 'spend_amount', 'time_window', 'streak');
create type progress_status    as enum ('active', 'completed', 'expired');
create type campaign_kind      as enum ('winback', 'surprise', 'vip', 'birthday', 'broadcast');
create type campaign_status    as enum ('draft', 'scheduled', 'running', 'paused', 'finished');
create type channel            as enum ('sms', 'email', 'push', 'in_app');
create type ledger_reason      as enum ('visit', 'spend', 'challenge', 'streak_bonus', 'redemption', 'adjustment', 'expiry');
create type tier_level         as enum ('member', 'regular', 'vip', 'legend');
create type rec_status         as enum ('proposed', 'approved', 'issued', 'rejected', 'expired');

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table restaurants (
  id              uuid primary key default gen_random_uuid(),
  slug            citext unique not null,
  name            text not null,
  brand_color     text default '#E4572E',
  logo_url        text,
  timezone        text not null default 'UTC',
  currency        char(3) not null default 'USD',
  -- Loyalty rules owners can tune without code changes.
  settings        jsonb not null default jsonb_build_object(
                    'points_per_visit', 10,
                    'points_per_currency_unit', 1,
                    'visit_cooldown_minutes', 240,
                    'streak_window_days', 14,
                    'tiers', jsonb_build_object('regular', 5, 'vip', 15, 'legend', 40),
                    'ai', jsonb_build_object(
                      'enabled', true,
                      'auto_issue', false,          -- owner approves AI offers by default
                      'max_discount_percent', 25,
                      'max_offers_per_customer_per_week', 2,
                      'monthly_reward_budget', 500
                    )
                  ),
  created_at      timestamptz not null default now()
);

create table locations (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  name            text not null,
  address         text,
  lat             double precision,
  lng             double precision,
  geofence_m      int not null default 150,
  pos_provider    text,                 -- 'square' | 'toast' | 'clover' | null
  pos_location_id text,
  created_at      timestamptz not null default now()
);
create index on locations (restaurant_id);

create table staff_members (
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            staff_role not null default 'staff',
  location_id     uuid references locations(id) on delete set null,
  pin_hash        text,                 -- 4-6 digit PIN for in-store visit confirmation
  created_at      timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
-- Global identity, 1:1 with auth.users. A person can belong to many restaurants.
create table customers (
  id              uuid primary key references auth.users(id) on delete cascade,
  phone           text unique,
  email           citext unique,
  first_name      text,
  birthday        date,
  locale          text default 'en',
  created_at      timestamptz not null default now()
);

-- Per-restaurant loyalty membership: balances, tier, streak, consent.
create table memberships (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references restaurants(id) on delete cascade,
  customer_id         uuid not null references customers(id) on delete cascade,
  points_balance      int not null default 0 check (points_balance >= 0),
  lifetime_points     int not null default 0,
  tier                tier_level not null default 'member',
  visit_count         int not null default 0,
  current_streak      int not null default 0,
  longest_streak      int not null default 0,
  last_visit_at       timestamptz,
  marketing_opt_in    boolean not null default false,
  preferred_channel   channel not null default 'sms',
  joined_via_tag_id   uuid,
  created_at          timestamptz not null default now(),
  unique (restaurant_id, customer_id)
);
create index on memberships (restaurant_id, last_visit_at);
create index on memberships (customer_id);

-- ---------------------------------------------------------------------------
-- NFC / QR tags and taps
-- ---------------------------------------------------------------------------
create table tags (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  location_id     uuid references locations(id) on delete set null,
  code            text unique not null,          -- opaque short code in the URL: /t/{code}
  kind            tag_kind not null default 'qr',
  label           text,                          -- "Table 12", "Counter", "Receipt"
  -- NTAG 424 DNA (SUN) secure tags: per-tag AES key (encrypted at rest) + replay counter.
  sun_key_enc     bytea,
  last_sun_ctr    int,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on tags (restaurant_id);

create table tap_events (
  id              bigint generated always as identity primary key,
  tag_id          uuid not null references tags(id) on delete cascade,
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  customer_id     uuid references customers(id) on delete set null,  -- null until identified
  device_id       text,                          -- first-party cookie id
  sun_verified    boolean,
  ip_hash         text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index on tap_events (restaurant_id, created_at desc);
create index on tap_events (customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Menu, visits, orders
-- ---------------------------------------------------------------------------
create table menu_items (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  pos_item_id     text,
  name            text not null,
  category        text,
  price_cents     int,
  tags            text[] default '{}',           -- 'vegan', 'spicy', 'dessert', ...
  is_active       boolean not null default true,
  unique (restaurant_id, pos_item_id)
);

create table visits (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  location_id     uuid references locations(id) on delete set null,
  customer_id     uuid not null references customers(id) on delete cascade,
  tap_event_id    bigint references tap_events(id) on delete set null,
  source          visit_source not null,
  status          visit_status not null default 'pending',
  confirmed_by    uuid references auth.users(id),
  spend_cents     int,
  party_size      int,
  visited_at      timestamptz not null default now()
);
create index on visits (restaurant_id, customer_id, visited_at desc);
create index on visits (restaurant_id, visited_at desc);

create table orders (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  visit_id        uuid references visits(id) on delete set null,
  customer_id     uuid references customers(id) on delete set null,
  pos_order_id    text,
  total_cents     int not null,
  ordered_at      timestamptz not null default now(),
  unique (restaurant_id, pos_order_id)
);
create index on orders (customer_id, ordered_at desc);

create table order_items (
  id              bigint generated always as identity primary key,
  order_id        uuid not null references orders(id) on delete cascade,
  menu_item_id    uuid references menu_items(id) on delete set null,
  quantity        int not null default 1,
  unit_price_cents int not null
);
create index on order_items (order_id);
create index on order_items (menu_item_id);

-- ---------------------------------------------------------------------------
-- Points ledger (append-only source of truth; memberships.points_balance is a cache)
-- ---------------------------------------------------------------------------
create table points_ledger (
  id              bigint generated always as identity primary key,
  membership_id   uuid not null references memberships(id) on delete cascade,
  delta           int not null,
  reason          ledger_reason not null,
  ref_type        text,                          -- 'visit' | 'reward' | 'challenge' ...
  ref_id          uuid,
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);
create index on points_ledger (membership_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rewards
-- ---------------------------------------------------------------------------
-- Owner-defined catalogue. The AI may only choose from active templates.
create table reward_templates (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  name            text not null,
  kind            reward_kind not null,
  value           numeric(10,2),                 -- percent, amount, or multiplier
  menu_item_id    uuid references menu_items(id),
  points_cost     int,                           -- null = not purchasable with points
  min_tier        tier_level not null default 'member',
  cost_estimate_cents int not null default 0,    -- for budget guardrails
  valid_days      int not null default 14,
  ai_eligible     boolean not null default true,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Issued reward instances in a customer's wallet.
create table rewards (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  membership_id   uuid not null references memberships(id) on delete cascade,
  template_id     uuid not null references reward_templates(id),
  origin          reward_origin not null,
  title           text not null,                 -- personalised copy shown to the customer
  message         text,
  status          reward_status not null default 'active',
  redeem_code     text unique not null default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  recommendation_id uuid,
  campaign_id     uuid,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  redeemed_at     timestamptz,
  redeemed_by     uuid references auth.users(id)
);
create index on rewards (membership_id, status);
create index on rewards (restaurant_id, issued_at desc);

-- ---------------------------------------------------------------------------
-- Challenges & streaks
-- ---------------------------------------------------------------------------
create table challenges (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  title           text not null,
  description     text,
  kind            challenge_kind not null,
  -- e.g. {"visits":3,"within_days":14} | {"menu_item_ids":[...]} | {"spend_cents":5000}
  rule            jsonb not null,
  reward_template_id uuid references reward_templates(id),
  bonus_points    int not null default 0,
  is_personalised boolean not null default false, -- created for one member by the AI
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  is_active       boolean not null default true
);

create table challenge_progress (
  id              uuid primary key default gen_random_uuid(),
  challenge_id    uuid not null references challenges(id) on delete cascade,
  membership_id   uuid not null references memberships(id) on delete cascade,
  progress        jsonb not null default '{}'::jsonb, -- {"count":2} | {"items_tried":[...]}
  status          progress_status not null default 'active',
  completed_at    timestamptz,
  unique (challenge_id, membership_id)
);

-- ---------------------------------------------------------------------------
-- AI features & recommendations
-- ---------------------------------------------------------------------------
-- One row per membership, recomputed nightly + incrementally after each visit.
create table customer_features (
  membership_id         uuid primary key references memberships(id) on delete cascade,
  restaurant_id         uuid not null references restaurants(id) on delete cascade,
  recency_days          int,
  frequency_90d         int,
  monetary_90d_cents    int,
  avg_gap_days          numeric(8,2),
  gap_stddev_days       numeric(8,2),
  overdue_ratio         numeric(8,2),          -- recency / expected gap
  churn_risk            numeric(4,3),          -- 0..1
  segment               text,                  -- 'new' | 'regular' | 'vip' | 'at_risk' | 'lapsed'
  favourite_items       jsonb default '[]',    -- [{"menu_item_id":..,"name":..,"share":0.4}]
  preferred_daypart     text,                  -- 'breakfast' | 'lunch' | 'dinner' | 'late'
  preferred_weekdays    int[],
  reward_response_rate  numeric(4,3),
  computed_at           timestamptz not null default now()
);
create index on customer_features (restaurant_id, segment);
create index on customer_features (restaurant_id, churn_risk desc);

create table ai_recommendations (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  membership_id   uuid not null references memberships(id) on delete cascade,
  kind            reward_origin not null,
  template_id     uuid references reward_templates(id),
  challenge_id    uuid references challenges(id),
  title           text not null,
  message         text not null,
  rationale       text not null,                -- shown to the owner, never to the customer
  confidence      numeric(4,3),
  send_at         timestamptz,
  channel         channel,
  status          rec_status not null default 'proposed',
  model           text,
  input_snapshot  jsonb,                        -- features used, for audit/debugging
  created_at      timestamptz not null default now(),
  decided_by      uuid references auth.users(id),
  decided_at      timestamptz
);
create index on ai_recommendations (restaurant_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  name            text not null,
  kind            campaign_kind not null,
  status          campaign_status not null default 'draft',
  audience        jsonb not null,                -- {"segment":"lapsed","min_visits":3}
  reward_template_id uuid references reward_templates(id),
  ai_personalise  boolean not null default true,
  channel         channel not null default 'sms',
  schedule_at     timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

create table campaign_deliveries (
  id              bigint generated always as identity primary key,
  campaign_id     uuid references campaigns(id) on delete cascade,
  recommendation_id uuid references ai_recommendations(id) on delete set null,
  membership_id   uuid not null references memberships(id) on delete cascade,
  channel         channel not null,
  provider_msg_id text,
  sent_at         timestamptz,
  opened_at       timestamptz,
  converted_visit_id uuid references visits(id),
  error           text
);
create index on campaign_deliveries (campaign_id);
create index on campaign_deliveries (membership_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Helper functions for RLS
-- ---------------------------------------------------------------------------
create or replace function is_staff(rid uuid, min_role staff_role default 'staff')
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff_members s
    where s.restaurant_id = rid
      and s.user_id = auth.uid()
      and case min_role
            when 'staff'   then true
            when 'manager' then s.role in ('manager', 'owner')
            when 'owner'   then s.role = 'owner'
          end
  );
$$;

create or replace function my_membership_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from memberships where customer_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Atomic points award (called from server routes with the service role)
-- ---------------------------------------------------------------------------
create or replace function award_points(
  p_membership_id uuid, p_delta int, p_reason ledger_reason,
  p_ref_type text, p_ref_id uuid, p_idempotency_key text
) returns int language plpgsql security definer set search_path = public as $$
declare v_balance int;
begin
  insert into points_ledger (membership_id, delta, reason, ref_type, ref_id, idempotency_key)
  values (p_membership_id, p_delta, p_reason, p_ref_type, p_ref_id, p_idempotency_key)
  on conflict (idempotency_key) do nothing;

  if not found then  -- duplicate request: return current balance unchanged
    select points_balance into v_balance from memberships where id = p_membership_id;
    return v_balance;
  end if;

  update memberships
     set points_balance  = points_balance + p_delta,
         lifetime_points = lifetime_points + greatest(p_delta, 0)
   where id = p_membership_id
  returning points_balance into v_balance;
  return v_balance;
end $$;
revoke execute on function award_points from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Customers read their own data; staff read/write their restaurant's data.
-- All writes that move points or issue rewards go through server routes using the
-- service role, so customer-facing policies are read-only.
-- ---------------------------------------------------------------------------
alter table restaurants         enable row level security;
alter table locations           enable row level security;
alter table staff_members       enable row level security;
alter table customers           enable row level security;
alter table memberships         enable row level security;
alter table tags                enable row level security;
alter table tap_events          enable row level security;
alter table menu_items          enable row level security;
alter table visits              enable row level security;
alter table orders              enable row level security;
alter table order_items         enable row level security;
alter table points_ledger       enable row level security;
alter table reward_templates    enable row level security;
alter table rewards             enable row level security;
alter table challenges          enable row level security;
alter table challenge_progress  enable row level security;
alter table customer_features   enable row level security;
alter table ai_recommendations  enable row level security;
alter table campaigns           enable row level security;
alter table campaign_deliveries enable row level security;

-- Public branding (landing page renders before login)
create policy "restaurants public read" on restaurants for select using (true);
create policy "restaurants owner update" on restaurants for update using (is_staff(id, 'owner'));
create policy "menu public read" on menu_items for select using (is_active);
create policy "menu staff write" on menu_items for all using (is_staff(restaurant_id, 'manager'));

create policy "locations staff" on locations for all using (is_staff(restaurant_id, 'manager'));
create policy "staff see team" on staff_members for select using (is_staff(restaurant_id));
create policy "owner manages team" on staff_members for all using (is_staff(restaurant_id, 'owner'));

create policy "customer self" on customers for select using (id = auth.uid());
create policy "customer self update" on customers for update using (id = auth.uid());
create policy "staff read members' customers" on customers for select using (
  exists (select 1 from memberships m where m.customer_id = customers.id and is_staff(m.restaurant_id))
);

create policy "member self read" on memberships for select using (customer_id = auth.uid());
create policy "member self prefs" on memberships for update using (customer_id = auth.uid())
  with check (customer_id = auth.uid());
create policy "staff read memberships" on memberships for select using (is_staff(restaurant_id));

create policy "tags staff" on tags for all using (is_staff(restaurant_id, 'manager'));
create policy "taps staff read" on tap_events for select using (is_staff(restaurant_id));

create policy "visits self read" on visits for select using (customer_id = auth.uid());
create policy "visits staff" on visits for all using (is_staff(restaurant_id));

create policy "orders self read" on orders for select using (customer_id = auth.uid());
create policy "orders staff read" on orders for select using (is_staff(restaurant_id));
create policy "order items read" on order_items for select using (
  exists (select 1 from orders o where o.id = order_id
          and (o.customer_id = auth.uid() or is_staff(o.restaurant_id)))
);

create policy "ledger self read" on points_ledger for select using (membership_id in (select my_membership_ids()));
create policy "ledger staff read" on points_ledger for select using (
  exists (select 1 from memberships m where m.id = membership_id and is_staff(m.restaurant_id))
);

create policy "templates public read" on reward_templates for select using (is_active);
create policy "templates manager write" on reward_templates for all using (is_staff(restaurant_id, 'manager'));

create policy "rewards self read" on rewards for select using (membership_id in (select my_membership_ids()));
create policy "rewards staff" on rewards for all using (is_staff(restaurant_id));

create policy "challenges read" on challenges for select using (is_active and not is_personalised);
create policy "challenges staff" on challenges for all using (is_staff(restaurant_id, 'manager'));
create policy "progress self read" on challenge_progress for select using (membership_id in (select my_membership_ids()));
create policy "personal challenges read" on challenges for select using (
  is_personalised and exists (
    select 1 from challenge_progress p
    where p.challenge_id = challenges.id and p.membership_id in (select my_membership_ids())
  )
);

create policy "features staff read" on customer_features for select using (is_staff(restaurant_id, 'manager'));
create policy "recs staff" on ai_recommendations for all using (is_staff(restaurant_id, 'manager'));
create policy "campaigns staff" on campaigns for all using (is_staff(restaurant_id, 'manager'));
create policy "deliveries staff read" on campaign_deliveries for select using (
  exists (select 1 from campaigns c where c.id = campaign_id and is_staff(c.restaurant_id, 'manager'))
);
