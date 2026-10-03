# Restaurant Loyalty Web App

A tap-to-open loyalty platform for restaurants. Customers tap an NFC tag or scan a QR code and land
on a personalised, mobile-first loyalty page with points, streaks, challenges and AI-personalised
rewards. Owners run everything from an admin dashboard, including AI-generated offers and win-back
campaigns.

## Documents

| File | Contents |
| --- | --- |
| [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md) | Full technical plan: architecture, tech stack, API endpoints, auth, NFC/QR flow, admin dashboard, AI offer pipeline, example code and deployment |
| [`supabase/migrations/0001_initial_schema.sql`](supabase/migrations/0001_initial_schema.sql) | Postgres schema: tables, enums, indexes, Row Level Security policies and the atomic `award_points()` function |

## Stack at a glance

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind + shadcn/ui · Supabase (Postgres, Auth,
RLS, Realtime) · Upstash Redis · Inngest · Claude API · Twilio / Resend · Vercel
