import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { serverEnv } from "@/lib/env";

export const TAP_COOKIE = "lp_tag";
export const DEVICE_COOKIE = "lp_device";
export const TAP_TOKEN_TTL_SECONDS = 600;

export type TapClaims = { tagId: string; restaurantId: string; sunVerified: boolean };

const key = () => new TextEncoder().encode(serverEnv().TAP_TOKEN_SECRET);

/** Short-lived proof that this browser tapped a tag; it carries the tap through login. */
export async function signTapToken(claims: TapClaims): Promise<string> {
  return new SignJWT({ tid: claims.tagId, rid: claims.restaurantId, sun: claims.sunVerified })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TAP_TOKEN_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyTapToken(token: string | undefined): Promise<TapClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.tid !== "string" || typeof payload.rid !== "string") return null;
    return { tagId: payload.tid, restaurantId: payload.rid, sunVerified: payload.sun === true };
  } catch {
    return null;
  }
}
