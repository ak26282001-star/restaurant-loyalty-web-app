import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Challenge, ChallengeProgressRow, LedgerEntry, Membership, Restaurant, RewardTemplate, WalletReward } from "./types";

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
  const nowIso = new Date().toISOString();
  const [{ data: customer }, { data: membership }, { data: catalog }, { data: challenges }] = await Promise.all([
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
    // RLS returns public challenges plus personalised ones this customer is enrolled in.
    supabase
      .from("challenges")
      .select("id, title, description, kind, rule, bonus_points, ends_at, reward_templates(name)")
      .eq("restaurant_id", restaurantId)
      .eq("is_active", true)
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .order("starts_at")
      .returns<Challenge[]>(),
  ]);

  let rewards: WalletReward[] = [];
  let ledger: LedgerEntry[] = [];
  let progress: ChallengeProgressRow[] = [];
  if (membership) {
    const [r, l, p] = await Promise.all([
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
      supabase
        .from("challenge_progress")
        .select("challenge_id, status, progress, completed_at")
        .eq("membership_id", membership.id)
        .returns<ChallengeProgressRow[]>(),
    ]);
    rewards = r.data ?? [];
    ledger = l.data ?? [];
    progress = p.data ?? [];
  }

  return {
    firstName: customer?.first_name ?? null,
    membership,
    catalog: catalog ?? [],
    rewards,
    ledger,
    challenges: challenges ?? [],
    progress,
  };
}

/** Whether the customer has a tap waiting for staff confirmation (pending visits expire after 2 hours). */
export async function hasPendingVisit(supabase: SupabaseClient, restaurantId: string, customerId: string) {
  const { count } = await supabase
    .from("visits")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurantId)
    .eq("customer_id", customerId)
    .eq("status", "pending")
    .gt("visited_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  return (count ?? 0) > 0;
}
