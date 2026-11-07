import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AdminChallenge = {
  id: string;
  title: string;
  kind: string;
  rule: unknown;
  bonus_points: number;
  is_active: boolean;
  ends_at: string | null;
  reward_templates: { name: string } | null;
};

/** Public challenges with participation stats, plus the data the create form needs. Read as a manager (RLS). */
export async function getChallengeAdmin(supabase: SupabaseClient, restaurantId: string) {
  const [{ data: challenges }, { data: rewards }, { data: restaurant }, { data: dishes }] = await Promise.all([
    supabase
      .from("challenges")
      .select("id, title, kind, rule, bonus_points, is_active, ends_at, reward_templates(name)")
      .eq("restaurant_id", restaurantId)
      .eq("is_personalised", false)
      .order("is_active", { ascending: false })
      .order("starts_at", { ascending: false })
      .returns<AdminChallenge[]>(),
    supabase.from("reward_templates").select("id, name").eq("restaurant_id", restaurantId).eq("is_active", true).order("name"),
    supabase.from("restaurants").select("currency").eq("id", restaurantId).single<{ currency: string }>(),
    supabase.from("menu_items").select("id, name").eq("restaurant_id", restaurantId).eq("is_active", true).order("name").limit(300),
  ]);

  const ids = (challenges ?? []).map((c) => c.id);
  const { data: progress } = ids.length
    ? await supabase.from("challenge_progress").select("challenge_id, status").in("challenge_id", ids)
    : { data: [] as { challenge_id: string; status: string }[] };

  const stats = new Map<string, { joined: number; completed: number }>();
  for (const p of progress ?? []) {
    const s = stats.get(p.challenge_id) ?? { joined: 0, completed: 0 };
    if (p.status === "completed") s.completed++;
    else s.joined++;
    stats.set(p.challenge_id, s);
  }

  return {
    challenges: challenges ?? [],
    stats,
    rewards: (rewards ?? []) as { id: string; name: string }[],
    currency: restaurant?.currency ?? "USD",
    dishes: (dishes ?? []) as { id: string; name: string }[],
  };
}
