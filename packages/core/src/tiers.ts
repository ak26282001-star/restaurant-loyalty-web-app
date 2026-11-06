import type { RestaurantSettings } from "./settings";

export const TIERS = ["member", "regular", "vip", "legend"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  member: "Member",
  regular: "Regular",
  vip: "VIP",
  legend: "Legend",
};

/** Same rule as SQL tier_for(): highest tier whose visit threshold is met. */
export function tierFor(visits: number, tiers: RestaurantSettings["tiers"]): Tier {
  if (visits >= tiers.legend) return "legend";
  if (visits >= tiers.vip) return "vip";
  if (visits >= tiers.regular) return "regular";
  return "member";
}

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export type TierProgress =
  | { next: null }
  | { next: Tier; visitsNeeded: number; fraction: number };

/** Progress towards the next tier, for the progress ring on the loyalty card. */
export function nextTierProgress(current: Tier, visits: number, tiers: RestaurantSettings["tiers"]): TierProgress {
  const thresholds: Record<Tier, number> = { member: 0, ...tiers };
  const idx = tierRank(current);
  if (idx === TIERS.length - 1) return { next: null };
  const next = TIERS[idx + 1];
  const from = thresholds[current];
  const to = thresholds[next];
  const visitsNeeded = Math.max(0, to - visits);
  const fraction = Math.min(1, Math.max(0, (visits - from) / (to - from)));
  return { next, visitsNeeded, fraction };
}
