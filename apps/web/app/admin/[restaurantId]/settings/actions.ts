"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { RestaurantSettings } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import type { ActionState } from "@/components/action-form";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const Form = z.object({
  restaurantId: z.guid(),
  points_per_visit: int(0, 10_000),
  points_per_currency_unit: z.coerce.number().min(0).max(1000),
  visit_cooldown_minutes: int(15, 24 * 60),
  streak_window_days: int(1, 90),
  tier_regular: int(1, 1000),
  tier_vip: int(2, 1000),
  tier_legend: int(3, 1000),
  streak_bonuses: z.string().trim().max(200),
  country_calling_code: z.string().trim().regex(/^\+?\d{0,4}$/),
});

/** "3=20, 5=50" → {"3": 20, "5": 50}. Empty string means no streak bonuses. */
function parseStreakBonuses(text: string): Record<string, number> | null {
  if (!text) return {};
  const out: Record<string, number> = {};
  for (const part of text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,3})\s*[=:]\s*(\d{1,6})$/.exec(part);
    if (!m || Number(m[1]) < 2) return null;
    out[String(Number(m[1]))] = Number(m[2]);
  }
  return out;
}

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = Form.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Check the values and try again." };
  const f = parsed.data;
  if (!(f.tier_regular < f.tier_vip && f.tier_vip < f.tier_legend)) {
    return { error: "Tier thresholds must increase: Regular < VIP < Legend." };
  }
  const bonuses = parseStreakBonuses(f.streak_bonuses);
  if (!bonuses) return { error: "Write streak bonuses like “3=20, 5=50” (streak length = points, length 2 or more)." };

  const { supabase } = await requireStaff(f.restaurantId, "owner");
  const { data: current } = await supabase.from("restaurants").select("settings").eq("id", f.restaurantId).single();

  const next = {
    ...(current?.settings ?? {}), // keep keys this form doesn't manage (e.g. AI guardrails)
    ...RestaurantSettings.parse({
      points_per_visit: f.points_per_visit,
      points_per_currency_unit: f.points_per_currency_unit,
      visit_cooldown_minutes: f.visit_cooldown_minutes,
      streak_window_days: f.streak_window_days,
      tiers: { regular: f.tier_regular, vip: f.tier_vip, legend: f.tier_legend },
      streak_bonuses: bonuses,
    }),
    country_calling_code: f.country_calling_code.replace("+", ""),
  };

  const { error } = await supabase.from("restaurants").update({ settings: next }).eq("id", f.restaurantId);
  if (error) return { error: "Could not save settings." };
  refresh();
  return { message: "Settings saved. They apply from the next visit." };
}
