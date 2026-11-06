-- Behaviour tests for 0002_mvp_functions.sql. Runs after migrations + seed.
-- Every block raises on failure, so `psql -v ON_ERROR_STOP=1` exits non-zero.

-- Fixtures: one customer (via the auth trigger) and one staff user.
insert into auth.users (id, phone) values ('aaaaaaaa-0000-0000-0000-000000000001', '+447700900001');
insert into auth.users (id, email) values ('bbbbbbbb-0000-0000-0000-000000000001', 'staff@example.com');
insert into staff_members (restaurant_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001', 'staff');

do $$
declare
  c   constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  t   uuid := (select id from tags where code = 'DEMO01');
  res jsonb;
  vid uuid;
begin
  assert exists (select 1 from customers where id = c and phone = '+447700900001'), 'auth trigger creates customer';

  -- Untrusted tap -> pending visit, no points yet.
  res := check_in(c, r, t, false);
  assert res->>'status' = 'pending', 'untrusted tap is pending: ' || res;
  vid := (res->>'visit_id')::uuid;
  assert (select points_balance from memberships where customer_id = c) = 0, 'no points while pending';

  -- A second untrusted tap returns the same pending visit.
  res := check_in(c, r, t, false);
  assert (res->>'visit_id')::uuid = vid, 'no duplicate pending visit';

  -- A trusted tap upgrades the pending visit instead of creating another.
  res := check_in(c, r, t, true);
  assert res->>'status' = 'confirmed' and (res->>'visit_id')::uuid = vid, 'trusted tap confirms pending: ' || res;
  assert (res->>'points_awarded')::int = 10 and (res->>'streak')::int = 1, 'points and streak: ' || res;

  -- Confirming again is idempotent.
  res := confirm_visit(vid);
  assert (res->>'already_confirmed')::boolean, 'confirm is idempotent';
  assert (select points_balance from memberships where customer_id = c) = 10, 'balance unchanged on re-confirm';

  -- Within the cooldown, taps are rejected.
  res := check_in(c, r, t, true);
  assert res->>'status' = 'cooldown', 'cooldown enforced: ' || res;
end $$;

-- Simulate 4 more visits, each 3 days apart, to test streak and tier.
do $$
declare
  c   constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  i   int;
  vid uuid;
  res jsonb;
begin
  update visits set visited_at = now() - interval '15 days' where customer_id = c;
  update memberships set last_visit_at = now() - interval '15 days' where customer_id = c;
  for i in 1..4 loop
    insert into visits (restaurant_id, customer_id, source, status, visited_at)
    values (r, c, 'staff', 'pending', now() - make_interval(days => 15 - i * 3))
    returning id into vid;
    res := confirm_visit(vid, 'bbbbbbbb-0000-0000-0000-000000000001', case when i = 4 then 2500 end);
  end loop;
  assert (res->>'streak')::int = 5, 'streak continues within window: ' || res;
  assert res->>'tier' = 'regular' and (res->>'tier_upgraded')::boolean, '5th visit reaches regular: ' || res;
  assert (res->>'points_awarded')::int = 35, 'spend adds points (10 + 25): ' || res;
  assert (res->>'points_balance')::int = 75, 'balance: ' || res;

  -- A gap longer than the streak window resets the streak.
  insert into visits (restaurant_id, customer_id, source, status, visited_at)
  values (r, c, 'staff', 'pending', now() + interval '20 days') returning id into vid;
  res := confirm_visit(vid);
  assert (res->>'streak')::int = 1, 'streak resets after window: ' || res;
  assert (select longest_streak from memberships where customer_id = c) = 5, 'longest streak kept';
end $$;

-- Claim and redeem.
do $$
declare
  c     constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  r     constant uuid := '11111111-1111-1111-1111-111111111111';
  staff constant uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  res   jsonb;
  code  text;
  ok    boolean;
begin
  res := claim_reward(c, (select id from reward_templates where name = 'Free coffee'));
  assert (res->>'points_balance')::int = 35, 'claim debits 50 points: ' || res;
  code := res->>'redeem_code';
  assert exists (select 1 from points_ledger where delta = -50 and reason = 'redemption'), 'ledger debit row';

  begin
    perform claim_reward(c, (select id from reward_templates where name = 'Chef''s table tasting'));
    ok := false;
  exception when others then
    ok := sqlerrm = 'tier_too_low';
  end;
  assert ok, 'VIP-only reward blocked for regular tier';

  begin
    perform claim_reward(c, (select id from reward_templates where name = 'Free dessert'));
    ok := false;
  exception when others then
    ok := sqlerrm = 'insufficient_points';
  end;
  assert ok, 'insufficient points blocked';

  begin
    perform redeem_reward(c, r, code);   -- a customer is not staff
    ok := false;
  exception when others then
    ok := sqlerrm = 'not_staff';
  end;
  assert ok, 'non-staff cannot redeem';

  res := redeem_reward(staff, r, lower(code));
  assert res->>'status' = 'redeemed', 'staff redeem (case-insensitive): ' || res;

  begin
    perform redeem_reward(staff, r, code);
    ok := false;
  exception when others then
    ok := sqlerrm = 'reward_redeemed';
  end;
  assert ok, 'double redeem blocked';
end $$;

select 'mvp_functions: all tests passed' as result;
