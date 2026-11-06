import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerEntry, Membership, Restaurant, RewardTemplate, WalletReward } from "./types";

export async function getRestaurantBySlug(supabase: SupabaseClient, slug: string) {
  const { data } = await supabase
    .from("restaurants")
    .select("id, slug, name, brand_color, logo_url, currency, settings")
    .eq("slug", slug)
    .maybeSingle<Restaurant>();
  return data;
}

/** Everything the loyalty home needs, read as the customer (RLS-scoped). */
export async function getCustomerHome(supabase: SupabaseClient, restaurantId: string, customerId: string) {
  const [{ data: customer }, { data: membership }, { data: catalog }] = await Promise.all([
    supabase.from("customers").select("first_name").eq("id", customerId).maybeSingle<{ first_name: string | null }>(),
    supabase
      .from("memberships")
      .select("id, points_balance, lifetime_points, tier, visit_count, current_streak, longest_streak, last_visit_at")
      .eq("restaurant_id", restaurantId)
      .eq("customer_id", customerId)
      .maybeSingle<Membership>(),
    supabase
      .from("reward_templates")
      .select("id, name, kind, value, points_cost, min_tier, valid_days, is_active")
      .eq("restaurant_id", restaurantId)
      .eq("is_active", true)
      .not("points_cost", "is", null)
      .order("points_cost")
      .returns<RewardTemplate[]>(),
  ]);

  let rewards: WalletReward[] = [];
  let ledger: LedgerEntry[] = [];
  if (membership) {
    const [r, l] = await Promise.all([
      supabase
        .from("rewards")
        .select("id, title, message, redeem_code, expires_at, origin")
        .eq("membership_id", membership.id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .order("expires_at")
        .returns<WalletReward[]>(),
      supabase
        .from("points_ledger")
        .select("id, delta, reason, created_at")
        .eq("membership_id", membership.id)
        .order("created_at", { ascending: false })
        .limit(10)
        .returns<LedgerEntry[]>(),
    ]);
    rewards = r.data ?? [];
    ledger = l.data ?? [];
  }

  return { firstName: customer?.first_name ?? null, membership, catalog: catalog ?? [], rewards, ledger };
}
