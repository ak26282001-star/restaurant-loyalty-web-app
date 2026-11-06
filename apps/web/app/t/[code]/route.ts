import { NextResponse, after, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { isValidTagCode } from "@loyalty/core";
import { adminClient } from "@/lib/supabase/admin";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { DEVICE_COOKIE, TAP_COOKIE, TAP_TOKEN_TTL_SECONDS, signTapToken } from "@/lib/tap-token";

type TagRow = { id: string; kind: "nfc" | "nfc_sun" | "qr"; restaurant_id: string; restaurants: { slug: string } };

/**
 * Entry point for every NFC tap and QR scan: /t/{code}.
 * Resolves the tag, issues a short-lived tap token cookie and redirects to the
 * restaurant's loyalty page, which performs the check-in.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/t/[code]">) {
  const { code } = await ctx.params;
  const ip = clientIp(request.headers);

  if (!(await rateLimiter("tap", 30, "1 m").limit(ip)).success) {
    return new NextResponse("Too many requests, please try again in a minute.", { status: 429 });
  }
  if (!isValidTagCode(code)) return NextResponse.redirect(new URL("/tag-not-found", request.url));

  const { data: tag } = await adminClient()
    .from("tags")
    .select("id, kind, restaurant_id, restaurants!inner(slug)")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle<TagRow>();
  if (!tag) return NextResponse.redirect(new URL("/tag-not-found", request.url));

  // NTAG 424 DNA (SUN) verification is not implemented yet, so no tap is trusted on its own.
  // Visits from taps are confirmed by geofence or by staff.
  const sunVerified = false;

  const deviceId = request.cookies.get(DEVICE_COOKIE)?.value ?? crypto.randomUUID();
  const response = NextResponse.redirect(new URL(`/r/${tag.restaurants.slug}?from=tap`, request.url), 307);
  const secure = request.nextUrl.protocol === "https:";

  response.cookies.set(DEVICE_COOKIE, deviceId, { httpOnly: true, secure, sameSite: "lax", maxAge: 60 * 60 * 24 * 365, path: "/" });
  response.cookies.set(
    TAP_COOKIE,
    await signTapToken({ tagId: tag.id, restaurantId: tag.restaurant_id, sunVerified }),
    { httpOnly: true, secure, sameSite: "lax", maxAge: TAP_TOKEN_TTL_SECONDS, path: "/" },
  );

  // Log the tap after the redirect is sent, so it never slows the customer down.
  after(async () => {
    await adminClient().from("tap_events").insert({
      tag_id: tag.id,
      restaurant_id: tag.restaurant_id,
      device_id: deviceId,
      sun_verified: sunVerified,
      ip_hash: createHash("sha256").update(ip).digest("hex"),
      user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    });
  });

  return response;
}
