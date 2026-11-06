import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createUserClient } from "@/lib/supabase/server";

/** Print-ready SVG QR code for a tag's tap URL. Staff only (enforced by RLS on tags). */
export async function GET(request: NextRequest, ctx: RouteContext<"/admin/[restaurantId]/tags/[tagId]/qr">) {
  const { restaurantId, tagId } = await ctx.params;
  const supabase = await createUserClient();
  const { data: tag } = await supabase
    .from("tags")
    .select("code")
    .eq("id", tagId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle<{ code: string }>();
  if (!tag) return new NextResponse("Not found", { status: 404 });

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin;
  const svg = await QRCode.toString(`${origin}/t/${tag.code}`, { type: "svg", margin: 2, width: 600, errorCorrectionLevel: "M" });
  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "content-disposition": `attachment; filename="qr-${tag.code}.svg"`,
      "cache-control": "private, no-store",
    },
  });
}
