import "server-only";
import {
  checkGuardrails,
  defaultCopy,
  eligibleTemplates,
  parseAiSettings,
  pickCandidate,
  type Candidate,
  type MemberSnapshot,
  type OfferTemplate,
  type Segment,
  type Tier,
} from "@loyalty/core";
import { adminClient } from "@/lib/supabase/admin";
import { draftOffer } from "./claude";
import { notifyReward } from "./notify";

const MAX_OFFERS_PER_RUN = 25;
const CONCURRENCY = 4;
const AI_ORIGINS = ["winback", "vip", "surprise"];

type FeatureRow = {
  membership_id: string;
  segment: Segment;
  recency_days: number | null;
  avg_gap_days: number | null;
  churn_risk: number | null;
  favourite_items: { name: string }[] | null;
  preferred_daypart: string | null;
  memberships: { tier: Tier; visit_count: number; current_streak: number; customers: { first_name: string | null } | null };
};

export type RunSummary = { members: number; candidates: number; proposed: number; issued: number; drafted_by_ai: number; skipped: Record<string, number> };

/**
 * Nightly (or on-demand) offer run for one restaurant: refresh features, pick candidates,
 * have Claude draft copy, enforce guardrails, and store recommendations for the owner.
 */
export async function runOffers(restaurantId: string, opts: { random?: () => number } = {}): Promise<RunSummary> {
  const db = adminClient();
  const summary: RunSummary = { members: 0, candidates: 0, proposed: 0, issued: 0, drafted_by_ai: 0, skipped: {} };
  const skip = (why: string) => (summary.skipped[why] = (summary.skipped[why] ?? 0) + 1);

  const { data: restaurant } = await db.from("restaurants").select("name, currency, settings").eq("id", restaurantId).single();
  if (!restaurant) throw new Error("restaurant not found");
  const settings = parseAiSettings(restaurant.settings?.ai);
  if (!settings.enabled) return summary;

  const { data: n, error: featErr } = await db.rpc("recompute_customer_features", { p_restaurant_id: restaurantId });
  if (featErr) throw new Error(`features failed: ${featErr.message}`);
  summary.members = n ?? 0;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [{ data: features }, { data: templates }, { data: openRewards }, { data: recentRecs }, { data: monthRecs }, { data: feedback }] = await Promise.all([
    db
      .from("customer_features")
      .select("membership_id, segment, recency_days, avg_gap_days, churn_risk, favourite_items, preferred_daypart, memberships(tier, visit_count, current_streak, customers(first_name))")
      .eq("restaurant_id", restaurantId)
      .order("churn_risk", { ascending: false, nullsFirst: false })
      .returns<FeatureRow[]>(),
    db.from("reward_templates").select("id, name, kind, value, min_tier, cost_estimate_cents, ai_eligible, is_active").eq("restaurant_id", restaurantId).returns<OfferTemplate[]>(),
    db.from("rewards").select("membership_id").eq("restaurant_id", restaurantId).eq("status", "active").in("origin", AI_ORIGINS),
    db.from("ai_recommendations").select("membership_id, status").eq("restaurant_id", restaurantId).gte("created_at", weekAgo),
    db.from("ai_recommendations").select("template_id, status, reward_templates(cost_estimate_cents)").eq("restaurant_id", restaurantId)
      .gte("created_at", monthStart.toISOString()).in("status", ["proposed", "approved", "issued"])
      .returns<{ reward_templates: { cost_estimate_cents: number } | null }[]>(),
    db.from("ai_recommendations").select("owner_feedback").eq("restaurant_id", restaurantId).eq("status", "rejected")
      .not("owner_feedback", "is", null).order("decided_at", { ascending: false }).limit(5),
  ]);

  const count = (rows: { membership_id: string }[] | null) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.membership_id, (m.get(r.membership_id) ?? 0) + 1);
    return m;
  };
  const open = count(openRewards);
  const recent = count(recentRecs);
  // A guest with an offer still waiting in the owner's inbox shouldn't get another one.
  const pending = count((recentRecs ?? []).filter((r) => r.status === "proposed"));
  let spent = (monthRecs ?? []).reduce((s, r) => s + (r.reward_templates?.cost_estimate_cents ?? 0), 0);

  const candidates: Candidate[] = [];
  for (const f of features ?? []) {
    const member: MemberSnapshot = {
      membershipId: f.membership_id,
      firstName: f.memberships.customers?.first_name ?? null,
      tier: f.memberships.tier,
      visitCount: f.memberships.visit_count,
      currentStreak: f.memberships.current_streak,
      segment: f.segment,
      recencyDays: f.recency_days,
      avgGapDays: f.avg_gap_days,
      churnRisk: f.churn_risk,
      favouriteItems: (f.favourite_items ?? []).map((i) => i.name).slice(0, 3),
      preferredDaypart: f.preferred_daypart,
      activeOfferRewards: (open.get(f.membership_id) ?? 0) + (pending.get(f.membership_id) ?? 0),
      offersThisWeek: recent.get(f.membership_id) ?? 0,
    };
    const c = pickCandidate(member, settings, opts.random);
    if (c) candidates.push(c);
    if (candidates.length >= MAX_OFFERS_PER_RUN) break;
  }
  summary.candidates = candidates.length;

  const ownerFeedback = (feedback ?? []).map((f) => String(f.owner_feedback).slice(0, 200));
  const work = candidates.map((c) => async () => {
    const eligible = eligibleTemplates(c, templates ?? [], settings);
    if (!eligible.length) return skip("no_eligible_reward");

    const ai = await draftOffer({ restaurant: { name: restaurant.name, currency: restaurant.currency, ownerFeedback }, candidate: c, eligible });
    let draft = ai?.draft ?? null;
    let check = draft ? checkGuardrails({ draft, eligible, settings, spentThisMonthCents: spent }) : null;
    if (draft && check && !check.ok) skip(`ai_draft_${check.reason}`);

    if (!draft || !check?.ok) {
      // Fall back to the cheapest eligible template that fits the budget, with plain copy.
      const fit = [...eligible].sort((a, b) => a.cost_estimate_cents - b.cost_estimate_cents)
        .find((t) => spent + t.cost_estimate_cents <= settings.monthly_reward_budget * 100);
      if (!fit) return skip("monthly_budget");
      draft = { templateId: fit.id, confidence: 0.5, ...defaultCopy(c, fit, restaurant.name) };
      check = checkGuardrails({ draft, eligible, settings, spentThisMonthCents: spent });
      if (!check.ok) return skip(check.reason);
    } else {
      summary.drafted_by_ai++;
    }

    spent += check.template.cost_estimate_cents;
    const { data: rec, error } = await db
      .from("ai_recommendations")
      .insert({
        restaurant_id: restaurantId,
        membership_id: c.member.membershipId,
        kind: c.kind,
        template_id: check.template.id,
        title: draft.title,
        message: draft.message,
        rationale: draft.rationale || c.reason,
        confidence: draft.confidence,
        model: ai && draft === ai.draft ? ai.model : "template",
        input_snapshot: { reason: c.reason, member: c.member, eligible: eligible.map((t) => t.id) },
      })
      .select("id")
      .single();
    if (error || !rec) return skip("insert_failed");
    summary.proposed++;

    if (settings.auto_issue) {
      const { error: issueErr } = await db.rpc("issue_recommendation", { p_recommendation_id: rec.id });
      if (!issueErr) {
        summary.issued++;
        await notifyReward(c.member.membershipId, draft.title, draft.message);
      }
    }
  });

  // Small worker pool: a handful of model calls at a time.
  const queue = [...work];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await queue.shift()!();
  }));
  return summary;
}
