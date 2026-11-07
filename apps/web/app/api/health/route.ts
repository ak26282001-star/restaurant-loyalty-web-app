import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { configProblems, publicEnv } from "@/lib/env";

// One table per migration: if a table is missing, that SQL hasn't been run on this database.
const MIGRATIONS = [
  { name: "0001+0002 setup", table: "restaurants" },
  { name: "0003 Phase 2", table: "push_subscriptions" },
  { name: "0004 Phase 3", table: "pos_connections" },
] as const;

/**
 * GET /api/health: what's misconfigured, in plain words. Reports setting names and yes/no only,
 * never values, so it is safe to open in a browser.
 */
export async function GET() {
  const problems = configProblems();
  const optional = {
    push_reminders: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    cron_secret: Boolean(process.env.CRON_SECRET),
    clover: Boolean(process.env.CLOVER_APP_ID && process.env.CLOVER_APP_SECRET && process.env.CLOVER_WEBHOOK_AUTH_CODE && process.env.TOKEN_ENCRYPTION_KEY),
    ai_copywriting: Boolean(process.env.ANTHROPIC_API_KEY),
    rate_limiting: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  };

  // NEXT_PUBLIC_* values are baked in at build time. If they're set now but weren't at build, redeploy.
  const builtWithSupabase = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseAnonKey);
  if (!builtWithSupabase && !problems.some((p) => p.startsWith("NEXT_PUBLIC"))) {
    problems.push("NEXT_PUBLIC_* Supabase settings were added after this build: redeploy so they take effect");
  }

  const database: { reachable: boolean; migrations: Record<string, boolean>; error?: string } = { reachable: false, migrations: {} };
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && serviceKey) {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
    for (const m of MIGRATIONS) {
      // A zero-row GET, not a HEAD: on HEAD the "table not found" code only comes back as a header,
      // which supabase-js doesn't surface as an error.
      const { error } = await db.from(m.table).select("*").limit(0);
      if (!error) {
        database.reachable = true;
        database.migrations[m.name] = true;
      } else if (error.code === "PGRST205" || error.code === "42P01") {
        database.reachable = true; // the API answered; the table just isn't there
        database.migrations[m.name] = false;
      } else {
        database.error = error.code === "PGRST301" || /JWT|apikey|Invalid API key/i.test(error.message)
          ? "Supabase rejected the service key: check SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY"
          : `Could not query Supabase (${error.code || "network error"})`;
        break;
      }
    }
    // pos_credentials is readable by the service role only, so this catches a publishable/anon key
    // pasted into SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) by mistake.
    if (!database.error && database.migrations["0004 Phase 3"]) {
      const { error } = await db.from("pos_credentials").select("connection_id").limit(0);
      if (error?.code === "42501") database.error = "SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY is not the secret (service role) key";
    }
    for (const [name, ok] of Object.entries(database.migrations)) if (!ok) problems.push(`Database is missing migration ${name}: run its SQL in the Supabase SQL editor`);
    if (database.error) problems.push(database.error);
  }

  const ok = problems.length === 0;
  return NextResponse.json({ ok, problems, optional, database }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
