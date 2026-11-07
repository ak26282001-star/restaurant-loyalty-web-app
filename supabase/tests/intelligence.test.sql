-- Behaviour tests for 0004_intelligence.sql: POS order matching, try_items challenges,
-- customer features and AI recommendation issuing. Uses its own customers and restaurant settings.

update restaurants
   set settings = settings || '{"country_calling_code": "44", "points_per_visit": 10, "points_per_currency_unit": 1, "streak_bonuses": {}}'
 where id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (id, phone, email) values
  ('eeeeeeee-0000-0000-0000-000000000001', '447700900021', null),
  ('eeeeeeee-0000-0000-0000-000000000002', null, 'grace@example.com'),
  ('eeeeeeee-0000-0000-0000-000000000003', '447700900023', null),
  ('eeeeeeee-0000-0000-0000-000000000004', '447700900024', null);

-- ---------- normalize_phone ----------
do $$ begin
  assert normalize_phone('+44 7700 900021', '44') = '447700900021', 'international with +';
  assert normalize_phone('07700 900021', '44') = '447700900021', 'national with trunk 0';
  assert normalize_phone('7700900021', '44') = '447700900021', 'national without trunk 0';
  assert normalize_phone('0044 7700 900021', '44') = '447700900021', '00 prefix';
  assert normalize_phone('447700900021', '44') = '447700900021', 'country code without +';
  assert normalize_phone('(415) 555-1234', '1') = '14155551234', 'US national';
  assert normalize_phone('+1 415 555 1234', '44') = '14155551234', 'foreign number keeps its own code';
  assert normalize_phone('', '44') is null and normalize_phone(null, '44') is null, 'empty';
end $$;

-- ---------- record_pos_order ----------
do $$
declare
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  a   constant uuid := 'eeeeeeee-0000-0000-0000-000000000001';
  res jsonb;
  t   timestamptz := now() - interval '20 days';
  items constant jsonb := '[{"pos_item_id": "CLV-FLAT", "name": "Flat white", "price_cents": 350, "quantity": 1},
                            {"pos_item_id": "CLV-CAKE", "name": "Carrot cake", "price_cents": 450, "quantity": 2}]';
  vcount int;
begin
  -- Unknown phone: the order is kept (for menu stats) but nobody is credited.
  res := record_pos_order(r, null, 'clover', 'ORD-UNKNOWN', 1250, t, array['+44 7700 900999'], null, items);
  assert res->>'status' = 'unmatched', 'unknown customer: ' || res::text;
  assert (select count(*) from menu_items where restaurant_id = r and pos_item_id in ('CLV-FLAT', 'CLV-CAKE')) = 2, 'menu items created from the order';

  -- National-format number on the receipt matches the signed-up customer; the order becomes a visit.
  res := record_pos_order(r, null, 'clover', 'ORD-1', 2350, t, array['07700 900021'], null, items);
  assert res->>'status' = 'new_visit', 'order becomes a visit: ' || res::text;
  assert (res->>'points_awarded')::int = 10 + 23, 'visit points + spend points: ' || res::text;
  assert (select source from visits where id = (res->>'visit_id')::uuid) = 'pos', 'visit source is pos';
  assert exists (select 1 from memberships where customer_id = a and restaurant_id = r), 'membership created';

  -- Webhooks retry: the same order never pays twice.
  res := record_pos_order(r, null, 'clover', 'ORD-1', 2350, t, array['07700 900021'], null, items);
  assert res->>'status' = 'duplicate', 'duplicate ignored: ' || res::text;
  assert (select points_balance from memberships where customer_id = a) = 33, 'balance unchanged by duplicate';

  -- A pending tap 10 minutes before the order is confirmed with the real bill.
  insert into visits (restaurant_id, customer_id, source, status, visited_at)
  values (r, a, 'tap', 'pending', now() - interval '10 minutes');
  res := record_pos_order(r, null, 'clover', 'ORD-2', 1800, now(), array['+447700900021'], null,
                          '[{"pos_item_id": "CLV-SOUP", "name": "Soup", "price_cents": 1800, "quantity": 1}]');
  assert res->>'status' = 'confirmed_pending_visit', 'pending tap confirmed: ' || res::text;
  assert (select spend_cents from visits where id = (res->>'visit_id')::uuid) = 1800, 'bill recorded on the visit';
  select count(*) into vcount from visits where customer_id = a and status = 'confirmed';
  assert vcount = 2, 'no extra visit created: ' || vcount;

  -- A second bill in the same sitting adds spend points to the same visit.
  res := record_pos_order(r, null, 'clover', 'ORD-3', 500, now() + interval '5 minutes', array['447700900021'], null, '[]');
  assert res->>'status' = 'added_to_visit' and (res->>'points_awarded')::int = 5, 'second bill adds spend: ' || res::text;
  assert (select count(*) from visits where customer_id = a and status = 'confirmed') = 2, 'still two visits';
  assert exists (select 1 from points_ledger where reason = 'spend' and delta = 5), 'spend ledger row';

  -- Email on the order matches when there is no phone.
  res := record_pos_order(r, null, 'clover', 'ORD-4', 1000, now(), null, array['Grace@Example.com'], '[]');
  assert res->>'status' = 'new_visit', 'email match (case-insensitive): ' || res::text;
end $$;

