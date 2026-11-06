# Restaurant Loyalty Web App

A tap-to-open loyalty platform for restaurants. Customers tap an NFC tag or scan a QR code and land
on a personalised, mobile-first loyalty page with points, streaks, tiers and rewards. Owners manage
rewards and tags from a dashboard, and staff confirm visits and redeem rewards from a tablet.

The full design is in [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md). This repo implements
**Phase 1 (MVP)** and **Phase 2 (Engagement)** from that plan.

## What works today

| Area | Included |
| --- | --- |
| **Tap / scan** | `/t/{code}` resolves the tag, sets a signed 10-minute tap cookie, logs the tap in the background, and redirects to the restaurant page |
| **Sign-in** | Phone OTP (default) or email magic link via Supabase Auth. The tap survives login, so "tap → join → checked in" is one flow. |
| **Check-in** | Cooldown between visits. A tap is confirmed automatically when the phone is inside the location's geofence (only if location was already granted, otherwise the customer can opt in with one button), or staff confirm it. |
| **Points, tiers, streaks** | Points per visit plus per amount spent, tiers by visit count (Member → Regular → VIP → Legend), streaks with a "come back by" deadline |
| **Rewards** | Points catalogue with tier locks, a wallet with redeem code and QR, and single-use redemption by staff |
| **Staff mode** `/staff/{id}` | Confirm pending visits (optionally with the bill amount), reject, "just confirmed" list, redeem codes |
| **Dashboard** `/admin/{id}` | KPIs, recent visits, reward catalogue (add, hide), tags with printable QR codes |
| **Challenges** *(Phase 2)* | Owner-built goals: N visits (optionally within X days), spend an amount, visit on certain days or times of day, or reach a streak. Progress is recomputed on every confirmed visit; completing one pays bonus points and/or a reward, once per guest. Dashboard shows in-progress and completed counts. |
| **Streak bonuses** *(Phase 2)* | Extra points when a streak reaches set lengths (default 3 → +20, 5 → +50, 10 → +100), with a "next visit earns +50" hint |
| **Live updates** *(Phase 2)* | Supabase Realtime refreshes the customer's page when their balance, rewards or challenges change, e.g. when staff confirm a visit |
| **Installable app and reminders** *(Phase 2)* | Per-restaurant web app manifest and icons, a service worker with an offline page, and opt-in web push: a daily job reminds guests whose streak ends within 36 hours (once per streak) |
| **Settings** `/admin/{id}/settings` *(Phase 2)* | Owner edits points per visit and per amount spent, cooldown, streak window, tier thresholds and streak bonuses |
| **Profile** *(Phase 2)* | Guests add their first name, so staff and the page greet them by name |

Everything that moves points or rewards runs in Postgres functions (`check_in`, `confirm_visit`,
`claim_reward`, `redeem_reward`, `evaluate_challenges`) inside one transaction with the membership
row locked, so double taps, retries and concurrent requests can't double-award or double-redeem.
Row-level security limits which rows each user can reach, and column grants limit what they can
change: through the public API a customer can edit only their name and preferences, and staff can
only reject pending visits.

## Layout

```
apps/web/              Next.js 16 app (App Router, Cache Components, Tailwind v4)
  app/t/[code]/        tap entry point
  app/r/[slug]/        customer loyalty page + login
  app/staff/, admin/   staff mode and owner dashboard (server actions)
  app/api/v1/          REST: POST /visits/check-in
  app/api/cron/        daily streak reminders (Vercel Cron, see vercel.json)
  public/sw.js         service worker: push notifications and offline page
  proxy.ts             refreshes the Supabase session cookie (Next 16's replacement for middleware)
packages/core/         pure TypeScript rules: tiers, streaks, challenges, geofence, settings, push allowlist (+ tests)
supabase/
  migrations/          0001 schema + RLS, 0002 MVP functions, 0003 engagement + security hardening
  seed.sql             "Demo Bistro" with tags DEMO01/DEMO02, four rewards and two challenges
  tests/               SQL behaviour and access-control tests
e2e/journey.mjs        Phase 1 browser test: tap, join, check-in, staff, rewards, dashboard
e2e/engagement.mjs     Phase 2 browser test: challenges, live updates, settings, API hardening, push, offline
```

