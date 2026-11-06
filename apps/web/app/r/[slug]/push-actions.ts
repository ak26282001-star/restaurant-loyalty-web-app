"use server";

import { z } from "zod";
import { getUser } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { isAllowedPushEndpoint } from "@/lib/push";

const Subscription = z.object({
  restaurantId: z.guid(),
  endpoint: z.string().max(1000).refine(isAllowedPushEndpoint, "unsupported push service"),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

/** Store the browser's push subscription for this customer and restaurant. */
export async function savePushSubscription(input: unknown, userAgent: string): Promise<{ ok: boolean }> {
  const user = await getUser();
  const parsed = Subscription.safeParse(input);
  if (!user || !parsed.success) return { ok: false };

  const { error } = await adminClient()
    .from("push_subscriptions")
    .upsert(
      {
        customer_id: user.id,
        restaurant_id: parsed.data.restaurantId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        user_agent: userAgent.slice(0, 300),
        failure_count: 0,
      },
      { onConflict: "endpoint" },
    );
  return { ok: !error };
}

export async function deletePushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  const user = await getUser();
  if (!user) return { ok: false };
  const { error } = await adminClient().from("push_subscriptions").delete().eq("endpoint", endpoint).eq("customer_id", user.id);
  return { ok: !error };
}
