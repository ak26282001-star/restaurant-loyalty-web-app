# Tap-to-Open Restaurant Loyalty — Technical Plan

> Customers tap an NFC tag or scan a QR code → land on a personalised loyalty page →
> earn points, streaks, challenges and AI-personalised rewards. Owners manage everything
> from a dashboard and approve (or auto-issue) AI-generated offers and win-back campaigns.

**Contents**

1. [Architecture](#1-architecture)
2. [Tech stack](#2-tech-stack)
3. [Repository layout](#3-repository-layout)
4. [Database schema](#4-database-schema)
5. [Authentication flow](#5-authentication-flow)
6. [NFC / QR landing flow](#6-nfc--qr-landing-flow)
7. [API endpoints](#7-api-endpoints)
8. [Loyalty engine (points, tiers, streaks, challenges)](#8-loyalty-engine)
9. [AI logic flow for personalised offers](#9-ai-logic-flow-for-personalised-offers)
10. [Admin dashboard](#10-admin-dashboard)
11. [Example code](#11-example-code)
12. [Security, privacy and abuse prevention](#12-security-privacy-and-abuse-prevention)
13. [Deployment plan](#13-deployment-plan)
14. [Observability, testing and roadmap](#14-observability-testing-and-roadmap)

---

## 1. Architecture

### 1.1 High-level

```
                ┌──────────────┐   tap / scan    ┌─────────────────────────────────────────┐
  NFC tag / QR ─┤ https://lp.app/t/{code}[?sun] ├─▶│  Vercel Edge Middleware                 │
                └──────────────┘                 │  • tag lookup (Redis cache)             │
                                                 │  • SUN/CMAC verify, rate-limit, cookie  │
                                                 └───────────────┬─────────────────────────┘
                                                                 ▼
┌──────────────────────────── Next.js 15 (App Router) on Vercel ───────────────────────────┐
│                                                                                          │
│  Customer PWA  (/r/[slug]/*)        Admin dashboard (/admin/*)       Staff mode (/staff) │
│  React Server Components + client islands, Tailwind, shadcn/ui                           │
│                                                                                          │
│  Route Handlers  /api/v1/*   ── Zod-validated, thin ──▶  Domain services (packages/core)  │
│  Server Actions  (forms)                                  loyalty · rewards · challenges │
│                                                           visits · campaigns · ai        │
└───────┬──────────────────────┬───────────────────────┬──────────────────┬────────────────┘
        │                      │                       │                  │
        ▼                      ▼                       ▼                  ▼
 ┌──────────────┐     ┌─────────────────┐     ┌────────────────┐  ┌───────────────────┐
 │ Supabase     │     │ Upstash Redis   │     │ Inngest        │  │ Claude API        │
 │ Postgres+RLS │     │ rate limits,    │     │ event-driven + │  │ offer selection & │
 │ Auth (OTP,   │     │ tag cache, tap  │     │ cron jobs      │  │ copy (structured  │
 │ magic link)  │     │ dedupe          │     │ (fan-out,      │  │ JSON output),     │
 │ Realtime     │     └─────────────────┘     │ retries)       │  │ nightly via Batch │
 │ Storage      │                             └───────┬────────┘  └───────────────────┘
 └──────┬───────┘                                     │
        │                                             ▼
        │                              ┌──────────────────────────────┐
        └──── POS webhooks ──────────▶ │ Square / Toast / Clover      │
                                       │ Twilio (SMS) · Resend (email)│
                                       │ Web Push (VAPID)             │
                                       └──────────────────────────────┘
```

### 1.2 Design principles

| Principle | How it shows up |
| --- | --- |
| **Mobile-first, instant** | The landing page is a React Server Component streamed from the edge region nearest the user; the target is under 1 second to first meaningful paint on 4G. The PWA is installable and its wallet works offline. |
| **Thin API, fat domain** | Route handlers only do auth, Zod validation and response mapping. All business rules live in `packages/core`, which is pure TypeScript and unit-testable without Next.js. |
| **Ledger, not counters** | Points are an append-only `points_ledger` with idempotency keys. `memberships.points_balance` is a cache that is only changed atomically through `award_points()`. |
| **Events over coupling** | A confirmed visit emits `visit.confirmed`. Streaks, challenges, tier upgrades, features and AI re-scoring subscribe to it independently in Inngest. |
| **AI proposes, rules dispose** | The AI picks from an owner-defined reward catalogue and writes copy. A deterministic guardrail layer enforces budget, discount caps and frequency caps before anything reaches a customer. |
| **Multi-tenant from day one** | Every row carries `restaurant_id`. Postgres RLS is the security boundary, and staff access goes through `is_staff(restaurant_id, role)`. |

### 1.3 Request types

| Path | Rendering | Data access |
| --- | --- | --- |
| `/t/{code}` (tap) | Edge middleware → 307 redirect | Redis, then Postgres via service role |
| `/r/{slug}` (loyalty page) | RSC, dynamic, streamed | Supabase server client with the user JWT (RLS) |
| `/admin/*` | RSC + client charts | Supabase server client with the staff JWT (RLS) |
| `/api/v1/*` | Node.js runtime route handlers | User JWT for reads; service role in domain services for writes that move value |
| `/api/webhooks/*` | Node.js, signature-verified | Service role |
| Background | Inngest functions (Vercel serverless) | Service role + Claude API |

---

## 2. Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 15 (App Router) + React 19 + TypeScript** | RSC for fast mobile pages, route handlers and server actions in one deployable, first-class Vercel support |
| UI | **Tailwind CSS v4 + shadcn/ui + Framer Motion** | Mobile-first utility CSS, accessible primitives, and delightful reward animations |
| Client state | **TanStack Query** (server state) + **Zustand** (tiny UI state) | Optimistic redemption and background refetch |
| Forms / validation | **Zod** + React Hook Form | One schema shared by client, API and AI output |
| Database | **Supabase Postgres** | Relational data (ledger, joins for analytics), RLS, Realtime, managed backups |
| Auth | **Supabase Auth**: phone OTP (Twilio Verify) + email magic link | Passwordless and native to RLS (`auth.uid()`) |
| Cache / rate limit | **Upstash Redis** + `@upstash/ratelimit` | Works from Edge middleware over HTTP |
| Jobs / events | **Inngest** | Durable steps, retries, fan-out and cron on Vercel serverless with no queue infrastructure. *Alternative:* Vercel Cron + Supabase queues (`pgmq`). |
| AI | **Claude API** (`@anthropic-ai/sdk`, model `claude-opus-5-5`) | Structured JSON output validated with Zod; the Batch API (50% cost) for nightly bulk generation |
| Messaging | **Twilio** (SMS), **Resend** + React Email (email), **Web Push** (VAPID) | Win-back and surprise delivery |
| POS | **Square / Toast / Clover** webhooks | Ground-truth visits, spend and items |
| Charts | **Recharts** | Admin analytics |
| Monitoring | **Sentry**, **Vercel Analytics / Speed Insights**, **PostHog** (product analytics and feature flags) | |
| Testing | **Vitest** (core), **Playwright** (E2E, mobile viewport), **pgTAP** (RLS policies) | |
| Monorepo | **pnpm workspaces + Turborepo** | `apps/web` plus shared `packages/*` |

Firebase would also work, but Supabase is the better fit: loyalty data is relational (ledger, orders → items → menu, cohort analytics), RLS ties authorization to the database, and SQL makes it simple to compute AI features.

---

## 3. Repository layout

```
restaurant-loyalty-web-app/
├─ apps/
│  └─ web/                          # Next.js app (customer PWA + admin + API)
│     ├─ app/
│     │  ├─ t/[code]/route.ts       # tap entry (fallback if middleware is bypassed)
│     │  ├─ r/[slug]/               # customer loyalty experience
│     │  │  ├─ page.tsx             # personalised home
│     │  │  ├─ login/page.tsx       # OTP / magic link
│     │  │  ├─ rewards/page.tsx
│     │  │  ├─ challenges/page.tsx
│     │  │  └─ history/page.tsx
│     │  ├─ admin/[restaurantId]/   # owner dashboard
│     │  ├─ staff/[restaurantId]/   # confirm visits, redeem rewards (tablet)
│     │  ├─ api/v1/...              # REST endpoints (section 7)
│     │  ├─ api/webhooks/{pos,twilio,resend}/route.ts
│     │  └─ api/inngest/route.ts    # Inngest handler
│     ├─ components/                # UI (loyalty-card, streak-flame, reward-sheet, ...)
│     ├─ lib/supabase/{server,client,admin}.ts
│     └─ middleware.ts              # tap resolution, auth refresh, rate limits
├─ packages/
│  ├─ core/                         # pure domain logic, no framework imports
│  │  ├─ loyalty/  (points, tiers, streaks)
│  │  ├─ challenges/
│  │  ├─ rewards/  (issue, redeem, guardrails)
│  │  ├─ visits/   (verification, cooldown)
│  │  └─ ai/       (features, scoring, prompt builder, schemas)
│  ├─ db/                           # generated Supabase types + typed queries
│  ├─ jobs/                         # Inngest functions
│  └─ ui/                           # shared design system
├─ supabase/
│  ├─ migrations/0001_initial_schema.sql
│  ├─ seed.sql
│  └─ tests/rls.test.sql            # pgTAP
└─ docs/TECHNICAL_PLAN.md
```

---

## 4. Database schema

The full DDL with enums, indexes, RLS policies and the atomic `award_points()` function is in
[`supabase/migrations/0001_initial_schema.sql`](../supabase/migrations/0001_initial_schema.sql).

### 4.1 Entity relationships

```
restaurants 1─┬─* locations 1──* tags 1──* tap_events
              ├─* staff_members *──1 auth.users
              ├─* menu_items
              ├─* reward_templates ──┐
              ├─* challenges ────────┤
              ├─* campaigns ─────────┤
              └─* memberships *──1 customers 1──1 auth.users
                     │1
                     ├─* points_ledger
                     ├─* visits 1──* orders 1──* order_items *──1 menu_items
                     ├─* rewards *──1 reward_templates
                     ├─* challenge_progress *──1 challenges
                     ├─1 customer_features            (AI feature vector)
                     ├─* ai_recommendations           (AI proposals → rewards)
                     └─* campaign_deliveries *──1 campaigns
```

### 4.2 Tables

| Table | Purpose | Key fields |
| --- | --- | --- |
| `restaurants` | Tenant / brand | `slug`, `name`, `brand_color`, `timezone`, `currency`, `settings` (JSON: points rules, tier thresholds, AI guardrails) |
| `locations` | Physical stores | `restaurant_id`, `lat/lng`, `geofence_m`, `pos_provider`, `pos_location_id` |
| `staff_members` | Dashboard access | `(restaurant_id, user_id)` PK, `role` (owner/manager/staff), `pin_hash` |
| `customers` | Global person (1:1 with `auth.users`) | `phone`, `email`, `first_name`, `birthday` |
| `memberships` | Customer × restaurant | `points_balance`, `lifetime_points`, `tier`, `visit_count`, `current_streak`, `longest_streak`, `last_visit_at`, `marketing_opt_in`, `preferred_channel` |
| `tags` | NFC/QR entry points | `code` (opaque, unique), `kind` (`nfc`, `nfc_sun`, `qr`), `label`, `sun_key_enc`, `last_sun_ctr` |
| `tap_events` | Raw tap log, including anonymous taps | `tag_id`, `customer_id?`, `device_id`, `sun_verified`, `ip_hash` |
| `menu_items` | Synced from POS | `pos_item_id`, `name`, `category`, `price_cents`, `tags[]` |
| `visits` | A verified (or pending) visit | `source` (tap/pos/staff/receipt_qr), `status`, `spend_cents`, `confirmed_by` |
| `orders`, `order_items` | Basket data for favourites | `pos_order_id`, `total_cents`, `menu_item_id`, `quantity` |
| `points_ledger` | Append-only points history | `delta`, `reason`, `ref_type/ref_id`, `idempotency_key` (unique) |
| `reward_templates` | Owner's reward catalogue | `kind`, `value`, `menu_item_id`, `points_cost`, `min_tier`, `cost_estimate_cents`, `ai_eligible` |
| `rewards` | Issued wallet items | `origin` (tier/streak/challenge/surprise/winback/vip/manual), `title`, `message`, `status`, `redeem_code`, `expires_at` |
| `challenges`, `challenge_progress` | Gamified goals | `kind`, `rule` (JSON), `bonus_points`, `is_personalised`; progress JSON + status |
| `customer_features` | AI feature vector per membership | `recency_days`, `frequency_90d`, `monetary_90d_cents`, `avg_gap_days`, `overdue_ratio`, `churn_risk`, `segment`, `favourite_items`, `preferred_daypart`, `reward_response_rate` |
| `ai_recommendations` | AI proposals awaiting approval or issue | `kind`, `template_id`, `title`, `message`, `rationale`, `confidence`, `send_at`, `channel`, `status`, `input_snapshot` |
| `campaigns`, `campaign_deliveries` | Win-back, VIP, surprise and broadcast | `audience` (JSON filter), `ai_personalise`, `channel`; per-recipient send, open and conversion |

### 4.3 Notes on the data model

- **Tap ≠ visit.** A tap only proves the phone was near a tag; tags can be photographed and shared. A visit becomes `confirmed` through a POS order match, staff PIN, a receipt QR, or a SUN-verified tap with geofence and cooldown checks (§6.4).
- **Idempotency.** Every value-moving write carries an idempotency key (for example `visit:{visit_id}` or `challenge:{progress_id}`), so retried jobs and webhooks never double-award.
- **Soft PII.** Phone and email live only in `customers`. Analytics and AI prompts use `membership_id` plus first name only.
- **Partitioning later.** `tap_events` and `points_ledger` are the high-volume tables. Partition them by month (`pg_partman`) once they pass about 50M rows.

---

## 5. Authentication flow

Two passwordless options are offered on the same screen: **phone OTP** is the default because it suits restaurants and SMS is the win-back channel, and **email magic link** is the fallback.

### 5.1 Customer flow

```
Tap tag ──▶ /t/{code} ──▶ set lp_device cookie, lp_tag cookie (10 min), log tap
   │
   ▼
/r/{slug}?from=tap
   ├─ has Supabase session? ── yes ──▶ ensure membership ──▶ record visit ──▶ personalised home
   └─ no ──▶ "Welcome to {Restaurant}!" teaser (points preview, today's offer)
              │  [Join with phone]  [Use email instead]
              ▼
        POST supabase.auth.signInWithOtp({ phone })        (rate limited: 3 per 10 min per phone/IP)
              ▼
        6-digit code input (autocomplete="one-time-code", so iOS/Android auto-fill it)
              ▼
        supabase.auth.verifyOtp({ phone, token, type: 'sms' })
              ▼
        Auth hook / first login ──▶ upsert customers, create membership(joined_via_tag_id)
              ▼
        Server reads lp_tag cookie ──▶ POST /api/v1/visits/check-in (same flow as a logged-in tap)
              ▼
        Personalised home + "+10 points, welcome!" celebration
```

- Sessions use Supabase JWTs in **httpOnly cookies** via `@supabase/ssr`. `middleware.ts` refreshes them on every request, and refresh tokens last 60 days so returning customers are rarely asked to log in again.
- **Magic link**: `signInWithOtp({ email, options: { emailRedirectTo: '/auth/callback?next=/r/{slug}' } })`. The callback exchanges the code for a session (`exchangeCodeForSession`).
- Progressive profile: first name is requested after the first reward, and birthday after the second visit (it unlocks a birthday reward).
- Marketing consent is a separate, unticked checkbox, stored per restaurant in `memberships.marketing_opt_in` (TCPA/GDPR).

### 5.2 Staff and owner flow

- Email magic link plus **TOTP MFA** (Supabase MFA) required for `owner` and `manager`.
- Staff tablets: a manager signs the device in once. Individual staff then confirm visits and redemptions with a 4–6 digit PIN (`staff_members.pin_hash`, argon2), which is cheap and fast during service.
- Invites: the owner adds an email, the system sends a magic link, and a `staff_members` row is created with the chosen role.

---

## 6. NFC / QR landing flow

### 6.1 Tag encoding

| Tag type | Payload | Use |
| --- | --- | --- |
| QR (table tent, receipt, window) | `https://lp.app/t/Ab3xK9` | Cheapest and universal |
| NFC NTAG213/215 | NDEF URI record `https://lp.app/t/Ab3xK9` | Tap with any modern phone (iOS reads NDEF URLs natively in the background) |
| **NFC NTAG 424 DNA (SUN)** | `https://lp.app/t/Ab3xK9?p={PICCData}&c={CMAC}` (the tag generates them on every tap) | **Anti-cloning.** Each tap has a unique counter and AES-CMAC, so a photo or copy of the URL cannot be replayed. Recommended for the counter tag that earns visit points. |

`code` is a random 6–8 character base62 string. It is never a sequential ID, so it cannot be enumerated.

### 6.2 Sequence

```
Phone ──GET /t/Ab3xK9?p=..&c=..──▶ Edge middleware
  1. Rate limit by IP (30/min) and by device cookie
  2. Resolve tag: Redis GET tag:Ab3xK9 → {restaurant_id, slug, kind, location_id}  (miss → Postgres, cache 1h)
  3. If kind = nfc_sun: decrypt PICCData, verify CMAC, require ctr > last_sun_ctr  → sun_verified
  4. Ensure lp_device cookie (random UUID, 1 year, httpOnly, SameSite=Lax)
  5. Set lp_tag = signed JWT {tag_id, sun_verified, ts}  (10 min TTL), which carries the tap through login
  6. Fire-and-forget: POST to Inngest "tap.received" (logs tap_events, never blocks the redirect)
  7. 307 → /r/{slug}?from=tap
                                 ▼
/r/{slug} (RSC)
  • Logged out → teaser + login (§5)
  • Logged in  → server action checkIn(): verifies lp_tag, applies the visit rules (§6.4),
                 returns {visit, pointsAwarded, newRewards, streak} → celebration animation
                 then personalised home
```

### 6.3 Personalised landing page

Rendered top to bottom, mobile-first, with the brand colour applied from `restaurants.brand_color`:

1. **Hero card**: "Hey Sam 👋", points balance with an animated counter, tier badge, and a progress ring to the next tier.
2. **Streak flame**: "🔥 4-visit streak. Come back by Fri to keep it."
3. **Just for you**: the top one or two active AI rewards, with personalised copy (for example "Your usual flat white is on us this week").
4. **Challenges** carousel with progress bars (for example "Try 3 new mains: 1/3").
5. **Rewards wallet**: tap a reward to open a bottom sheet with the redeem code, a QR code and a 10-minute countdown once activated.
6. **Menu favourites**, so the page remembers what they like.
7. Footer: history, profile, notification settings, and "Add to Home Screen" (PWA).

### 6.4 Visit verification rules (anti-abuse)

A tap creates a visit only if all of these hold:

- No confirmed visit for this membership within `visit_cooldown_minutes` (default 4h), checked atomically with a Redis `SET NX EX` lock and a database check.
- And **one** of the following is true:
  - `sun_verified = true` (NTAG 424 DNA), or
  - browser geolocation (optional prompt) is within `locations.geofence_m`, or
  - a matching POS order arrives within ±30 min (the visit is created as `pending` and auto-confirmed by the POS webhook), or
  - staff confirm with a PIN on the staff tablet.
- Otherwise the visit stays `pending`. The customer sees "Show this screen to staff to confirm," and pending visits expire after 2 hours.

Spend-based points are only awarded from POS data, never from client input.

---

## 7. API endpoints

REST under `/api/v1`, JSON, Zod-validated, cursor pagination (`?cursor=&limit=`). Authentication uses the Supabase JWT from cookies (web) or `Authorization: Bearer` (future native app). Mutations accept an `Idempotency-Key` header. Errors follow `{ error: { code, message, details? } }`.

### 7.1 Public / tap

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/t/{code}` | Tap entry. Verifies, logs and redirects (§6.2). |
| `GET` | `/api/v1/restaurants/{slug}/public` | Branding, teaser offer, tier names. No auth. |

### 7.2 Customer profile

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/me` | Customer profile and the list of memberships |
| `PATCH` | `/api/v1/me` | Update `first_name`, `birthday`, `locale` |
| `GET` | `/api/v1/me/memberships/{restaurantId}` | Balance, tier, streak, and next-tier progress |
| `PATCH` | `/api/v1/me/memberships/{restaurantId}` | `marketing_opt_in`, `preferred_channel` |
| `GET` | `/api/v1/me/memberships/{restaurantId}/home` | **One call for the landing page**: membership, featured rewards, challenges, streak and favourites |
| `GET` | `/api/v1/me/memberships/{restaurantId}/ledger` | Points history (paginated) |
| `DELETE` | `/api/v1/me` | GDPR erasure (anonymises orders and deletes PII) |
| `GET` | `/api/v1/me/export` | GDPR data export (JSON) |

### 7.3 Visit tracking

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/visits/check-in` | Customer | Body `{ restaurantId, tapToken, geo? }`. Returns `{ visit, status, pointsAwarded, unlocked: [...], streak }`. |
| `GET` | `/api/v1/me/visits?restaurantId=` | Customer | Visit history |
| `GET` | `/api/v1/admin/{rid}/visits/pending` | Staff | Queue of visits awaiting confirmation |
| `POST` | `/api/v1/admin/{rid}/visits/{visitId}/confirm` | Staff | Body `{ pin, spendCents? }` |
| `POST` | `/api/v1/admin/{rid}/visits/{visitId}/reject` | Staff | |
| `POST` | `/api/webhooks/pos/{provider}` | POS | Signature-verified order webhook. Matches the customer by phone or open pending visit, creates the order and items, and confirms the visit. |

### 7.4 Rewards

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me/rewards?restaurantId=&status=active` | Customer | Wallet |
| `GET` | `/api/v1/restaurants/{rid}/catalog` | Customer | Rewards purchasable with points |
| `POST` | `/api/v1/me/rewards/claim` | Customer | Body `{ templateId }`. Spends points (ledger debit) and issues a reward. |
| `POST` | `/api/v1/me/rewards/{rewardId}/activate` | Customer | Starts a 10-minute redeem window and returns the code and QR payload |
| `POST` | `/api/v1/admin/{rid}/rewards/redeem` | Staff | Body `{ redeemCode, pin }`. Marks the reward redeemed. |
| `GET/POST/PATCH/DELETE` | `/api/v1/admin/{rid}/reward-templates[/{id}]` | Manager | Catalogue CRUD |
| `POST` | `/api/v1/admin/{rid}/rewards/issue` | Manager | Manual gift to a member |

### 7.5 Challenges

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me/challenges?restaurantId=` | Customer | Active and personalised challenges with progress |
| `POST` | `/api/v1/me/challenges/{id}/join` | Customer | Opt in, for challenges that need it |
| `GET/POST/PATCH/DELETE` | `/api/v1/admin/{rid}/challenges[/{id}]` | Manager | CRUD, rule builder |
| `GET` | `/api/v1/admin/{rid}/challenges/{id}/stats` | Manager | Join rate, completion rate, incremental visits |

### 7.6 AI recommendations

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/{rid}/ai/recommendations?status=proposed&kind=` | Manager | Review queue |
| `POST` | `/api/v1/admin/{rid}/ai/recommendations/{id}/approve` | Manager | Issues the reward and schedules delivery |
| `POST` | `/api/v1/admin/{rid}/ai/recommendations/{id}/reject` | Manager | Body `{ reason }`. The reason feeds future prompts as owner preferences. |
| `POST` | `/api/v1/admin/{rid}/ai/recommendations/bulk` | Manager | Body `{ ids, action }` |
| `POST` | `/api/v1/admin/{rid}/ai/generate` | Manager | Body `{ membershipIds? , segment?, kind? }`. Runs on demand (enqueued). |
| `GET` | `/api/v1/admin/{rid}/members/{membershipId}/insights` | Manager | Feature vector, segment, churn risk, favourites, timeline |
| `GET` | `/api/v1/admin/{rid}/ai/settings` / `PATCH` | Owner | Guardrails: auto-issue, max discount, weekly cap, monthly budget |

### 7.7 Campaigns and analytics

| Method | Path | Description |
| --- | --- | --- |
| `GET/POST/PATCH` | `/api/v1/admin/{rid}/campaigns[/{id}]` | Win-back, VIP, surprise, birthday and broadcast campaigns |
| `POST` | `/api/v1/admin/{rid}/campaigns/{id}/preview` | Audience size, sample of personalised messages, estimated cost |
| `POST` | `/api/v1/admin/{rid}/campaigns/{id}/launch` / `pause` | |
| `GET` | `/api/v1/admin/{rid}/analytics/overview?from=&to=` | KPIs (§10) |
| `GET` | `/api/v1/admin/{rid}/analytics/cohorts` | Retention cohorts by join month |
| `GET` | `/api/v1/admin/{rid}/members?segment=&q=&sort=` | Member CRM list |
| `GET/POST/PATCH` | `/api/v1/admin/{rid}/tags[/{id}]` | Tag management. `GET .../tags/{id}/qr.svg` renders a printable QR. |
| `POST` | `/api/webhooks/twilio`, `/api/webhooks/resend` | Delivery and opt-out (STOP) status |

---

## 8. Loyalty engine

All rules live in `packages/core`, are driven by `restaurants.settings`, and run inside the `visit.confirmed` Inngest workflow:

```
visit.confirmed
  ├─ step "points"     → award_points(points_per_visit + spend × rate)   idempotency key = visit:{id}
  ├─ step "streak"     → update current/longest streak
  ├─ step "tier"       → recompute tier from visit_count / lifetime_points; on upgrade, issue a tier reward
  ├─ step "challenges" → evaluate each active challenge_progress; on completion, issue reward + bonus points
  ├─ step "features"   → recompute customer_features for this membership
  └─ step "realtime"   → broadcast to channel membership:{id}, so an open page animates the new state
```

**Streaks.** A streak counts consecutive visits where each gap is at most `streak_window_days` (default 14). Bonuses are awarded at 3, 5 and 10 visits. A **streak freeze** (one per month, earned at VIP tier) prevents a single missed window from resetting it. Two days before the window closes, a reminder is sent ("Your 🔥 5-streak ends Sunday").

**Tiers.** `member → regular (5 visits) → vip (15) → legend (40)`, with thresholds set by the owner. Tiers are re-evaluated on a rolling 12-month window each night, with a 30-day grace period before any downgrade.

**Challenge rule DSL** (`challenges.rule` JSON, evaluated by a small typed interpreter):

```jsonc
{ "type": "visit_count",  "visits": 3, "within_days": 14 }
{ "type": "try_items",    "menu_item_ids": ["…","…","…"], "need": 2 }
{ "type": "spend_amount", "spend_cents": 10000, "within_days": 30 }
{ "type": "time_window",  "weekdays": [1,2], "daypart": "lunch", "visits": 2 }   // drive quiet periods
{ "type": "streak",       "length": 4 }
```

---

## 9. AI logic flow for personalised offers

### 9.1 Pipeline overview

```
            ┌──────────────────────── nightly 03:00 local (Inngest cron, per restaurant) ───────────────────────┐
            │                                                                                                   │
 Postgres ──▶ 1. FEATURES (SQL) ──▶ 2. SCORING (deterministic) ──▶ 3. CANDIDATES (rules) ──▶ 4. LLM (Claude)   │
 visits,      RFM, gaps, items,      churn_risk, segment,            who needs what & which     picks template,  │
 orders,      dayparts, response     next-visit ETA                  templates are eligible     writes copy,     │
 rewards      rates                                                                             proposes timing  │
            │                                                                                        │          │
            │                                     5. GUARDRAILS (code) ◀──────────────────────────────┘          │
            │                                     caps, budget, dedupe, tier rules, schema checks                 │
            │                                                │                                                    │
            │                                     6. ai_recommendations (status=proposed)                         │
            │                                                │                                                    │
            │             auto_issue? ── yes ──▶ issue reward + schedule delivery                                 │
            │                         └─ no ───▶ owner review queue (approve / edit / reject)                     │
            └───────────────────────────────────────────────────────────────────────────────────────────────────┘
 7. FEEDBACK: redemptions, visits within 14 days of delivery and owner rejections update reward_response_rate and the prompt context
```

Real-time triggers also exist: `visit.confirmed` can produce an **in-the-moment surprise** (for example on the 10th visit, or the first visit after a win-back). These use the same pipeline for a single member, with a tighter latency budget.

### 9.2 Step 1: Feature engineering (SQL)

Computed per membership in one SQL statement (a materialised CTE over visits and orders in the last 180 days):

| Feature | Definition |
| --- | --- |
| `recency_days` | now − last confirmed visit |
| `frequency_90d` | confirmed visits in the last 90 days |
| `monetary_90d_cents` | spend in the last 90 days |
| `avg_gap_days`, `gap_stddev_days` | mean and standard deviation of the gaps between consecutive visits (needs at least 3 visits; otherwise the restaurant median is used) |
| `overdue_ratio` | `recency_days / avg_gap_days`. **This is the main drop-off signal.** A value of 1.0 means the member is on schedule; 2.0 means they are twice as late as usual. |
| `favourite_items` | top 3 items by share of order lines |
| `preferred_daypart`, `preferred_weekdays` | mode of visit timestamps in the restaurant's timezone |
| `reward_response_rate` | redeemed / issued over the last 180 days |
| `days_to_next_tier`, `streak_at_risk` | derived from membership state |

### 9.3 Step 2: Scoring and segmentation (deterministic, explainable)

```
churn_risk = sigmoid( 1.6·(overdue_ratio − 1.5) + 0.4·[frequency_90d == 0] − 0.3·log1p(lifetime_visits) )

segment =
  new        if lifetime_visits ≤ 2 and recency_days ≤ 30
  vip        if tier ∈ {vip, legend} and overdue_ratio < 1.5
  regular    if overdue_ratio < 1.5
  at_risk    if 1.5 ≤ overdue_ratio < 3
  lapsed     if overdue_ratio ≥ 3 or recency_days > 90
```

The v1 heuristic is transparent to owners and needs no training data. **v2** (after about 3 months of data) replaces it with a gradient-boosted classifier, trained offline in Python on the label "no visit in the next 30 days" and exported to ONNX for inference in Node. It is kept only if it beats the heuristic on AUC.

### 9.4 Step 3: Candidate generation (rules decide *who* and *what type*)

| Segment / trigger | Offer type | Example eligible templates |
| --- | --- | --- |
| `new`, 1 visit | Second-visit hook | 2× points next visit, free side |
| `regular`, `streak_at_risk` | Streak saver | Bonus points if they visit by the deadline |
| `regular`, near next tier | Challenge | "2 more visits → VIP" |
| `vip` | VIP experience | Chef's table, off-menu tasting, skip-the-line |
| `at_risk` | Gentle nudge | Favourite item 15% off |
| `lapsed` | Win-back | Free favourite item, which costs the most so it is budget-gated |
| Any, random 5% of active members per week | Surprise & delight | Free dessert ("just because") |
| Birthday in 7 days | Birthday | Free dessert or drink |

The output is a set of `{membership, offerType, eligibleTemplateIds[]}` candidates. Members who already received the maximum number of offers this week, or who have an unredeemed AI reward, are filtered out here.

### 9.5 Step 4: LLM personalisation (Claude)

The LLM gets a **compact, anonymised profile** (first name, segment, favourites, daypart, streak, tier, owner preferences) plus the **eligible templates only**. It returns structured JSON (Zod schema → `output_config.format`) choosing:

- `templateId`: must be one of the eligible IDs
- `title` (≤ 40 chars) and `message` (≤ 160 chars, SMS-safe), in the restaurant's voice
- `challenge`: optional personalised challenge using the rule DSL
- `sendAt`: suggested time aligned to the member's daypart
- `rationale` for the owner, and `confidence` from 0 to 1

**Cost control.** The nightly run uses the **Message Batches API** (50% cheaper, asynchronous). The restaurant brand and voice block sits in a stable system prompt prefix with prompt caching, and only the per-member profile varies. Real-time surprises use a single synchronous call.

### 9.6 Step 5: Guardrails (code, always enforced)

```
✔ templateId ∈ eligibleTemplateIds and template.ai_eligible and template.is_active
✔ discount ≤ settings.ai.max_discount_percent; template.min_tier ≤ member tier
✔ offers to this member this week < settings.ai.max_offers_per_customer_per_week
✔ Σ cost_estimate_cents of issued AI rewards this month + this one ≤ monthly_reward_budget
   (when over budget, keep the highest expected value: confidence × (1 − churn_risk penalty) / cost)
✔ message passes length, profanity and PII checks; no promises outside the template (regex on %/£/$ amounts)
✔ marketing_opt_in = true for outbound channels (in-app offers are always allowed)
✔ quiet hours: sendAt between 09:00 and 20:00 local time
✘ any failure → fall back to the template's default copy, or drop the recommendation and log the reason
```

### 9.7 Step 7: Feedback and measurement

- Each campaign keeps a **5–10% holdout group** that receives no offer. Lift is measured as the incremental visit rate within 14 days compared with the holdout. This is the number owners care about.
- `reward_response_rate` and owner rejections (with their reason text) are fed back into the next prompt ("Owner prefers not to discount alcohol").
- Template-level win rates feed a simple **Thompson-sampling bandit**, which re-orders `eligibleTemplateIds` before the LLM sees them.

---

## 10. Admin dashboard

Route: `/admin/[restaurantId]/…`. Desktop-first, but every page is usable on a phone.

| Section | Contents |
| --- | --- |
| **Overview** | KPI cards (active members over 30 days, visits this week, repeat rate, average visit frequency, redemption rate, AI-attributed incremental visits, reward cost vs budget), a visits chart, a segment donut and today's live taps (Realtime) |
| **Members** | Searchable CRM table with segment, tier, last visit, churn-risk filters and CSV export. The member drawer shows timeline, favourites, features, rewards and manual actions (gift reward, adjust points with a reason). |
| **AI Inbox** | Review queue of proposed recommendations (copy, template, rationale, confidence, cost). Approve, edit-and-approve or reject, singly or in bulk, plus an **auto-issue** toggle and guardrail settings. |
| **Rewards** | Template catalogue CRUD, the points shop, and performance per template (issued, redeemed, cost, lift) |
| **Challenges** | Visual rule builder over the DSL, plus join and completion funnels |
| **Campaigns** | Win-back, VIP, surprise and birthday campaigns. Audience builder → AI preview of 5 sample messages → schedule → results compared with the holdout. |
| **Tags & QR** | Tags per location and label, print-ready QR (SVG/PDF), NFC programming instructions, and tap counts |
| **Locations & POS** | Connect Square/Toast with OAuth, menu sync status and webhook health |
| **Staff** | Invite, set role and PIN, and an audit log |
| **Settings** | Branding (logo, colour preview of the landing page), points rules, tiers, streak window, quiet hours, SMS sender and billing |
| **Staff mode** (`/staff/[rid]`) | Tablet UI with large touch targets: pending visits to confirm, a redeem-code scanner (camera QR via `BarcodeDetector`) and recent activity |

---

## 11. Example code

### 11.1 Edge middleware: tap resolution

```ts
// apps/web/middleware.ts
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { SignJWT } from "jose";
import { updateSupabaseSession } from "@/lib/supabase/middleware";
import { verifySunMessage } from "@/lib/nfc/sun";

const redis = Redis.fromEnv();
const tapLimit = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, "1 m"), prefix: "rl:tap" });
const tapSecret = new TextEncoder().encode(process.env.TAP_TOKEN_SECRET!);

type CachedTag = { id: string; restaurantId: string; slug: string; kind: "nfc" | "nfc_sun" | "qr" };

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname, searchParams } = req.nextUrl;
  if (!pathname.startsWith("/t/")) return updateSupabaseSession(req);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  if (!(await tapLimit.limit(ip)).success) return new NextResponse("Too many requests", { status: 429 });

  const code = pathname.slice(3);
  const tag = await resolveTag(code);
  if (!tag) return NextResponse.redirect(new URL("/tag-not-found", req.url));

  let sunVerified = false;
  if (tag.kind === "nfc_sun") {
    sunVerified = await verifySunMessage(tag.id, searchParams.get("p"), searchParams.get("c"));
  }

  const res = NextResponse.redirect(new URL(`/r/${tag.slug}?from=tap`, req.url), 307);

  const deviceId = req.cookies.get("lp_device")?.value ?? crypto.randomUUID();
  res.cookies.set("lp_device", deviceId, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });

  const tapToken = await new SignJWT({ tagId: tag.id, rid: tag.restaurantId, sun: sunVerified })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(tapSecret);
  res.cookies.set("lp_tag", tapToken, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });

  // Tap logging runs after the response is sent, so it never delays the redirect.
  event.waitUntil(fetch(new URL("/api/internal/tap", req.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY! },
    body: JSON.stringify({ tagId: tag.id, restaurantId: tag.restaurantId, deviceId, sunVerified, ip }),
  }).catch(() => {}));

  return res;
}

async function resolveTag(code: string): Promise<CachedTag | null> {
  if (!/^[A-Za-z0-9]{6,8}$/.test(code)) return null;
  const cached = await redis.get<CachedTag>(`tag:${code}`);
  if (cached) return cached;

  const url = `${process.env.SUPABASE_URL}/rest/v1/tags?code=eq.${code}&is_active=eq.true&select=id,kind,restaurant_id,restaurants(slug)`;
  const rows = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  }).then((r) => r.json());
  const row = rows?.[0];
  if (!row) return null;

  const tag: CachedTag = { id: row.id, restaurantId: row.restaurant_id, slug: row.restaurants.slug, kind: row.kind };
  await redis.set(`tag:${code}`, tag, { ex: 3600 });
  return tag;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|webp)$).*)"] };
```

### 11.2 Check-in domain service

```ts
// packages/core/visits/check-in.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@loyalty/db";
import type { Inngest } from "inngest";

export type CheckInInput = {
  customerId: string;
  restaurantId: string;
  tap: { tagId: string; sun: boolean };
  geo?: { lat: number; lng: number };
};

export type CheckInResult =
  | { status: "confirmed"; visitId: string }
  | { status: "pending"; visitId: string; reason: "needs_staff" }
  | { status: "cooldown"; nextEligibleAt: string };

export async function checkIn(
  db: SupabaseClient<Database>, // service-role client
  events: Inngest,
  lock: (key: string, ttlSec: number) => Promise<boolean>,
  input: CheckInInput,
): Promise<CheckInResult> {
  const { data: restaurant } = await db.from("restaurants").select("settings").eq("id", input.restaurantId).single();
  const cooldownMin: number = restaurant!.settings.visit_cooldown_minutes;

  const membership = await ensureMembership(db, input.customerId, input.restaurantId, input.tap.tagId);

  // Atomic per-member lock stops double taps from creating two visits.
  if (!(await lock(`checkin:${membership.id}`, cooldownMin * 60))) {
    const last = membership.last_visit_at ? new Date(membership.last_visit_at).getTime() : Date.now();
    const next = new Date(last + cooldownMin * 60_000);
    return { status: "cooldown", nextEligibleAt: next.toISOString() };
  }

  const { data: tag } = await db.from("tags").select("location_id, locations(lat,lng,geofence_m)").eq("id", input.tap.tagId).single();
  const inGeofence = input.geo && tag?.locations ? withinMeters(input.geo, tag.locations) : false;
  const confirmed = input.tap.sun || inGeofence;

  const { data: visit } = await db
    .from("visits")
    .insert({
      restaurant_id: input.restaurantId,
      location_id: tag?.location_id,
      customer_id: input.customerId,
      source: "tap",
      status: confirmed ? "confirmed" : "pending",
    })
    .select("id")
    .single();

  if (confirmed) {
    await events.send({ name: "visit.confirmed", data: { visitId: visit!.id, membershipId: membership.id } });
    return { status: "confirmed", visitId: visit!.id };
  }
  return { status: "pending", visitId: visit!.id, reason: "needs_staff" };
}

function withinMeters(a: { lat: number; lng: number }, loc: { lat: number | null; lng: number | null; geofence_m: number }) {
  if (loc.lat == null || loc.lng == null) return false;
  const R = 6_371_000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(loc.lat - a.lat), dLng = toRad(loc.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(loc.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) <= loc.geofence_m;
}

async function ensureMembership(db: SupabaseClient<Database>, customerId: string, restaurantId: string, tagId: string) {
  // ON CONFLICT DO NOTHING keeps the original joined_via_tag_id for returning members.
  await db
    .from("memberships")
    .upsert(
      { customer_id: customerId, restaurant_id: restaurantId, joined_via_tag_id: tagId },
      { onConflict: "restaurant_id,customer_id", ignoreDuplicates: true },
    );
  const { data } = await db
    .from("memberships")
    .select("id, last_visit_at")
    .eq("customer_id", customerId)
    .eq("restaurant_id", restaurantId)
    .single();
  return data!;
}
```

### 11.3 Route handler: thin and validated

```ts
// apps/web/app/api/v1/visits/check-in/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { jwtVerify } from "jose";
import { createServerClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { inngest } from "@loyalty/jobs/client";
import { redisLock } from "@/lib/redis";
import { checkIn } from "@loyalty/core/visits/check-in";

const Body = z.object({
  restaurantId: z.string().uuid(),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});

export async function POST(req: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "invalid_body", details: parsed.error.flatten() } }, { status: 400 });

  const tapCookie = (await cookies()).get("lp_tag")?.value;
  if (!tapCookie) return NextResponse.json({ error: { code: "no_recent_tap" } }, { status: 400 });

  const { payload } = await jwtVerify(tapCookie, new TextEncoder().encode(process.env.TAP_TOKEN_SECRET!));
  if (payload.rid !== parsed.data.restaurantId) return NextResponse.json({ error: { code: "tag_mismatch" } }, { status: 400 });

  const result = await checkIn(adminClient(), inngest, redisLock, {
    customerId: user.id,
    restaurantId: parsed.data.restaurantId,
    tap: { tagId: payload.tagId as string, sun: Boolean(payload.sun) },
    geo: parsed.data.geo,
  });

  (await cookies()).delete("lp_tag"); // one tap → at most one check-in
  return NextResponse.json(result);
}
```

### 11.4 Visit workflow (Inngest)

```ts
// packages/jobs/visit-confirmed.ts
import { inngest } from "./client";
import { adminClient } from "./db";
import { pointsForVisit, nextStreak, tierFor } from "@loyalty/core/loyalty";
import { evaluateChallenges } from "@loyalty/core/challenges";
import { recomputeFeatures } from "@loyalty/core/ai/features";

export const onVisitConfirmed = inngest.createFunction(
  { id: "visit-confirmed", concurrency: { key: "event.data.membershipId", limit: 1 } },
  { event: "visit.confirmed" },
  async ({ event, step }) => {
    const db = adminClient();
    const { visitId, membershipId } = event.data;

    const ctx = await step.run("load", async () => {
      const { data } = await db.from("memberships")
        .select("*, restaurants(settings), visits!inner(id, visited_at, spend_cents)")
        .eq("id", membershipId).eq("visits.id", visitId).single();
      return data!;
    });

    await step.run("points", () =>
      db.rpc("award_points", {
        p_membership_id: membershipId,
        p_delta: pointsForVisit(ctx.restaurants.settings, ctx.visits[0].spend_cents),
        p_reason: "visit", p_ref_type: "visit", p_ref_id: visitId,
        p_idempotency_key: `visit:${visitId}`,
      }),
    );

    const streak = await step.run("streak-and-tier", async () => {
      const s = nextStreak(ctx, ctx.restaurants.settings.streak_window_days);
      const tier = tierFor(ctx.visit_count + 1, ctx.restaurants.settings.tiers);
      await db.from("memberships").update({
        visit_count: ctx.visit_count + 1,
        current_streak: s.current,
        longest_streak: Math.max(s.current, ctx.longest_streak),
        last_visit_at: ctx.visits[0].visited_at,
        tier,
      }).eq("id", membershipId);
      return { ...s, tierUpgraded: tier !== ctx.tier, tier };
    });

    const completed = await step.run("challenges", () => evaluateChallenges(db, membershipId, visitId));
    await step.run("features", () => recomputeFeatures(db, membershipId));

    // In-the-moment surprises (milestones, first visit back after a win-back, etc.)
    await step.sendEvent("maybe-surprise", {
      name: "ai.realtime.evaluate",
      data: { membershipId, trigger: { visitId, streak, completed } },
    });
  },
);
```

### 11.5 AI offer generation (Claude, structured output)

```ts
// packages/core/ai/generate-offer.ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export const OfferSchema = z.object({
  templateId: z.string(),
  title: z.string().max(40),
  message: z.string().max(160),
  sendAtLocal: z.string().describe("HH:MM in the restaurant's timezone, between 09:00 and 20:00"),
  challenge: z
    .object({
      title: z.string().max(40),
      rule: z.object({ type: z.enum(["visit_count", "try_items", "time_window", "streak"]) }).passthrough(),
    })
    .nullable(),
  rationale: z.string().describe("One or two sentences for the owner explaining the choice"),
  confidence: z.number().min(0).max(1),
});
export type Offer = z.infer<typeof OfferSchema>;

export type OfferContext = {
  restaurant: { name: string; voice: string; ownerPreferences: string[] };
  member: {
    firstName: string | null;
    segment: string;
    tier: string;
    streak: number;
    recencyDays: number;
    avgGapDays: number | null;
    favouriteItems: string[];
    preferredDaypart: string | null;
    rewardResponseRate: number | null;
  };
  offerType: "winback" | "surprise" | "vip" | "streak" | "challenge" | "birthday";
  eligibleTemplates: { id: string; name: string; kind: string; value: number | null; item: string | null }[];
};

// Stable per restaurant, so this prefix is cached across every member in a nightly run.
function systemPrompt(r: OfferContext["restaurant"]) {
  return [
    `You write loyalty offers for ${r.name}, a restaurant. Brand voice: ${r.voice}.`,
    "Pick exactly one reward template from the eligible list and write a short, warm, specific message that",
    "references what this guest actually likes. Never invent discounts, prices or items that are not in the",
    "chosen template. Keep the message SMS-safe (no links, at most 160 characters). Do not mention data",
    "tracking, churn or how long the guest has been away in a guilt-inducing way.",
    r.ownerPreferences.length ? `Owner preferences: ${r.ownerPreferences.join("; ")}.` : "",
  ].join(" ");
}

export async function generateOffer(ctx: OfferContext): Promise<Offer | null> {
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(OfferSchema) },
    system: [{ type: "text", text: systemPrompt(ctx.restaurant), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: JSON.stringify({ offerType: ctx.offerType, member: ctx.member, eligibleTemplates: ctx.eligibleTemplates }),
      },
    ],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) return null; // caller falls back to template copy
  const offer = response.parsed_output;

  // Defence in depth: the model may only choose from what the rules allowed.
  if (!ctx.eligibleTemplates.some((t) => t.id === offer.templateId)) return null;
  return offer;
}
```

> The nightly job sends the same request shape through `client.messages.batches.create(...)`
> (`custom_id = membershipId`) for 50% lower cost, then maps results back by `custom_id`.
> Every result passes through `applyGuardrails()` (§9.6) before an `ai_recommendations` row is written.

### 11.6 Guardrails

```ts
// packages/core/ai/guardrails.ts
import type { Offer } from "./generate-offer";

type Guard = {
  settings: { max_discount_percent: number; max_offers_per_customer_per_week: number; monthly_reward_budget: number };
  template: { kind: string; value: number | null; cost_estimate_cents: number; min_tier: string; is_active: boolean; ai_eligible: boolean };
  memberTier: string;
  offersThisWeek: number;
  spentThisMonthCents: number;
};

const TIER_ORDER = ["member", "regular", "vip", "legend"];
const MONEY_OR_PERCENT = /(\d+\s*%|[$£€]\s*\d+)/;

export function applyGuardrails(offer: Offer, g: Guard): { ok: true } | { ok: false; reason: string } {
  const t = g.template;
  if (!t.is_active || !t.ai_eligible) return { ok: false, reason: "template_not_eligible" };
  if (t.kind === "percent_off" && (t.value ?? 0) > g.settings.max_discount_percent) return { ok: false, reason: "discount_cap" };
  if (TIER_ORDER.indexOf(g.memberTier) < TIER_ORDER.indexOf(t.min_tier)) return { ok: false, reason: "tier" };
  if (g.offersThisWeek >= g.settings.max_offers_per_customer_per_week) return { ok: false, reason: "frequency_cap" };
  if (g.spentThisMonthCents + t.cost_estimate_cents > g.settings.monthly_reward_budget * 100) return { ok: false, reason: "budget" };

  // The copy may only state the template's own value.
  const claimed = offer.message.match(MONEY_OR_PERCENT)?.[0];
  if (claimed && t.value != null && !claimed.includes(String(t.value))) return { ok: false, reason: "copy_value_mismatch" };

  const [h, m] = offer.sendAtLocal.split(":").map(Number);
  if (!(h >= 9 && (h < 20 || (h === 20 && m === 0)))) return { ok: false, reason: "quiet_hours" };
  return { ok: true };
}
```

### 11.7 Customer landing page (RSC + client island)

```tsx
// apps/web/app/r/[slug]/page.tsx
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { getHome } from "@loyalty/db/queries/home";
import { PointsCard } from "@/components/points-card";
import { StreakFlame } from "@/components/streak-flame";
import { RewardCarousel } from "@/components/reward-carousel";
import { ChallengeList } from "@/components/challenge-list";
import { CheckInCelebration } from "@/components/check-in-celebration";

export default async function LoyaltyHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { slug } = await params;
  const { from } = await searchParams;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/r/${slug}/login${from === "tap" ? "?from=tap" : ""}`);

  const home = await getHome(supabase, slug); // single RLS-scoped query; see GET /me/memberships/{rid}/home

  return (
    <main
      className="mx-auto min-h-dvh max-w-md bg-neutral-50 px-4 pb-24 pt-[max(1rem,env(safe-area-inset-top))]"
      style={{ ["--brand" as string]: home.restaurant.brandColor }}
    >
      {from === "tap" && <CheckInCelebration restaurantId={home.restaurant.id} />}
      <header className="mb-4 flex items-center gap-3">
        <img src={home.restaurant.logoUrl ?? ""} alt="" className="h-10 w-10 rounded-full" />
        <h1 className="text-lg font-semibold">Hey {home.customer.firstName ?? "there"} 👋</h1>
      </header>

      <PointsCard balance={home.membership.points} tier={home.membership.tier} nextTier={home.nextTier} />
      <StreakFlame streak={home.membership.streak} expiresAt={home.membership.streakExpiresAt} />

      {home.featuredRewards.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Just for you</h2>
          <RewardCarousel rewards={home.featuredRewards} />
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-medium text-neutral-500">Challenges</h2>
        <ChallengeList challenges={home.challenges} />
      </section>
    </main>
  );
}
```

```tsx
// apps/web/components/check-in-celebration.tsx
"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Result =
  | { status: "confirmed"; pointsAwarded?: number }
  | { status: "pending" }
  | { status: "cooldown"; nextEligibleAt: string };

export function CheckInCelebration({ restaurantId }: { restaurantId: string }) {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/visits/check-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantId }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setResult)
      .catch(() => {});
    window.history.replaceState(null, "", window.location.pathname); // drop ?from=tap so a refresh doesn't re-check-in
    return () => controller.abort();
  }, [restaurantId]);

  return (
    <AnimatePresence>
      {result?.status === "confirmed" && (
        <motion.div
          initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}
          className="mb-4 rounded-2xl bg-[var(--brand)] p-4 text-center text-white shadow-lg"
        >
          <p className="text-2xl font-bold">Checked in! 🎉</p>
          {result.pointsAwarded ? <p>+{result.pointsAwarded} points</p> : null}
        </motion.div>
      )}
      {result?.status === "pending" && (
        <motion.div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-center">
          Show this screen to a team member to confirm your visit.
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

> Points arrive asynchronously through the `visit.confirmed` workflow. The page subscribes to
> Supabase Realtime (`membership:{id}`) and animates the balance when the ledger update lands, so
> the UI shows the celebration immediately and the number catches up within about a second.

### 11.8 Nightly AI job (Inngest cron + batches)

```ts
// packages/jobs/nightly-ai.ts
import Anthropic from "@anthropic-ai/sdk";
import { inngest } from "./client";
import { adminClient } from "./db";
import { buildCandidates } from "@loyalty/core/ai/candidates";
import { buildOfferRequest, parseOfferResult } from "@loyalty/core/ai/batch";
import { persistRecommendations } from "@loyalty/core/ai/persist";

const anthropic = new Anthropic();

export const nightlyAi = inngest.createFunction(
  { id: "nightly-ai-offers" },
  { cron: "TZ=UTC 0 * * * *" }, // hourly; each run picks restaurants whose local time is 03:00
  async ({ step }) => {
    const restaurants = await step.run("due-restaurants", () => dueRestaurants(adminClient(), 3));

    for (const r of restaurants) {
      const candidates = await step.run(`candidates-${r.id}`, () => buildCandidates(adminClient(), r.id));
      if (candidates.length === 0) continue;

      const batch = await step.run(`submit-${r.id}`, () =>
        anthropic.messages.batches.create({
          requests: candidates.map((c) => ({ custom_id: c.membershipId, params: buildOfferRequest(r, c) })),
        }),
      );

      // Durable wait: Inngest sleeps for free between polls.
      let status = batch.processing_status;
      while (status !== "ended") {
        await step.sleep(`wait-${r.id}-${Date.now()}`, "10m");
        status = (await step.run(`poll-${r.id}`, () => anthropic.messages.batches.retrieve(batch.id))).processing_status;
      }

      await step.run(`persist-${r.id}`, async () => {
        const results = [];
        for await (const item of await anthropic.messages.batches.results(batch.id)) {
          results.push({ membershipId: item.custom_id, offer: parseOfferResult(item) }); // keyed by custom_id, never position
        }
        return persistRecommendations(adminClient(), r, candidates, results); // applies guardrails, auto-issue
      });
    }
  },
);
```

---

## 12. Security, privacy and abuse prevention

| Risk | Mitigation |
| --- | --- |
| Tag URL shared or photographed for remote check-ins | Tap ≠ visit (§6.4), SUN tags, geofence, cooldown, POS match, staff PIN |
| OTP pumping / SMS toll fraud | Rate limits per phone, IP and device; Twilio Verify fraud guard; geo-permissions limited to the countries the restaurant operates in; Turnstile CAPTCHA after 2 attempts |
| Points manipulation | Value changes only server-side through `award_points()` with idempotency keys; customers have read-only RLS; adjustments need manager role and are audited |
| Reward code reuse | Single-use `redeem_code`, 10-minute activation window, redemption requires staff authentication, row lock on redeem |
| Cross-tenant data leaks | RLS on every table, `is_staff(restaurant_id)`, pgTAP tests asserting isolation, and the service role used only in server code |
| Prompt injection via customer data | Only structured fields reach the LLM (no free text from customers), output is schema-validated, and guardrails run in code |
| PII exposure to the LLM | First name only, no phone or email, no exact timestamps; Anthropic API zero-retention options where required |
| Privacy compliance (GDPR/CCPA/TCPA) | Explicit marketing opt-in per restaurant, STOP handling via the Twilio webhook, data export and erasure endpoints, retention policy (raw taps deleted after 13 months) |
| Webhook spoofing | HMAC signature verification (Square, Toast, Twilio, Resend), replay window, idempotent processing |
| Secrets | Vercel encrypted environment variables per environment; the service-role key is never exposed to the client (`server-only` import guard) |

---

## 13. Deployment plan

### 13.1 Environments

| Env | Frontend / API | Database | Notes |
| --- | --- | --- | --- |
| **Local** | `pnpm dev` | `supabase start` (Docker) | Inngest dev server, seed data, Twilio test credentials |
| **Preview** | Vercel preview per PR | Supabase **branching** (an ephemeral database per PR, migrations applied automatically) | Playwright E2E runs against the preview URL |
| **Staging** | `staging.lp.app` | Supabase staging project | Production-like, with anonymised production snapshot |
| **Production** | `lp.app` + custom domains per restaurant (optional) | Supabase Pro, PITR enabled, same region as the Vercel functions | |

### 13.2 Vercel configuration

- **Edge runtime**: `middleware.ts` (tap resolution, session refresh).
- **Node.js serverless (Fluid compute)**: `/api/v1/*`, webhooks, `/api/inngest`. Pin the function region to match Supabase (for example `iad1` with Supabase `us-east-1`) so database round trips are under 5 ms.
- **ISR / static**: marketing pages and `/r/[slug]` public branding (`revalidateTag('restaurant:{id}')` on settings change).
- **Cron**: Inngest handles schedules. As a backup, `vercel.json` crons hit `/api/cron/*` (protected by `CRON_SECRET`) for nightly feature recomputation and reward expiry.
- **Integrations** (Vercel Marketplace): Supabase, Upstash and Inngest, so environment variables are injected automatically.

```jsonc
// vercel.json
{
  "regions": ["iad1"],
  "crons": [
    { "path": "/api/cron/expire-rewards", "schedule": "15 * * * *" },
    { "path": "/api/cron/recompute-features", "schedule": "0 2 * * *" }
  ],
  "functions": {
    "app/api/inngest/route.ts": { "maxDuration": 300 },
    "app/api/webhooks/**/route.ts": { "maxDuration": 30 }
  }
}
```

### 13.3 Environment variables

```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
ANTHROPIC_API_KEY
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID, TWILIO_MESSAGING_SID
RESEND_API_KEY
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
SQUARE_WEBHOOK_SIGNATURE_KEY, TOAST_WEBHOOK_SECRET
TAP_TOKEN_SECRET, INTERNAL_API_KEY, CRON_SECRET, SUN_MASTER_KEY
SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY
```

### 13.4 CI/CD (GitHub Actions + Vercel)

```
PR opened
 ├─ lint (eslint, prettier) · typecheck (tsc --noEmit) · vitest (packages/core)
 ├─ supabase db lint · pgTAP RLS tests against `supabase start`
 ├─ Vercel preview deploy + Supabase preview branch
 └─ Playwright (iPhone 15 + Pixel 8 viewports): tap → OTP (test number) → check-in → redeem
merge to main
 ├─ supabase db push (migrations) to staging → smoke tests
 └─ manual promote → supabase db push (prod) → vercel --prod
```

Migrations must be **backwards compatible** (expand → migrate → contract) so that a new database schema works with the previous app version during rollout and instant rollback on Vercel.

### 13.5 Scaling notes

| Concern | Approach |
| --- | --- |
| Tap spikes (lunch rush) | Edge middleware plus a Redis tag cache keep the tap path off Postgres. Tap logging is asynchronous. |
| Database connections from serverless | Supabase **Supavisor** transaction pooler (port 6543) for serverless functions |
| Analytics queries | Materialised views refreshed nightly (`mv_daily_restaurant_kpis`). Move to a read replica at scale. |
| AI cost | Nightly batches at 50% cost, prompt caching of the restaurant prefix, low effort, only candidates that pass rules reach the LLM, and per-restaurant monthly token budgets |
| Messaging | Inngest throttling per restaurant (for example 10 SMS/s) respects carrier limits |

---

## 14. Observability, testing and roadmap

**Observability.** Sentry (errors and traces, tagged by `restaurant_id`), Vercel Speed Insights (Core Web Vitals on `/r/*`), PostHog funnels (tap → login → check-in → redeem), Inngest run dashboards, and AI metrics (guardrail rejection rate, approval rate, cost per offer, lift against holdout).

**Testing pyramid.**
- Unit (Vitest): points, streak, tier and challenge DSL; guardrails; feature maths.
- Database (pgTAP): RLS isolation between tenants and roles; `award_points` idempotency.
- Contract: Zod schemas shared between API and client; POS webhook fixtures.
- AI evals: a fixed set of about 50 member profiles. Assert valid JSON, eligible template, copy within length, no invented values, and tone rubric scores. Run on every prompt change.
- E2E (Playwright, mobile viewports): the full tap-to-redeem journey.

**Delivery roadmap.**

| Phase | Weeks | Scope |
| --- | --- | --- |
| **MVP** | 1–4 | QR/NFC tap, phone OTP, points and tiers, reward catalogue and redemption, staff mode, basic dashboard |
| **Engagement** | 5–7 | Streaks, challenges (DSL), Realtime celebrations, PWA and web push |
| **Intelligence** | 8–10 | POS integration (Square first), feature pipeline, segments, AI offers with owner approval, win-back campaigns via SMS |
| **Scale** | 11–13 | SUN NFC tags, holdout-based lift reporting, bandit template selection, auto-issue mode, multi-location chains |
| **Later** | | Apple/Google Wallet passes, churn ML model v2, referral programme, native app (same API), white-label custom domains |
