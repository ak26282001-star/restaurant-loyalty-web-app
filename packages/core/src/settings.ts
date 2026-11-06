import { z } from "zod";

/** Owner-tunable loyalty rules, stored in restaurants.settings. Mirrors the SQL defaults. */
export const RestaurantSettings = z.object({
  points_per_visit: z.number().int().nonnegative().default(10),
  points_per_currency_unit: z.number().nonnegative().default(1),
  visit_cooldown_minutes: z.number().int().positive().default(240),
  streak_window_days: z.number().int().positive().default(14),
  tiers: z
    .object({
      regular: z.number().int().positive().default(5),
      vip: z.number().int().positive().default(15),
      legend: z.number().int().positive().default(40),
    })
    .default({ regular: 5, vip: 15, legend: 40 }),
  /** Bonus points when a streak reaches exactly this many visits, e.g. {"3": 20}. */
  streak_bonuses: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).default({ "3": 20, "5": 50, "10": 100 }),
});
export type RestaurantSettings = z.infer<typeof RestaurantSettings>;

export function parseSettings(raw: unknown): RestaurantSettings {
  return RestaurantSettings.parse(raw ?? {});
}