## Run it locally

Requirements: Node 22+, pnpm 10, Docker.

```bash
pnpm install
pnpm supabase start            # Postgres, Auth and REST API in Docker; applies migrations + seed
cp apps/web/.env.example apps/web/.env.local
# Fill in NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY from `pnpm supabase status`,
# and set TAP_TOKEN_SECRET (e.g. `openssl rand -base64 48`).
# For push reminders, also set the VAPID keys (`npx web-push generate-vapid-keys`) and CRON_SECRET.
pnpm dev                       # http://localhost:3000
```

Then open <http://localhost:3000/t/DEMO01> on your phone-sized browser window. Sign in with one of
the local test numbers configured in `supabase/config.toml`, **+44 7700 900001** or
**+44 7700 900002**, using code **123456**. No SMS is sent.

To try staff mode and the dashboard, make one of the test users a manager:

```sql
-- psql postgresql://postgres:postgres@127.0.0.1:54322/postgres
insert into staff_members (restaurant_id, user_id, role)
select '11111111-1111-1111-1111-111111111111', id, 'manager' from auth.users where phone = '447700900002';
```

then sign in at <http://localhost:3000/login> (choose "Use my phone number instead").

> If Docker can't pull from `public.ecr.aws` on your network, run Supabase with
> `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io pnpm supabase start`.

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm test` | Unit tests for `packages/core` (Vitest) |
| `pnpm typecheck`, `pnpm lint` | TypeScript and ESLint across the workspace |
| `DATABASE_URL=… pnpm test:db` | Applies migrations + seed to a **throwaway** database and runs the SQL behaviour tests. On plain Postgres, add `WITH_AUTH_STUB=1`. |
| `pnpm test:e2e` | Phase 1 journey in Chromium against the running app (`pnpm build && pnpm --filter web start`). Run `pnpm supabase db reset` first. Set `CHROMIUM_PATH` to use a preinstalled browser. |
| `pnpm test:e2e:engagement` | Phase 2 checks, including a real encrypted push to a local fake push service. Reset the database first, and start the app with `PUSH_ENDPOINT_ALLOWLIST=127.0.0.1:8443` and `NODE_EXTRA_CA_CERTS=$PUSH_TLS_DIR/cert.pem`. The script needs `CRON_SECRET`, `SUPABASE_ANON_KEY` and `PUSH_TLS_DIR` (a folder with a self-signed `key.pem` and `cert.pem` for 127.0.0.1). |

## Upgrading a hosted Supabase project

Run each migration in `supabase/migrations/` that the project hasn't had yet, in order, in the
Supabase SQL editor (or `supabase db push` if your network allows a direct database connection).
**0003 also closes a hole in the 0001 policies** that let a signed-in customer change their own
points balance through the REST API, so apply it to any project that already runs 0001.

## Not built yet

These are in the technical plan but left for later phases:

- **NTAG 424 DNA (SUN) tag verification.** Taps from `nfc_sun` tags are currently treated like plain tags.
- **Staff PINs** for shared tablets. Staff currently sign in individually.
- **Reward activation window** (the 10-minute countdown).
- **"Try these items" challenges**, which need POS order data (Phase 3), as do POS integration itself,
  AI offers, campaigns and SMS/email messaging (Phases 3–4).

Notes on how the build differs from the plan: the dashboard and staff forms use Next.js server actions
rather than REST routes (only check-in is a public API route), and background work runs in Postgres
functions plus one Vercel Cron job instead of Inngest. Both can move to the planned design when
POS webhooks and campaigns arrive.
