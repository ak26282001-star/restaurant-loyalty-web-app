import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase/admin";
import { runOffers } from "@/lib/ai/run";

export const maxDuration = 300;

function authorised(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return Boolean(secret) && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Nightly: refresh customer features and propose AI offers for every restaurant. */
export async function GET(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  const { data: restaurants } = await adminClient().from("restaurants").select("id");
  const results: Record<string, unknown> = {};
  for (const r of restaurants ?? []) {
    try {
      results[r.id] = await runOffers(r.id);
    } catch (e) {
      console.error("offer run failed", r.id, e);
      results[r.id] = { error: (e as Error).message };
    }
  }
  return NextResponse.json(results);
}
