"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { mapDbError } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import type { ActionState } from "@/components/action-form";

const Ids = z.object({ restaurantId: z.guid(), visitId: z.guid() });

const REDEEM_MESSAGES: Record<string, string> = {
  reward_not_found: "No reward with that code at this restaurant.",
  reward_redeemed: "That reward has already been used.",
  reward_expired: "That reward has expired.",
  reward_revoked: "That reward was cancelled.",
};

export async function confirmVisit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ids = Ids.safeParse(Object.fromEntries(formData));
  if (!ids.success) return { error: "Invalid request." };
  const { user } = await requireStaff(ids.data.restaurantId);

  const spendRaw = String(formData.get("spend") ?? "").trim();
  const spend = spendRaw ? Math.round(Number(spendRaw) * 100) : null;
  if (spend !== null && (!Number.isFinite(spend) || spend < 0 || spend > 10_000_00)) return { error: "Enter a valid bill amount." };

  // Make sure the visit belongs to this restaurant before using the service role.
  const { data: visit } = await adminClient().from("visits").select("restaurant_id").eq("id", ids.data.visitId).maybeSingle();
  if (visit?.restaurant_id !== ids.data.restaurantId) return { error: "Visit not found." };

  const { data, error } = await adminClient().rpc("confirm_visit", {
    p_visit_id: ids.data.visitId,
    p_confirmed_by: user.id,
    p_spend_cents: spend,
  });
  if (error) return { error: mapDbError(error.message).code === "visit_rejected" ? "This visit was rejected." : "Could not confirm the visit." };
  refresh();
  return { message: `Confirmed · +${data.points_awarded ?? 0} points` };
}

export async function rejectVisit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ids = Ids.safeParse(Object.fromEntries(formData));
  if (!ids.success) return { error: "Invalid request." };
  const { supabase, user } = await requireStaff(ids.data.restaurantId);

  // Staff can update visits directly under RLS; only pending visits can be rejected.
  const { error } = await supabase
    .from("visits")
    .update({ status: "rejected", confirmed_by: user.id })
    .eq("id", ids.data.visitId)
    .eq("restaurant_id", ids.data.restaurantId)
    .eq("status", "pending");
  if (error) return { error: "Could not reject the visit." };
  refresh();
  return { message: "Rejected" };
}

export async function redeemReward(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ restaurantId: z.guid(), code: z.string().trim().min(4).max(16) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter the code shown on the guest's phone." };
  const { user } = await requireStaff(parsed.data.restaurantId);

  const { data, error } = await adminClient().rpc("redeem_reward", {
    p_staff_user_id: user.id,
    p_restaurant_id: parsed.data.restaurantId,
    p_code: parsed.data.code,
  });
  if (error) {
    const { code } = mapDbError(error.message);
    return { error: REDEEM_MESSAGES[code] ?? "Could not redeem that code." };
  }
  refresh();
  return { message: `✅ Redeemed: ${data.title}` };
}
