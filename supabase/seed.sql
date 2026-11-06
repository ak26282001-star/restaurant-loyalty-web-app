-- Demo data for local development (`supabase db reset` runs this after migrations).
-- Tap URL for the counter tag: http://localhost:3000/t/DEMO01

insert into restaurants (id, slug, name, brand_color, timezone, currency)
values ('11111111-1111-1111-1111-111111111111', 'demo-bistro', 'Demo Bistro', '#E4572E', 'Europe/London', 'GBP')
on conflict do nothing;

insert into locations (id, restaurant_id, name, address, lat, lng, geofence_m)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'Soho', '1 Demo Street, London', 51.5136, -0.1365, 150)
on conflict do nothing;

insert into tags (restaurant_id, location_id, code, kind, label) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'DEMO01', 'nfc', 'Counter'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'DEMO02', 'qr',  'Table tents')
on conflict do nothing;

insert into reward_templates (restaurant_id, name, kind, value, points_cost, min_tier, cost_estimate_cents, valid_days) values
  ('11111111-1111-1111-1111-111111111111', 'Free coffee',          'free_item',   null, 50,  'member',  150, 14),
  ('11111111-1111-1111-1111-111111111111', 'Free dessert',         'free_item',   null, 100, 'member',  400, 14),
  ('11111111-1111-1111-1111-111111111111', '20% off your bill',    'percent_off', 20,   250, 'regular', 900, 14),
  ('11111111-1111-1111-1111-111111111111', 'Chef''s table tasting', 'experience', null, 600, 'vip',    2500, 30)
on conflict do nothing;

-- Phase 2 demo challenges
insert into challenges (restaurant_id, title, description, kind, rule, reward_template_id, bonus_points, starts_at) values
  ('11111111-1111-1111-1111-111111111111', 'Hat-trick', 'Visit 3 times in 14 days and dessert is on us.',
   'visit_count', '{"visits": 3, "within_days": 14}',
   (select id from reward_templates where name = 'Free dessert' and restaurant_id = '11111111-1111-1111-1111-111111111111'),
   0, now() - interval '30 days'),
  ('11111111-1111-1111-1111-111111111111', 'Big night out', 'Spend £60 across your visits this month for 100 bonus points.',
   'spend_amount', '{"spend_cents": 6000, "within_days": 30}', null, 100, now() - interval '30 days')
on conflict do nothing;
