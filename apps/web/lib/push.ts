import "server-only";
import webpush, { WebPushError } from "web-push";
import { isAllowedPushEndpoint as isAllowed } from "@loyalty/core";

export function isAllowedPushEndpoint(endpoint: string): boolean {
  // PUSH_ENDPOINT_ALLOWLIST lets tests point subscriptions at a local fake push service.
  const extra = (process.env.PUSH_ENDPOINT_ALLOWLIST ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return isAllowed(endpoint, extra);
}

export function pushConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** Sends one notification. "gone" means the subscription expired and should be deleted. */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<"sent" | "gone" | "failed"> {
  if (!isAllowedPushEndpoint(target.endpoint)) return "gone";
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        TTL: 12 * 60 * 60,
        urgency: "normal",
        vapidDetails: {
          subject: process.env.VAPID_SUBJECT ?? "mailto:support@example.com",
          publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
          privateKey: process.env.VAPID_PRIVATE_KEY!,
        },
      },
    );
    return "sent";
  } catch (e) {
    if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) return "gone";
    console.error("push failed", e instanceof WebPushError ? e.statusCode : e);
    return "failed";
  }
}
