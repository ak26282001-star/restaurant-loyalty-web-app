import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase session cookie on every page request, so Server
 * Components (which can't write cookies) always see a valid session.
 */
let warned = false;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    // Don't take the whole site down: pages that need Supabase will report the problem, and /api/health explains it.
    if (!warned) console.error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or ..._PUBLISHABLE_KEY), then redeploy");
    warned = true;
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Validates and, when needed, refreshes the session. Must run before any response is returned.
  await supabase.auth.getClaims();
  return response;
}

export const config = {
  // Skip static assets and the tap entry point (it sets its own cookies and redirects).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|t/|.*\\.(?:png|svg|jpg|jpeg|webp|ico)$).*)"],
};
