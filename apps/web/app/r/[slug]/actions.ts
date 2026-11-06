"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { mapDbError } from "@loyalty/core";
import { getUser } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";

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
