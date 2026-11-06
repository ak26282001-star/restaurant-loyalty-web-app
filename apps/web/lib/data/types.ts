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
