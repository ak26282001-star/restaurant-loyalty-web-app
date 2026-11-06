import "server-only";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/** Supabase client acting as the signed-in user, so Postgres RLS applies. */
export async function createUserClient() {
  // Session data is per-request. supabase-js reads the clock when it starts, which Next.js
  // only allows once the render is explicitly request-time (not during runtime prefetch).
  await connection();
  const cookieStore = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
