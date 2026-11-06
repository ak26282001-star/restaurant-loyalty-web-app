import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase/admin";
import { pushConfigured, sendPush } from "@/lib/push";

type Candidate = { membership_id: string; customer_id: string; restaurant_id: string; restaurant_name: string; restaurant_slug: string; streak: number; expires_at: string; ref: string };

function authorised(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return Boolean(secret) && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Daily job (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`): remind members whose
 * streak ends within 36 hours. Each streak is reminded once, enforced by notification_log.
 */
export async function GET(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ error: { code: "push_not_configured" } }, { status: 503 });

  const db = adminClient();
  const { data: candidates, error } = await db.rpc("streak_reminder_candidates");
  if (error) {
    console.error("streak_reminder_candidates failed", error);
    return NextResponse.json({ error: { code: "internal_error" } }, { status: 500 });
  }

  const summary = { candidates: 0, sent: 0, removed: 0, failed: 0 };
  for (const c of (candidates ?? []) as Candidate[]) {
    // Claim the reminder first; a concurrent run will hit the unique constraint and skip it.
    const { data: claimed } = await db
      .from("notification_log")
      .upsert({ membership_id: c.membership_id, kind: "streak_at_risk", ref: c.ref }, { onConflict: "membership_id,kind,ref", ignoreDuplicates: true })
      .select("id");
    if (!claimed?.length) continue;
    summary.candidates++;

    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("customer_id", c.customer_id)
      .eq("restaurant_id", c.restaurant_id);

    let sent = 0;
    for (const s of subs ?? []) {
      const result = await sendPush(s, {
        title: `🔥 Keep your ${c.streak}-visit streak`,
        body: `Visit ${c.restaurant_name} by ${new Date(c.expires_at).toLocaleDateString("en-GB", { weekday: "long" })} to keep it going.`,
        url: `/r/${c.restaurant_slug}`,
        tag: `streak-${c.membership_id}`,
      });
      if (result === "sent") {
        sent++;
        await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq("id", s.id);
      } else if (result === "gone") {
        summary.removed++;
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        summary.failed++;
      }
    }
    summary.sent += sent;
    await db.from("notification_log").update({ sent_count: sent }).eq("id", claimed[0].id);
  }

  return NextResponse.json(summary);
}
