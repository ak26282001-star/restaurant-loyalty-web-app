import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { mapDbError, withinGeofence, type CheckInResult } from "@loyalty/core";
import { createUserClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { TAP_COOKIE, verifyTapToken } from "@/lib/tap-token";

const Body = z.object({
  restaurantId: z.guid(),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});

const error = (code: string, status: number) => NextResponse.json({ error: { code } }, { status });

type TagLocation = { locations: { lat: number | null; lng: number | null; geofence_m: number } | null };

/** POST /api/v1/visits/check-in: turn a recent tap into a visit for the signed-in customer. */
export async function POST(request: NextRequest) {
  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return error("unauthorized", 401);

  if (!(await rateLimiter("check-in", 10, "1 m").limit(`${user.id}:${clientIp(request.headers)}`)).success) {
    return error("rate_limited", 429);
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error("invalid_body", 400);
  const { restaurantId, geo } = parsed.data;

  const cookieStore = await cookies();
  const tap = await verifyTapToken(cookieStore.get(TAP_COOKIE)?.value);
  if (!tap) return error("no_recent_tap", 400);
  if (tap.restaurantId !== restaurantId) return error("tag_mismatch", 400);

  let inGeofence = false;
  if (geo) {
    const { data } = await adminClient()
      .from("tags")
      .select("locations(lat, lng, geofence_m)")
      .eq("id", tap.tagId)
      .maybeSingle<TagLocation>();
    inGeofence = data?.locations ? withinGeofence(geo, data.locations) : false;
  }

  const { data, error: dbError } = await adminClient().rpc("check_in", {
    p_customer_id: user.id,
    p_restaurant_id: restaurantId,
    p_tag_id: tap.tagId,
    p_trusted: tap.sunVerified || inGeofence,
  });
  if (dbError) {
    const mapped = mapDbError(dbError.message);
    if (mapped.status === 500) console.error("check_in failed", dbError);
    return error(mapped.code, mapped.status);
  }

  const result = data as CheckInResult;
  // Keep the tap token while the visit is pending, so the customer can retry with location.
  if (result.status !== "pending") cookieStore.delete(TAP_COOKIE);
  return NextResponse.json(result);
}