-- ---------- try_items challenge ----------
do $$
declare
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  c   constant uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  flat uuid := (select id from menu_items where restaurant_id = r and pos_item_id = 'CLV-FLAT');
  soup uuid := (select id from menu_items where restaurant_id = r and pos_item_id = 'CLV-SOUP');
  ch  uuid;
  res jsonb;
begin
  insert into challenges (restaurant_id, title, kind, rule, bonus_points, starts_at)
  values (r, 'Try the classics', 'try_items', jsonb_build_object('menu_item_ids', jsonb_build_array(flat, soup)), 30, now() - interval '1 day')
  returning id into ch;

  res := record_pos_order(r, null, 'clover', 'ORD-C1', 350, now() - interval '6 hours', array['+447700900023'], null,
                          '[{"pos_item_id": "CLV-FLAT", "name": "Flat white", "price_cents": 350, "quantity": 1}]');
  assert (select progress from challenge_progress where challenge_id = ch) = '{"value": 1, "target": 2}', 'tried 1 of 2';

  res := record_pos_order(r, null, 'clover', 'ORD-C2', 1800, now(), array['+447700900023'], null,
                          '[{"pos_item_id": "CLV-SOUP", "name": "Soup", "price_cents": 1800, "quantity": 1}]');
  assert exists (select 1 from jsonb_array_elements(res->'challenges_completed') e where (e->>'challenge_id')::uuid = ch),
         'try_items completed on the second dish: ' || res::text;
end $$;

-- ---------- customer features ----------
do $$
declare
  r  constant uuid := '11111111-1111-1111-1111-111111111111';
  d  constant uuid := 'eeeeeeee-0000-0000-0000-000000000004';
  ma uuid := (select id from memberships where customer_id = 'eeeeeeee-0000-0000-0000-000000000001');
  md uuid;
  n  int;
  f  customer_features%rowtype;
  v  int;
begin
  -- Member D came every ~7 days, last time 40 days ago: well overdue → lapsed.
  insert into memberships (restaurant_id, customer_id) values (r, d) returning id into md;
  foreach v in array array[61, 54, 47, 40] loop
    perform record_pos_order(r, null, 'clover', 'ORD-D' || v, 1500, now() - make_interval(days => v), array['+447700900024'], null,
                             '[{"pos_item_id": "CLV-CAKE", "name": "Carrot cake", "price_cents": 450, "quantity": 1}]');
  end loop;

  n := recompute_customer_features(r);
  assert n >= 3, 'features computed for every member: ' || n;

  select * into f from customer_features where membership_id = md;
  assert f.segment = 'lapsed', 'D is lapsed: ' || f.segment;
  assert f.avg_gap_days = 7 and f.recency_days = 40, 'D gap 7 days, recency 40: ' || f.avg_gap_days || ' / ' || f.recency_days;
  assert f.churn_risk > 0.9, 'D churn risk high: ' || f.churn_risk;
  assert f.favourite_items->0->>'name' = 'Carrot cake', 'favourite item: ' || f.favourite_items::text;

  select * into f from customer_features where membership_id = ma;
  assert f.segment = 'new' and f.recency_days = 0, 'A visited today with 2 visits → new: ' || f.segment;
  assert f.favourite_items->0->>'name' = 'Carrot cake', 'A orders 2 cakes per first order: ' || f.favourite_items::text;
  assert f.preferred_daypart is not null, 'daypart computed';
end $$;

-- ---------- issue_recommendation ----------
do $$
declare
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  md  uuid := (select id from memberships where customer_id = 'eeeeeeee-0000-0000-0000-000000000004');
  tpl uuid := (select id from reward_templates where restaurant_id = r and name = 'Free coffee');
  rec uuid;
  res jsonb;
  ok  boolean;
begin
  insert into ai_recommendations (restaurant_id, membership_id, kind, template_id, title, message, rationale, confidence)
  values (r, md, 'winback', tpl, 'We miss you', 'Your carrot cake misses you too. Coffee is on us this week.', 'Lapsed regular', 0.8)
  returning id into rec;

  res := issue_recommendation(rec);
  assert res->>'status' = 'issued', 'issued: ' || res::text;
  assert exists (select 1 from rewards where id = (res->>'reward_id')::uuid and origin = 'winback'
                 and membership_id = md and message like 'Your carrot cake%'), 'reward in wallet with AI copy';
  res := issue_recommendation(rec);
  assert (res->>'already_issued')::boolean, 'idempotent';
  assert (select count(*) from rewards where recommendation_id = rec) = 1, 'one reward only';

  insert into ai_recommendations (restaurant_id, membership_id, kind, template_id, title, message, rationale, status)
  values (r, md, 'surprise', tpl, 't', 'm', 'r', 'rejected') returning id into rec;
  begin
    perform issue_recommendation(rec);
    ok := false;
  exception when others then
    ok := sqlerrm = 'recommendation_rejected';
  end;
  assert ok, 'rejected recommendations cannot be issued';
end $$;

-- ---------- credentials are never readable through the API ----------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000001", "role": "authenticated"}';
do $$
declare ok boolean;
begin
  begin
    perform 1 from pos_credentials;
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'pos_credentials not readable by API roles';
  assert (select count(*) from pos_connections) = 0, 'customers see no POS connections';
end $$;
commit;

select 'intelligence: all tests passed' as result;
