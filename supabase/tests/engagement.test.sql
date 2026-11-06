-- Behaviour tests for 0003_engagement.sql: streak bonuses, challenges, reminders.
-- Runs after migrations + seed. Uses its own customer, so test files can run in any order.

-- Use the default streak bonuses (3 → 20, 5 → 50, 10 → 100).
update restaurants set settings = settings - 'streak_bonuses' where id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (id, phone) values ('cccccccc-0000-0000-0000-000000000001', '+447700900003');

do $$
declare
  c   constant uuid := 'cccccccc-0000-0000-0000-000000000001';
  r   constant uuid := '11111111-1111-1111-1111-111111111111';
  t   uuid := (select id from tags where code = 'DEMO01');
  m   uuid;
  vid uuid;
  res jsonb;
  i   int;
  lunch_ch uuid;
begin
  -- A lunchtime-on-Monday challenge, plus a personalised one this member is not enrolled in.
  insert into challenges (restaurant_id, title, kind, rule, bonus_points, starts_at)
  values (r, 'Monday lunch', 'time_window', '{"visits": 1, "weekdays": [1], "daypart": "lunch"}', 15, now() - interval '60 days')
  returning id into lunch_ch;
  insert into challenges (restaurant_id, title, kind, rule, bonus_points, is_personalised, starts_at)
  values (r, 'Just for someone else', 'visit_count', '{"visits": 1}', 999, true, now() - interval '60 days');

  -- Visit 1 via the normal check-in path (trusted tap).
  res := check_in(c, r, t, true);
  m := (select id from memberships where customer_id = c);
  assert (res->>'streak_bonus')::int = 0, 'no bonus on first visit: ' || res::text;
  assert jsonb_array_length(res->'challenges_completed') = 0, 'nothing completed yet: ' || res::text;
  assert (select (progress->>'value')::int from challenge_progress p join challenges ch on ch.id = p.challenge_id
          where p.membership_id = m and ch.title = 'Hat-trick') = 1, 'hat-trick progress 1/3';
  assert not exists (select 1 from challenge_progress p join challenges ch on ch.id = p.challenge_id
                     where p.membership_id = m and ch.is_personalised), 'personalised challenge for others is skipped';

  -- Visits 2 and 3, a few days apart (backdate the earlier ones to stay outside the cooldown).
  for i in 2..3 loop
    update visits set visited_at = visited_at - interval '3 days' where customer_id = c;
    update memberships set last_visit_at = last_visit_at - interval '3 days' where customer_id = c;
    insert into visits (restaurant_id, customer_id, source, status, spend_cents)
    values (r, c, 'staff', 'pending', 2500) returning id into vid;
    res := confirm_visit(vid);
  end loop;

  assert (res->>'streak')::int = 3 and (res->>'streak_bonus')::int = 20, 'streak of 3 earns 20 bonus: ' || res::text;
  assert exists (select 1 from jsonb_array_elements(res->'challenges_completed') e where e->>'title' = 'Hat-trick'),
         'hat-trick completed on 3rd visit: ' || res::text;
  assert exists (select 1 from rewards where membership_id = m and origin = 'challenge' and title = 'Free dessert'),
         'hat-trick issues a free dessert';
  -- £25 + £25 = £50 of the £60 spend challenge.
  assert (select progress from challenge_progress p join challenges ch on ch.id = p.challenge_id
          where p.membership_id = m and ch.title = 'Big night out') = '{"value": 5000, "target": 6000}',
         'spend challenge progress 5000/6000';
  -- Points: 3 visits × 10 + 2 × 25 (spend) + 20 streak bonus = 100
  assert (res->>'points_balance')::int = 100, 'balance includes streak bonus: ' || res::text;

  -- Re-evaluating never pays twice.
  res := evaluate_challenges(m);
  assert jsonb_array_length(res) = 0, 're-evaluation completes nothing new: ' || res::text;
  assert (select count(*) from rewards where membership_id = m and origin = 'challenge') = 1, 'one challenge reward only';

  -- 4th visit with £15 finishes the spend challenge: +100 bonus points.
  update visits set visited_at = visited_at - interval '3 days' where customer_id = c;
  update memberships set last_visit_at = last_visit_at - interval '3 days' where customer_id = c;
  insert into visits (restaurant_id, customer_id, source, status, spend_cents)
  values (r, c, 'staff', 'pending', 1500) returning id into vid;
  res := confirm_visit(vid);
  assert exists (select 1 from jsonb_array_elements(res->'challenges_completed') e
                 where e->>'title' = 'Big night out' and (e->>'bonus_points')::int = 100), 'spend challenge done: ' || res::text;
  assert (res->>'points_balance')::int = 100 + 10 + 15 + 100, 'bonus points credited: ' || res::text;
  assert exists (select 1 from points_ledger where membership_id = m and reason = 'challenge' and delta = 100), 'ledger row';

  -- Monday lunch: a confirmed visit on a Monday at 12:30 London time completes it.
  insert into visits (restaurant_id, customer_id, source, status, visited_at)
  values (r, c, 'staff', 'confirmed', '2026-11-02 12:30:00 Europe/London');
  res := evaluate_challenges(m);
  assert exists (select 1 from jsonb_array_elements(res) e where (e->>'challenge_id')::uuid = lunch_ch), 'monday lunch done: ' || res::text;

  assert daypart_of('2026-11-02 08:00 Europe/London', 'Europe/London') = 'breakfast', 'daypart breakfast';
  assert daypart_of('2026-11-02 19:00 Europe/London', 'Europe/London') = 'dinner', 'daypart dinner';
  assert daypart_of('2026-11-02 23:30 Europe/London', 'Europe/London') = 'late', 'daypart late';
end $$;

-- Streak reminders: only members with a subscription, a streak >= 2, ending within 36h, not yet reminded.
do $$
declare
  c constant uuid := 'cccccccc-0000-0000-0000-000000000001';
  r constant uuid := '11111111-1111-1111-1111-111111111111';
  m uuid := (select id from memberships where customer_id = c);
begin
  update memberships set last_visit_at = now() - interval '13 days', current_streak = 4 where id = m;
  assert not exists (select 1 from streak_reminder_candidates() where membership_id = m), 'no subscription, no reminder';

  insert into push_subscriptions (customer_id, restaurant_id, endpoint, p256dh, auth)
  values (c, r, 'https://push.example/abc', 'key', 'auth');
  assert exists (select 1 from streak_reminder_candidates() where membership_id = m and streak = 4), 'candidate found';

  insert into notification_log (membership_id, kind, ref)
  select membership_id, 'streak_at_risk', ref from streak_reminder_candidates() where membership_id = m;
  assert not exists (select 1 from streak_reminder_candidates() where membership_id = m), 'reminded once only';

  update memberships set last_visit_at = now() - interval '5 days' where id = m;
  assert not exists (select 1 from streak_reminder_candidates() where membership_id = m), 'not yet at risk';
end $$;

select 'engagement: all tests passed' as result;
