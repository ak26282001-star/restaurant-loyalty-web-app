import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RewardTemplate } from "./types";

export type RecentVisit = { id: string; visited_at: string; status: string; source: string; spend_cents: number | null; customers: { first_name: string | null } | null };
export type Tag = { id: string; code: string; kind: string; label: string | null; is_active: boolean; locations: { name: string } | null };
export type Location = { id: string; name: string };

const DAY = 24 * 60 * 60 * 1000;

/** KPIs, recent activity, catalogue and tags for the owner dashboard, read as the staff user (RLS). */
export async function getDashboard(supabase: SupabaseClient, restaurantId: string) {
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const count = { count: "exact" as const, head: true };

  const [members, active30, visits7, redeemed30, recent, templates, tags, locations, currency] = await Promise.all([
    supabase.from("memberships").select("id", count).eq("restaurant_id", restaurantId),
    supabase.from("memberships").select("id", count).eq("restaurant_id", restaurantId).gte("last_visit_at", since30),
    supabase.from("visits").select("id", count).eq("restaurant_id", restaurantId).eq("status", "confirmed").gte("visited_at", since7),
    supabase.from("rewards").select("id", count).eq("restaurant_id", restaurantId).eq("status", "redeemed").gte("redeemed_at", since30),
    supabase
      .from("visits")
      .select("id, visited_at, status, source, spend_cents, customers(first_name)")
      .eq("restaurant_id", restaurantId)
      .order("visited_at", { ascending: false })
      .limit(15)
      .returns<RecentVisit[]>(),
    supabase.from("reward_templates").select("*").eq("restaurant_id", restaurantId).order("points_cost").returns<RewardTemplate[]>(),
    supabase.from("tags").select("id, code, kind, label, is_active, locations(name)").eq("restaurant_id", restaurantId).order("created_at").returns<Tag[]>(),
    supabase.from("locations").select("id, name").eq("restaurant_id", restaurantId).returns<Location[]>(),
    supabase.from("restaurants").select("currency").eq("id", restaurantId).single<{ currency: string }>(),
  ]);
  return { members, active30, visits7, redeemed30, recent, templates, tags, locations, currency };
}
