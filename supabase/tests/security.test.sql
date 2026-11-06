-- Access-control tests: run statements as real API users (role + JWT claims) and
-- check that RLS and column grants stop privilege escalation.

insert into auth.users (id, phone) values
  ('dddddddd-0000-0000-0000-000000000001', '+447700900011'),   -- customer A
  ('dddddddd-0000-0000-0000-000000000002', '+447700900012'),   -- customer B
  ('dddddddd-0000-0000-0000-000000000003', '+447700900013');   -- staff (not manager)
insert into memberships (restaurant_id, customer_id, points_balance) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 10),
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000002', 10);
insert into staff_members (restaurant_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000003', 'staff');
insert into visits (restaurant_id, customer_id, source, status)
values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'tap', 'pending');
insert into challenges (restaurant_id, title, kind, rule, bonus_points)
values ('11111111-1111-1111-1111-111111111111', 'Security test challenge', 'visit_count', '{"visits": 2}', 10);

create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
declare n int;
begin
  begin
    execute sql;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'NOT DENIED (% rows): %', n, label; end if;
  exception
    when insufficient_privilege then null;           -- column/table grant refused it
    when others then
      if sqlerrm like 'NOT DENIED%' then raise; end if;
      if sqlerrm not like '%row-level security%' then raise exception '% failed unexpectedly: %', label, sqlerrm; end if;
  end;
end $$;

-- ---------- As customer A ----------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "dddddddd-0000-0000-0000-000000000001", "role": "authenticated"}';

select pg_temp.expect_denied($$update memberships set points_balance = 99999 where customer_id = auth.uid()$$, 'customer raises own points');
select pg_temp.expect_denied($$update memberships set tier = 'legend' where customer_id = auth.uid()$$, 'customer raises own tier');
select pg_temp.expect_denied($$update memberships set marketing_opt_in = true where customer_id = 'dddddddd-0000-0000-0000-000000000002'$$, 'customer edits another member');
select pg_temp.expect_denied($$update customers set phone = '+10000000000' where id = auth.uid()$$, 'customer changes stored phone');
select pg_temp.expect_denied($$insert into points_ledger (membership_id, delta, reason) select id, 500, 'adjustment' from memberships where customer_id = auth.uid()$$, 'customer writes ledger');
select pg_temp.expect_denied($$insert into rewards (restaurant_id, membership_id, template_id, origin, title, expires_at)
  select m.restaurant_id, m.id, (select id from reward_templates limit 1), 'manual', 'free', now() + interval '1 day'
  from memberships m where customer_id = auth.uid()$$, 'customer issues self a reward');
select pg_temp.expect_denied($$update visits set status = 'rejected' where customer_id = auth.uid()$$, 'customer edits own visit');

do $$ begin
  update memberships set marketing_opt_in = true where customer_id = auth.uid();
  assert found, 'customer can change their own marketing preference';
  update customers set first_name = 'Ada' where id = auth.uid();
  assert found, 'customer can set their own first name';
  assert (select count(*) from memberships) = 1, 'customer sees only their own membership';
  assert (select count(*) from customers) = 1, 'customer sees only their own profile';
  -- Policies on challenges and challenge_progress reference each other; this fails with
  -- "infinite recursion detected in policy" if they ever form a cycle again.
  assert (select count(*) from challenges where title = 'Security test challenge') = 1, 'customer can list public challenges';
  assert (select count(*) from challenge_progress) = 0, 'customer sees only their own challenge progress';
end $$;
commit;

-- ---------- As staff (not a manager) ----------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "dddddddd-0000-0000-0000-000000000003", "role": "authenticated"}';

select pg_temp.expect_denied($$update visits set status = 'confirmed' where status = 'pending'$$, 'staff confirms visit without points');
select pg_temp.expect_denied($$insert into visits (restaurant_id, customer_id, source, status)
  values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000002', 'staff', 'confirmed')$$, 'staff inserts confirmed visit');
select pg_temp.expect_denied($$insert into rewards (restaurant_id, membership_id, template_id, origin, title, expires_at)
  select m.restaurant_id, m.id, (select id from reward_templates limit 1), 'manual', 'free', now() + interval '1 day'
  from memberships m limit 1$$, 'staff issues a reward');
select pg_temp.expect_denied($$update memberships set points_balance = 1000$$, 'staff edits balances');

do $$ begin
  assert (select count(*) from visits where status = 'pending') >= 1, 'staff can see pending visits';
  update visits set status = 'rejected', confirmed_by = auth.uid() where status = 'pending';
  assert found, 'staff can reject a pending visit';
end $$;
commit;

do $$ begin
  assert (select points_balance from memberships where customer_id = 'dddddddd-0000-0000-0000-000000000001') = 10,
    'balance unchanged after all attempts';
end $$;

select 'security: all tests passed' as result;
