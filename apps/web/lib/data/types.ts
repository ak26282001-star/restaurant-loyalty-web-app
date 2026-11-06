import type { Tier } from "@loyalty/core";

export type Restaurant = {
  id: string;
  slug: string;
  name: string;
  brand_color: string | null;
  logo_url: string | null;
  currency: string;
  settings: unknown;
};

export type Membership = {
  id: string;
  points_balance: number;
  lifetime_points: number;
  tier: Tier;
  visit_count: number;
  current_streak: number;
  longest_streak: number;
  last_visit_at: string | null;
};

export type WalletReward = { id: string; title: string; message: string | null; redeem_code: string; expires_at: string; origin: string };

export type RewardTemplate = {
  id: string;
  name: string;
  kind: string;
  value: number | null;
  points_cost: number | null;
  min_tier: Tier;
  valid_days: number;
  is_active: boolean;
};

export type LedgerEntry = { id: number; delta: number; reason: string; created_at: string };

export type Challenge = {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  rule: unknown;
  bonus_points: number;
  ends_at: string | null;
  reward_templates: { name: string } | null;
};

export type ChallengeProgressRow = {
  challenge_id: string;
  status: "active" | "completed" | "expired";
  progress: { value: number; target: number } | null;
  completed_at: string | null;
};
