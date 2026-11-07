import { NextResponse, after, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase/admin";
import type { Connection } from "@/lib/clover/client";
import { processOrder, syncMenu } from "@/lib/clover/sync";
import { WebhookPayload } from "@/lib/clover/types";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

function sameSecret(a: string | null, b: string | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Clover webhooks. Clover authenticates each delivery with the app's auth code in
 * X-Clover-Auth; the very first request (dashboard setup) carries only a verificationCode.
 * Respond 200 quickly and do the work after the response.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = WebhookPayload.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });

  if ("verificationCode" in parsed.data) {
    // Unauthenticated by design (Clover sends it before the auth code exists), so keep it cheap to abuse.
    if (!(await rateLimiter("clover-verify", 10, "1 h").limit(clientIp(request.headers))).success) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    // Shown nowhere publicly: read it from the database (see README) and paste it into Clover.
    await adminClient().from("pos_webhook_verifications").insert({ provider: "clover", code: parsed.data.verificationCode });
    console.info("Clover webhook verification code received; see pos_webhook_verifications");
    return NextResponse.json({ ok: true });
  }

  if (!sameSecret(request.headers.get("x-clover-auth"), process.env.CLOVER_WEBHOOK_AUTH_CODE)) {
    return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  }
  if (parsed.data.appId !== process.env.CLOVER_APP_ID) return NextResponse.json({ error: { code: "wrong_app" } }, { status: 400 });

  const merchants = parsed.data.merchants;
  after(() => handleUpdates(merchants));
  return NextResponse.json({ ok: true });
}

async function handleUpdates(merchants: Record<string, { objectId: string; type: "CREATE" | "UPDATE" | "DELETE"; ts: number }[]>) {
  const db = adminClient();
  for (const [merchantId, updates] of Object.entries(merchants)) {
    const { data: conn } = await db
      .from("pos_connections")
      .select("id, restaurant_id, location_id, environment, merchant_id, status")
      .eq("provider", "clover")
      .eq("merchant_id", merchantId)
      .maybeSingle<Connection & { status: string }>();
    if (!conn || conn.status === "disconnected") continue;
    await db.from("pos_connections").update({ last_webhook_at: new Date().toISOString() }).eq("id", conn.id);

    let menuChanged = false;
    for (const u of updates) {
      // Claim the event; a retried delivery of the same event is skipped.
      const { data: claimed } = await db
        .from("pos_webhook_log")
        .upsert(
          { provider: "clover", restaurant_id: conn.restaurant_id, merchant_id: merchantId, object_id: u.objectId, event_type: u.type, event_ts: u.ts },
          { onConflict: "provider,merchant_id,object_id,event_type,event_ts", ignoreDuplicates: true },
        )
        .select("id");
      if (!claimed?.length) continue;
      const logId = claimed[0].id;
      const [kind, objectId] = u.objectId.split(":");

      let status = "ignored";
      let detail: string | undefined;
      try {
        if (kind === "O" && u.type !== "DELETE" && objectId) {
          ({ status, detail } = await processOrder(conn, objectId));
        } else if (kind === "I") {
          menuChanged = true;
          status = "processed";
        } else if (kind === "A" && u.type === "DELETE") {
          await db.from("pos_connections").update({ status: "disconnected" }).eq("id", conn.id);
          status = "processed";
          detail = "app uninstalled";
        }
      } catch (e) {
        status = "failed";
        detail = (e as Error).message.slice(0, 300);
        await db.from("pos_connections").update({ last_error: detail }).eq("id", conn.id);
      }
      await db.from("pos_webhook_log").update({ status, detail }).eq("id", logId);
    }
    if (menuChanged) await syncMenu(conn).catch(() => {});
  }
}
