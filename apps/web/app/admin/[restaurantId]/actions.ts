"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { generateTagCode } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import type { ActionState } from "@/components/action-form";

const Template = z.object({
  restaurantId: z.guid(),
  name: z.string().trim().min(2).max(60),
  kind: z.enum(["free_item", "percent_off", "amount_off", "experience"]),
  value: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().positive().max(10_000).nullable()),
  points_cost: z.coerce.number().int().positive().max(100_000),
  min_tier: z.enum(["member", "regular", "vip", "legend"]),
  valid_days: z.coerce.number().int().min(1).max(365),
});

export async function createRewardTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = Template.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Check the reward details and try again." };
  const { restaurantId, ...fields } = parsed.data;
  if (fields.kind === "percent_off" && (fields.value ?? 0) > 100) return { error: "A percentage can't exceed 100." };

  const { supabase } = await requireStaff(restaurantId, "manager");
  const { error } = await supabase.from("reward_templates").insert({ restaurant_id: restaurantId, ...fields });
  if (error) return { error: "Could not save the reward." };
  refresh();
  return { message: `Added “${fields.name}”` };
}

export async function setTemplateActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ restaurantId: z.guid(), templateId: z.guid(), active: z.enum(["true", "false"]) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid request." };

  const { supabase } = await requireStaff(parsed.data.restaurantId, "manager");
  const { error } = await supabase
    .from("reward_templates")
    .update({ is_active: parsed.data.active === "true" })
    .eq("id", parsed.data.templateId)
    .eq("restaurant_id", parsed.data.restaurantId);
  if (error) return { error: "Could not update the reward." };
  refresh();
  return null;
}

export async function createTag(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ restaurantId: z.guid(), label: z.string().trim().min(1).max(40), kind: z.enum(["nfc", "qr"]), locationId: z.union([z.guid(), z.literal("")]) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Give the tag a label, e.g. “Counter” or “Table 4”." };

  const { supabase } = await requireStaff(parsed.data.restaurantId, "manager");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.from("tags").insert({
      restaurant_id: parsed.data.restaurantId,
      location_id: parsed.data.locationId || null,
      code: generateTagCode(),
      kind: parsed.data.kind,
      label: parsed.data.label,
    });
    if (!error) {
      refresh();
      return { message: `Created tag “${parsed.data.label}”` };
    }
    if (error.code !== "23505") break; // retry only on a (very unlikely) code collision
  }
  return { error: "Could not create the tag." };
}
