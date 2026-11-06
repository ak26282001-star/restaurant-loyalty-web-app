import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Service-role client. Bypasses RLS, so only use it after the caller has been
 * authorised, and only for the value-moving SQL functions and tap logging.
 */
export function adminClient(): SupabaseClient {
  const env = serverEnv();
  client ??= createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
