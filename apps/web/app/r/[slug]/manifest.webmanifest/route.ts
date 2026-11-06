import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";

/** Per-restaurant web app manifest, so "Add to Home Screen" opens that restaurant's page with its name and colour. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/r/[slug]/manifest.webmanifest">) {
  const { slug } = await ctx.params;
  // Public branding only, read with the anon key (RLS allows public read of restaurants).
  const supabase = createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, { auth: { persistSession: false } });
  const { data: r } = await supabase.from("restaurants").select("name, slug, brand_color").eq("slug", slug).maybeSingle();
  if (!r) return new NextResponse("Not found", { status: 404 });

  const manifest = {
    id: `/r/${r.slug}`,
    name: `${r.name} Rewards`,
    short_name: r.name.slice(0, 12),
    start_url: `/r/${r.slug}?source=pwa`,
    scope: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: r.brand_color ?? "#E4572E",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return NextResponse.json(manifest, {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" },
  });
}
