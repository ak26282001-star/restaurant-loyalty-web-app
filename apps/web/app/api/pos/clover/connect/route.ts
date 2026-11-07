import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";
import { authorizeUrl } from "@/lib/clover/client";
import { cloverConfigured, cloverEnvironment, siteUrl } from "@/lib/clover/config";
import { CONNECT_COOKIE, signConnect } from "@/lib/clover/connect-cookie";

/** Owner starts the Clover connection: remember who and which restaurant, then go to Clover. */
export async function GET(request: NextRequest) {
  const restaurantId = z.guid().safeParse(request.nextUrl.searchParams.get("restaurantId"));
  if (!restaurantId.success) return NextResponse.redirect(new URL("/admin", request.url));
  const back = new URL(`/admin/${restaurantId.data}/pos`, request.url);
  if (!cloverConfigured()) return NextResponse.redirect(new URL(`${back.pathname}?error=not_configured`, request.url));

  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(back.pathname)}`, request.url));
  const { data: staff } = await supabase
    .from("staff_members").select("role").eq("restaurant_id", restaurantId.data).eq("user_id", user.id).maybeSingle();
  if (staff?.role !== "owner") return NextResponse.redirect(new URL("/admin?error=forbidden", request.url));

  const { data: location } = await supabase.from("locations").select("id").eq("restaurant_id", restaurantId.data).limit(1).maybeSingle();
  const redirectUri = `${siteUrl(request.nextUrl.origin)}/api/pos/clover/callback`;
  const response = NextResponse.redirect(authorizeUrl(cloverEnvironment(), redirectUri));
  response.cookies.set(CONNECT_COOKIE, await signConnect({ restaurantId: restaurantId.data, userId: user.id, locationId: location?.id ?? null }), {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax", // sent on Clover's top-level redirect back to us
    maxAge: 15 * 60,
    path: "/api/pos/clover",
  });
  return response;
}
