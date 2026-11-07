import "server-only";
import { adminClient } from "@/lib/supabase/admin";
import { getCustomer, getOrder, listItems, type Connection } from "./client";

/** Copy the merchant's Clover inventory into menu_items (used for favourites and "try these" challenges). */
export async function syncMenu(conn: Connection): Promise<number> {
  const db = adminClient();
  let n = 0;
  let batch: { restaurant_id: string; pos_item_id: string; name: string; price_cents: number | null; is_active: boolean }[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const { error } = await db.from("menu_items").upsert(batch, { onConflict: "restaurant_id,pos_item_id" });
    if (error) throw new Error(`menu upsert failed: ${error.message}`);
    n += batch.length;
    batch = [];
  };
  for await (const item of listItems(conn)) {
    batch.push({ restaurant_id: conn.restaurant_id, pos_item_id: item.id, name: item.name ?? "Item", price_cents: item.price ?? null, is_active: !item.hidden });
    if (batch.length >= 200) await flush();
  }
  await flush();
  await db.from("pos_connections").update({ menu_synced_at: new Date().toISOString() }).eq("id", conn.id);
  return n;
}

export type OrderOutcome = { status: string; detail?: string };

/**
 * Fetch a Clover order and credit it to the matching member. Only fully paid orders count;
 * Clover sends further UPDATE events as an order is paid, so earlier ones are ignored.
 */
export async function processOrder(conn: Connection, orderId: string): Promise<OrderOutcome> {
  const order = await getOrder(conn, orderId);
  if (order.paymentState !== "PAID") return { status: "ignored", detail: `paymentState ${order.paymentState ?? "none"}` };

  const phones: string[] = [];
  const emails: string[] = [];
  for (const ref of order.customers.slice(0, 3)) {
    const c = await getCustomer(conn, ref.id);
    phones.push(...c.phoneNumbers.map((p) => p.phoneNumber).filter((p): p is string => Boolean(p)));
    emails.push(...c.emailAddresses.map((e) => e.emailAddress).filter((e): e is string => Boolean(e)));
  }

  // Clover records one line item per unit sold; group them by inventory item.
  const items = new Map<string, { pos_item_id: string | null; name: string; price_cents: number; quantity: number }>();
  for (const li of order.lineItems) {
    if (li.refunded || li.exchanged) continue;
    const key = li.item?.id ?? `name:${li.name}`;
    const existing = items.get(key);
    if (existing) existing.quantity++;
    else items.set(key, { pos_item_id: li.item?.id ?? null, name: li.name ?? "Item", price_cents: li.price ?? 0, quantity: 1 });
  }

  const orderedAt = new Date(order.createdTime ?? order.clientCreatedTime ?? Date.now()).toISOString();
  const { data, error } = await adminClient().rpc("record_pos_order", {
    p_restaurant_id: conn.restaurant_id,
    p_location_id: conn.location_id,
    p_provider: "clover",
    p_pos_order_id: order.id,
    p_total_cents: order.total ?? 0,
    p_ordered_at: orderedAt,
    p_phones: phones,
    p_emails: emails,
    p_items: [...items.values()],
  });
  if (error) throw new Error(`record_pos_order failed: ${error.message}`);
  await adminClient().from("pos_connections").update({ last_order_at: new Date().toISOString(), status: "active", last_error: null }).eq("id", conn.id);
  return { status: "processed", detail: (data as { status: string }).status };
}
