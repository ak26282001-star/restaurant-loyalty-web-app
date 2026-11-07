import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { serverEnv } from "@/lib/env";

export const CONNECT_COOKIE = "clover_connect";
const key = () => new TextEncoder().encode(serverEnv().TAP_TOKEN_SECRET);

/**
 * Binds a Clover OAuth round trip to the owner who started it and the restaurant they chose.
 * Clover's redirect carries merchant_id and code but no state we control, so the binding
 * lives in this short-lived, signed, httpOnly cookie instead.
 */
export function signConnect(claims: { restaurantId: string; userId: string; locationId: string | null }) {
  return new SignJWT({ rid: claims.restaurantId, uid: claims.userId, loc: claims.locationId, purpose: "clover_connect" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key());
}

export async function verifyConnect(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.purpose !== "clover_connect" || typeof payload.rid !== "string" || typeof payload.uid !== "string") return null;
    return { restaurantId: payload.rid, userId: payload.uid, locationId: typeof payload.loc === "string" ? payload.loc : null };
  } catch {
    return null;
  }
}
