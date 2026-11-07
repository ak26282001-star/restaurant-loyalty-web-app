import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import { open, seal } from "@/lib/secret-box";
import { apiHost, cloverAppCredentials, oauthHost, type CloverEnvironment } from "./config";
import { CloverCustomer, CloverItemPage, CloverOrder, TokenResponse } from "./types";

export type Connection = { id: string; restaurant_id: string; location_id: string | null; environment: CloverEnvironment; merchant_id: string };

export class CloverError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function authorizeUrl(env: CloverEnvironment, redirectUri: string) {
  const app = cloverAppCredentials();
  if (!app) throw new CloverError("Clover app credentials are not configured");
  const url = new URL("/oauth/v2/authorize", oauthHost(env));
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

async function tokenRequest(env: CloverEnvironment, path: "/oauth/v2/token" | "/oauth/v2/refresh", body: Record<string, string>) {
  const res = await fetch(new URL(path, apiHost(env)), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new CloverError(`Clover ${path} failed`, res.status);
  return TokenResponse.parse(await res.json());
}

/** Exchange the authorization code from the OAuth redirect for an access/refresh token pair. */
export function exchangeCode(env: CloverEnvironment, code: string) {
  const app = cloverAppCredentials()!;
  return tokenRequest(env, "/oauth/v2/token", { client_id: app.appId, client_secret: app.appSecret, code });
}

const ts = (unixSeconds?: number) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

export async function saveTokens(db: SupabaseClient, connectionId: string, t: TokenResponse) {
  const { error } = await db.from("pos_credentials").upsert({
    connection_id: connectionId,
    access_token: seal(t.access_token),
    access_token_expires_at: ts(t.access_token_expiration),
    refresh_token: t.refresh_token ? seal(t.refresh_token) : null,
    refresh_token_expires_at: ts(t.refresh_token_expiration),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new CloverError(`could not store tokens: ${error.message}`);
}

type CredRow = { access_token: string; access_token_expires_at: string | null; refresh_token: string | null };

/**
 * A valid access token for the connection, refreshing it when it is about to expire.
 * Clover refresh tokens are single-use, so concurrent refreshes must not both spend the
 * same one: the new pair is only written if the stored refresh token is still the one we
 * used, otherwise another request refreshed first and we use its token.
 */
async function accessToken(conn: Connection, force = false): Promise<string> {
  const db = adminClient();
  const { data: cred } = await db
    .from("pos_credentials")
    .select("access_token, access_token_expires_at, refresh_token")
    .eq("connection_id", conn.id)
    .single<CredRow>();
  if (!cred) throw new CloverError("no stored Clover credentials");

  const expiresAt = cred.access_token_expires_at ? Date.parse(cred.access_token_expires_at) : Infinity;
  if (!force && expiresAt - Date.now() > REFRESH_MARGIN_MS) return open(cred.access_token);
  if (!cred.refresh_token) throw new CloverError("Clover access expired; reconnect the POS", 401);

  const app = cloverAppCredentials()!;
  const fresh = await tokenRequest(conn.environment, "/oauth/v2/refresh", { client_id: app.appId, refresh_token: open(cred.refresh_token) });

  const { data: won } = await db
    .from("pos_credentials")
    .update({
      access_token: seal(fresh.access_token),
      access_token_expires_at: ts(fresh.access_token_expiration),
      refresh_token: fresh.refresh_token ? seal(fresh.refresh_token) : null,
      refresh_token_expires_at: ts(fresh.refresh_token_expiration),
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", conn.id)
    .eq("refresh_token", cred.refresh_token)
    .select("connection_id");
  if (won?.length) return fresh.access_token;

  const { data: latest } = await db.from("pos_credentials").select("access_token").eq("connection_id", conn.id).single<{ access_token: string }>();
  return open(latest!.access_token);
}

/** GET a Clover REST path, retrying rate limits (429) and refreshing once on 401. */
export async function cloverGet(conn: Connection, path: string): Promise<unknown> {
  let token = await accessToken(conn);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(new URL(path, apiHost(conn.environment)), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return res.json();
    if (res.status === 401 && attempt === 0) {
      token = await accessToken(conn, true);
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt, 5000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new CloverError(`Clover GET ${path.split("?")[0]} failed`, res.status);
  }
  throw new CloverError(`Clover GET ${path.split("?")[0]} kept being rate limited`, 429);
}

const enc = encodeURIComponent;

export async function getOrder(conn: Connection, orderId: string) {
  return CloverOrder.parse(await cloverGet(conn, `/v3/merchants/${enc(conn.merchant_id)}/orders/${enc(orderId)}?expand=lineItems,customers`));
}

export async function getCustomer(conn: Connection, customerId: string) {
  return CloverCustomer.parse(
    await cloverGet(conn, `/v3/merchants/${enc(conn.merchant_id)}/customers/${enc(customerId)}?expand=phoneNumbers,emailAddresses`),
  );
}

export async function* listItems(conn: Connection) {
  const limit = 500;
  for (let offset = 0; offset < 50_000; offset += limit) {
    const page = CloverItemPage.parse(await cloverGet(conn, `/v3/merchants/${enc(conn.merchant_id)}/items?limit=${limit}&offset=${offset}`));
    yield* page.elements;
    if (page.elements.length < limit) return;
  }
}
