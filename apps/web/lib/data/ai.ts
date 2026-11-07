import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type InboxRec = {
  id: string; kind: string; title: string; message: string; rationale: string; confidence: number | null; model: string | null;
  status: string; created_at: string;
  reward_templates: { name: string; cost_estimate_cents: number } | null;
  memberships: { visit_count: number; customers: { first_name: string | null } | null } | null;
  rewards: { status: string } | null;
};

/** Everything the AI offers page shows, read as a manager (RLS). */
export async function getAiInbox(supabase: SupabaseClient, restaurantId: string) {
  const select = "id, kind, title, message, rationale, confidence, model, status, created_at, reward_templates(name, cost_estimate_cents), memberships(visit_count, customers(first_name)), rewards!ai_recommendations_reward_id_fkey(status)";
  const [{ data: proposed }, { data: recent }, { data: segments }, { data: r }] = await Promise.all([
    supabase.from("ai_recommendations").select(select).eq("restaurant_id", restaurantId).eq("status", "proposed").order("confidence", { ascending: false }).limit(50).returns<InboxRec[]>(),
    supabase.from("ai_recommendations").select(select).eq("restaurant_id", restaurantId).in("status", ["issued", "rejected"]).order("decided_at", { ascending: false }).limit(15).returns<InboxRec[]>(),
    supabase.from("customer_features").select("segment").eq("restaurant_id", restaurantId),
    supabase.from("restaurants").select("currency, settings").eq("id", restaurantId).single<{ currency: string; settings: { ai?: unknown } }>(),
  ]);
  const segmentCounts: Record<string, number> = { new: 0, regular: 0, vip: 0, at_risk: 0, lapsed: 0 };
  for (const s of segments ?? []) segmentCounts[s.segment] = (segmentCounts[s.segment] ?? 0) + 1;
  return { proposed: proposed ?? [], recent: recent ?? [], segmentCounts, currency: r?.currency ?? "USD", aiSettings: r?.settings?.ai };
}
