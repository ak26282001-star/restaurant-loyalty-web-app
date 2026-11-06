"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { mapDbError } from "@loyalty/core";
import { getUser } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { createUserClient } from "@/lib/supabase/server";

export type ClaimState = { error?: string; ok?: boolean } | null;

const MESSAGES: Record<string, string> = {
  insufficient_points: "Not enough points yet.",
  tier_too_low: "This reward unlocks at a higher tier.",
  not_a_member: "Check in once to join first.",
  reward_not_claimable: "This reward isn't available any more.",
};

/** Spend points on a catalogue reward. */
export async function claimReward(_prev: ClaimState, formData: FormData): Promise<ClaimState> {
  const user = await getUser();
  if (!user) return { error: "Please sign in again." };

  const parsed = z.object({ templateId: z.guid() }).safeParse({ templateId: formData.get("templateId") });
  if (!parsed.success) return { error: "Something went wrong." };

  const { error } = await adminClient().rpc("claim_reward", { p_customer_id: user.id, p_template_id: parsed.data.templateId });
  if (error) {
    const { code } = mapDbError(error.message);
    if (code === "internal_error") console.error("claim_reward failed", error);
    return { error: MESSAGES[code] ?? "Something went wrong. Please try again." };
  }
  refresh();
  return { ok: true };
}

export type NameState = { error?: string } | null;

/** Save the customer's first name (the only profile field the loyalty page asks for). */
export async function saveFirstName(_prev: NameState, formData: FormData): Promise<NameState> {
  const parsed = z
    .string()
    .trim()
    .min(1, "Please enter a name.")
    .max(40, "That's a bit long. Try a shorter name.")
    .regex(/^[\p{L}\p{M}' .-]+$/u, "Letters only, please.")
    .safeParse(formData.get("firstName"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Please sign in again." };

  // Runs as the customer: RLS limits it to their own row, column grants to profile fields.
  const { error } = await supabase.from("customers").update({ first_name: parsed.data }).eq("id", user.id);
  if (error) return { error: "Couldn't save that. Please try again." };
  refresh();
  return null;
}
