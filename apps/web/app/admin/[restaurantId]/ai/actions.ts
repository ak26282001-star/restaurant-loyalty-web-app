"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { AiSettings } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { runOffers } from "@/lib/ai/run";
import { notifyReward } from "@/lib/ai/notify";
import type { ActionState } from "@/components/action-form";

const Rec = z.object({ restaurantId: z.guid(), recommendationId: z.guid() });

async function ownRec(restaurantId: string, id: string) {
  const { data } = await adminClient()
    .from("ai_recommendations")
    .select("id, membership_id, title, message, status")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return data;
}

export async function approveOffer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const p = Rec.safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: "Invalid request." };
  const { user } = await requireStaff(p.data.restaurantId, "manager");
  const rec = await ownRec(p.data.restaurantId, p.data.recommendationId);
  if (!rec) return { error: "Offer not found." };
  const { error } = await adminClient().rpc("issue_recommendation", { p_recommendation_id: rec.id, p_decided_by: user.id });
  if (error) return { error: error.message === "reward_not_claimable" ? "That reward is no longer active." : "Couldn't issue the offer." };
  await notifyReward(rec.membership_id, rec.title, rec.message);
  refresh();
  return { message: "Sent to the guest's wallet" };
}

export async function rejectOffer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const p = Rec.extend({ feedback: z.string().trim().max(200).optional() }).safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: "Invalid request." };
  const { supabase, user } = await requireStaff(p.data.restaurantId, "manager");
  const { error } = await supabase
    .from("ai_recommendations")
    .update({ status: "rejected", decided_by: user.id, decided_at: new Date().toISOString(), owner_feedback: p.data.feedback || null })
    .eq("id", p.data.recommendationId)
    .eq("restaurant_id", p.data.restaurantId)
    .eq("status", "proposed");
  if (error) return { error: "Couldn't reject the offer." };
  refresh();
  return null;
}

export async function generateOffersNow(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const p = z.object({ restaurantId: z.guid() }).safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: "Invalid request." };
  await requireStaff(p.data.restaurantId, "manager");
  try {
    const s = await runOffers(p.data.restaurantId);
    refresh();
    if (!s.candidates) return { message: `Checked ${s.members} guests: nobody needs an offer right now.` };
    return { message: `Checked ${s.members} guests: ${s.proposed} new offer${s.proposed === 1 ? "" : "s"}${s.issued ? `, ${s.issued} sent automatically` : " for you to review"}.` };
  } catch (e) {
    console.error("offer run failed", e);
    return { error: "Couldn't generate offers. Please try again." };
  }
}

const Settings = z.object({
  restaurantId: z.guid(),
  enabled: z.enum(["on"]).optional(),
  auto_issue: z.enum(["on"]).optional(),
  max_discount_percent: z.coerce.number().min(0).max(100),
  max_offers_per_customer_per_week: z.coerce.number().int().min(0).max(14),
  monthly_reward_budget: z.coerce.number().min(0).max(1_000_000),
});

export async function saveAiSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const p = Settings.safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: "Check the values and try again." };
  const { supabase } = await requireStaff(p.data.restaurantId, "owner");
  const { data: r } = await supabase.from("restaurants").select("settings").eq("id", p.data.restaurantId).single();
  const ai = AiSettings.parse({
    ...(r?.settings?.ai ?? {}),
    enabled: p.data.enabled === "on",
    auto_issue: p.data.auto_issue === "on",
    max_discount_percent: p.data.max_discount_percent,
    max_offers_per_customer_per_week: p.data.max_offers_per_customer_per_week,
    monthly_reward_budget: p.data.monthly_reward_budget,
  });
  const { error } = await supabase.from("restaurants").update({ settings: { ...(r?.settings ?? {}), ai } }).eq("id", p.data.restaurantId);
  if (error) return { error: "Couldn't save." };
  refresh();
  return { message: "AI settings saved." };
}
