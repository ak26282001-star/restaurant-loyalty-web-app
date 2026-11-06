import { z } from "zod";

const ServerEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TAP_TOKEN_SECRET: z.string().min(32, "TAP_TOKEN_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_SITE_URL: z.url().optional(),
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

let cached: z.infer<typeof ServerEnv> | undefined;

/** Validated server environment. Parsed lazily so `next build` works without secrets. */
export function serverEnv() {
  cached ??= ServerEnv.parse(process.env);
  return cached;
}

/** Public values, safe for the browser. Inlined by Next.js at build time. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};
