import { z } from "zod";

// Supabase's dashboard now calls these the "publishable" and "secret" keys; older projects and the
// Vercel integration use "anon" and "service role". Both naming styles are accepted.
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

const ServerEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ error: "NEXT_PUBLIC_SUPABASE_URL is missing or not a URL" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) is missing"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is missing"),
  TAP_TOKEN_SECRET: z
    .string({ error: "TAP_TOKEN_SECRET is missing" })
    .min(32, "TAP_TOKEN_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_SITE_URL: z.url().optional(),
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

let cached: z.infer<typeof ServerEnv> | undefined;

function readServerEnv() {
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey(),
    SUPABASE_SERVICE_ROLE_KEY: serviceKey(),
    // Optional values set to "" in a dashboard count as unset.
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || undefined,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || undefined,
  };
}

/** Validated server environment. Throws one readable error naming every missing setting (never values). */
export function serverEnv() {
  if (cached) return cached;
  const parsed = ServerEnv.safeParse(readServerEnv());
  if (!parsed.success) throw new Error(`Server configuration error: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  cached = parsed.data;
  return cached;
}

/** Names of required settings that are missing or invalid, for the health check. */
export function configProblems(): string[] {
  const parsed = ServerEnv.safeParse(readServerEnv());
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

/** Public values, safe for the browser. NEXT_PUBLIC_* are inlined at build time, so changing them needs a redeploy. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "",
};
