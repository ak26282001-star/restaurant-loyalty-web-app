import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PendingVisit = { id: string; visited_at: string; customers: { first_name: string | null; phone: string | null } | null };

/** Visits from the last two hours still waiting for staff confirmation. */
export async function getPendingVisits(supabase: SupabaseClient, restaurantId: string): Promise<PendingVisit[]> {
  const { data } = await supabase
    .from("visits")
    .select("id, visited_at, customers(first_name, phone)")
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending")
    .gt("visited_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order("visited_at", { ascending: false })
    .returns<PendingVisit[]>();
  return data ?? [];
}

export type ConfirmedVisit = { id: string; visited_at: string; spend_cents: number | null; first_name: string | null; points: number | null };

/** Visits staff confirmed in the last two hours, newest first, with the points each earned. */
export async function getRecentlyConfirmed(supabase: SupabaseClient, restaurantId: string): Promise<ConfirmedVisit[]> {
  const { data: visits } = await supabase
    .from("visits")
    .select("id, visited_at, spend_cents, customers(first_name)")
    .eq("restaurant_id", restaurantId)
    .eq("status", "confirmed")
    .not("confirmed_by", "is", null)
    .gt("visited_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order("visited_at", { ascending: false })
    .limit(5)
    .returns<{ id: string; visited_at: string; spend_cents: number | null; customers: { first_name: string | null } | null }[]>();
  if (!visits?.length) return [];

  const { data: ledger } = await supabase
    .from("points_ledger")
    .select("ref_id, delta")
    .eq("reason", "visit")
    .in("ref_id", visits.map((v) => v.id))
    .returns<{ ref_id: string; delta: number }[]>();
  const points = new Map((ledger ?? []).map((l) => [l.ref_id, l.delta]));

  return visits.map((v) => ({
    id: v.id,
    visited_at: v.visited_at,
    spend_cents: v.spend_cents,
    first_name: v.customers?.first_name ?? null,
    points: points.get(v.id) ?? null,
  }));
}
