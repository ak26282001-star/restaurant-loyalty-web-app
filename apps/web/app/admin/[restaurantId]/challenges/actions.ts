"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { ChallengeRule, DAYPARTS } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import type { ActionState } from "@/components/action-form";

const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(min).max(max).optional());

const Form = z.object({
  restaurantId: z.guid(),
  title: z.string().trim().min(2).max(60),
  description: z.string().trim().max(160).optional(),
  kind: z.enum(["visit_count", "spend_amount", "time_window", "streak", "try_items"]),
  need: optionalInt(1, 20),
  visits: optionalInt(1, 100),
  within_days: optionalInt(1, 365),
  spend: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().positive().max(100_000).optional()),
  daypart: z.union([z.enum(DAYPARTS), z.literal("")]).optional(),
  length: optionalInt(2, 100),
  bonus_points: optionalInt(0, 100_000),
  reward_template_id: z.union([z.guid(), z.literal("")]).optional(),
  ends_on: z.union([z.iso.date(), z.literal("")]).optional(),
});

/** Turns the flat form fields into the typed rule the SQL evaluator understands. */
function buildRule(f: z.infer<typeof Form>, weekdays: number[], dishes: string[]) {
  switch (f.kind) {
    case "visit_count":
      return { kind: f.kind, rule: { visits: f.visits, within_days: f.within_days } };
    case "spend_amount":
      return { kind: f.kind, rule: { spend_cents: f.spend != null ? Math.round(f.spend * 100) : undefined, within_days: f.within_days } };
    case "time_window":
      return {
        kind: f.kind,
        rule: { visits: f.visits, weekdays: weekdays.length ? weekdays : undefined, daypart: f.daypart || undefined, within_days: f.within_days },
      };
    case "streak":
      return { kind: f.kind, rule: { length: f.length } };
    case "try_items":
      return { kind: f.kind, rule: { menu_item_ids: dishes, need: f.need, within_days: f.within_days } };
  }
}

export async function createChallenge(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const form = Form.safeParse(Object.fromEntries(formData));
  if (!form.success) return { error: "Check the challenge details and try again." };
  const f = form.data;

  const weekdays = formData.getAll("weekdays").map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  const dishes = [...new Set(formData.getAll("dishes").map(String))];
  if (f.kind === "try_items" && !dishes.length) return { error: "Pick at least one dish." };
  const rule = ChallengeRule.safeParse(JSON.parse(JSON.stringify(buildRule(f, weekdays, dishes)))); // drops undefined keys
  if (!rule.success) return { error: "Fill in the goal for this type of challenge." };
  if (f.kind === "time_window" && !weekdays.length && !f.daypart) return { error: "Pick at least one day or a time of day." };
  if (!f.bonus_points && !f.reward_template_id) return { error: "Give a prize: bonus points, a reward, or both." };

  const { supabase } = await requireStaff(f.restaurantId, "manager");
  if (rule.data.kind === "try_items") {
    const { count } = await supabase.from("menu_items").select("id", { count: "exact", head: true })
      .eq("restaurant_id", f.restaurantId).in("id", rule.data.rule.menu_item_ids);
    if (count !== rule.data.rule.menu_item_ids.length) return { error: "Some of those dishes aren't on your menu." };
  }
  const { error } = await supabase.from("challenges").insert({
    restaurant_id: f.restaurantId,
    title: f.title,
    description: f.description || null,
    kind: rule.data.kind,
    rule: rule.data.rule,
    bonus_points: f.bonus_points ?? 0,
    reward_template_id: f.reward_template_id || null,
    ends_at: f.ends_on ? new Date(`${f.ends_on}T23:59:59Z`).toISOString() : null,
  });
  if (error) return { error: "Could not save the challenge." };
  refresh();
  return { message: `Challenge “${f.title}” is live` };
}

export async function setChallengeActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ restaurantId: z.guid(), challengeId: z.guid(), active: z.enum(["true", "false"]) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid request." };
  const { supabase } = await requireStaff(parsed.data.restaurantId, "manager");
  const { error } = await supabase
    .from("challenges")
    .update({ is_active: parsed.data.active === "true" })
    .eq("id", parsed.data.challengeId)
    .eq("restaurant_id", parsed.data.restaurantId);
  if (error) return { error: "Could not update the challenge." };
  refresh();
  return null;
}
