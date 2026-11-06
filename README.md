# Restaurant Loyalty Web App

A tap-to-open loyalty platform for restaurants. Customers tap an NFC tag or scan a QR code and land
on a personalised, mobile-first loyalty page with points, streaks, tiers and rewards. Owners manage
rewards and tags from a dashboard, and staff confirm visits and redeem rewards from a tablet.

The full design is in [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md). This repo currently
implements **Phase 1 (MVP)** from that plan.

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

Everything that moves points or rewards runs in Postgres functions (`check_in`, `confirm_visit`,
`claim_reward`, `redeem_reward`) inside one transaction with the membership row locked, so double
taps, retries and concurrent requests can't double-award or double-redeem.

## Layout

```
apps/web/              Next.js 16 app (App Router, Cache Components, Tailwind v4)
  app/t/[code]/        tap entry point
  app/r/[slug]/        customer loyalty page + login
  app/staff/, admin/   staff mode and owner dashboard (server actions)
  app/api/v1/          REST: POST /visits/check-in
  proxy.ts             refreshes the Supabase session cookie (Next 16's replacement for middleware)
packages/core/         pure TypeScript rules: tiers, streaks, geofence, settings, tag codes (+ tests)
supabase/
  migrations/          schema, RLS, and the MVP SQL functions
  seed.sql             "Demo Bistro" with tags DEMO01/DEMO02 and four rewards
  tests/               SQL behaviour tests
e2e/journey.mjs        31-step browser test of the whole customer + staff journey
```

## Run it locally

Requirements: Node 22+, pnpm 10, Docker.

```bash
pnpm install
pnpm supabase start            # Postgres, Auth and REST API in Docker; applies migrations + seed
cp apps/web/.env.example apps/web/.env.local
# Fill in NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY from `pnpm supabase status`,
# and set TAP_TOKEN_SECRET (e.g. `openssl rand -base64 48`).
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
| `pnpm test:e2e` | Full journey in Chromium against the running app (`pnpm build && pnpm --filter web start`). Run `pnpm supabase db reset` first. Set `CHROMIUM_PATH` to use a preinstalled browser. |

## Not in Phase 1 yet

These are in the technical plan but deliberately left for later phases:

- **NTAG 424 DNA (SUN) tag verification.** Taps from `nfc_sun` tags are currently treated like plain tags.
- **Staff PINs** for shared tablets. Staff currently sign in individually.
- **Reward activation window** (the 10-minute countdown) and Realtime balance updates.
- **POS integration, AI offers, challenges, campaigns and messaging** (Phases 2–4).
- Customer profile editing (first name, birthday). Guests show as "Guest" until then.

The plan describes some endpoints as REST routes. In the MVP, the dashboard and staff forms use
Next.js server actions instead, and only check-in is a public API route.
