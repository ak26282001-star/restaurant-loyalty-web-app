import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase session cookie on every page request, so Server
 * Components (which can't write cookies) always see a valid session.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
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
