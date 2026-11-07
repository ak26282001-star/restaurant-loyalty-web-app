import { NextResponse, after, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { exchangeCode, saveTokens, type Connection } from "@/lib/clover/client";
import { cloverAppCredentials, cloverEnvironment } from "@/lib/clover/config";
import { CONNECT_COOKIE, verifyConnect } from "@/lib/clover/connect-cookie";
import { syncMenu } from "@/lib/clover/sync";

/** Clover redirects here with ?merchant_id&client_id&code after the merchant approves the app. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const merchantId = params.get("merchant_id");
  const code = params.get("code");
  const binding = await verifyConnect(request.cookies.get(CONNECT_COOKIE)?.value);

  // Installed straight from the Clover App Market: we don't know which restaurant this is for.
  if (!binding) return NextResponse.redirect(new URL("/admin?error=clover_start_from_dashboard", request.url));
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/admin/${binding.restaurantId}/pos?${q}`, request.url));
    res.cookies.delete({ name: CONNECT_COOKIE, path: "/api/pos/clover" });
    return res;
  };

  const app = cloverAppCredentials();
  if (!app || !merchantId || !code || !/^[A-Z0-9]{8,20}$/.test(merchantId) || params.get("client_id") !== app.appId) {
    return back("error=bad_callback");
  }

  // The person finishing the flow must be the owner who started it.
  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== binding.userId) return back("error=session_changed");

  let tokens;
  try {
    tokens = await exchangeCode(cloverEnvironment(), code);
  } catch (e) {
    console.error("clover token exchange failed", e);
    return back("error=token_exchange");
  }

  const db = adminClient();
  const { data: existing } = await db.from("pos_connections").select("id, restaurant_id").eq("provider", "clover").eq("merchant_id", merchantId).maybeSingle();
  if (existing && existing.restaurant_id !== binding.restaurantId) return back("error=merchant_in_use");

  const { data: conn, error } = await db
    .from("pos_connections")
    .upsert(
      {
        id: existing?.id,
        restaurant_id: binding.restaurantId,
        location_id: binding.locationId,
        provider: "clover",
        environment: cloverEnvironment(),
        merchant_id: merchantId,
        status: "active",
        connected_by: user.id,
        connected_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "provider,merchant_id" },
    )
    .select("id, restaurant_id, location_id, environment, merchant_id")
    .single<Connection>();
  if (error || !conn) return back("error=save_failed");
  await saveTokens(db, conn.id, tokens);

  after(async () => {
    try {
      await syncMenu(conn);
    } catch (e) {
      await adminClient().from("pos_connections").update({ last_error: `Menu sync failed: ${(e as Error).message}` }).eq("id", conn.id);
    }
  });
  return back("connected=1");
}
