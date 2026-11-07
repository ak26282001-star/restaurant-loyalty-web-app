import "server-only";
import { adminClient } from "@/lib/supabase/admin";
import { pushConfigured, sendPush } from "@/lib/push";

/** Tell a member about a new reward on their phone, if they turned notifications on. */
export async function notifyReward(membershipId: string, title: string, message: string) {
  if (!pushConfigured()) return 0;
  const db = adminClient();
  const { data: m } = await db
    .from("memberships")
    .select("customer_id, restaurant_id, restaurants(slug)")
    .eq("id", membershipId)
    .single<{ customer_id: string; restaurant_id: string; restaurants: { slug: string } }>();
  if (!m) return 0;
  const { data: subs } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("customer_id", m.customer_id)
    .eq("restaurant_id", m.restaurant_id);
  let sent = 0;
  for (const s of subs ?? []) {
    const result = await sendPush(s, { title: `🎁 ${title}`, body: message, url: `/r/${m.restaurants.slug}`, tag: `reward-${membershipId}` });
    if (result === "sent") sent++;
    if (result === "gone") await db.from("push_subscriptions").delete().eq("id", s.id);
  }
  return sent;
}
