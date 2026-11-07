import { z } from "zod";
import { tierRank, type Tier } from "./tiers";

/** AI guardrail settings, stored in restaurants.settings.ai. */
export const AiSettings = z.object({
  enabled: z.boolean().default(true),
  auto_issue: z.boolean().default(false),
  max_discount_percent: z.number().min(0).max(100).default(25),
  max_offers_per_customer_per_week: z.number().int().min(0).max(14).default(2),
  monthly_reward_budget: z.number().min(0).default(500), // in the restaurant's currency
});
export type AiSettings = z.infer<typeof AiSettings>;
export const parseAiSettings = (raw: unknown) => AiSettings.parse(raw ?? {});

export type OfferKind = "winback" | "vip" | "surprise";
export type Segment = "new" | "regular" | "vip" | "at_risk" | "lapsed";

export type MemberSnapshot = {
  membershipId: string;
  firstName: string | null;
  tier: Tier;
  visitCount: number;
  currentStreak: number;
  segment: Segment;
  recencyDays: number | null;
  avgGapDays: number | null;
  churnRisk: number | null;
  favouriteItems: string[];
  preferredDaypart: string | null;
  activeOfferRewards: number; // unredeemed AI rewards in the wallet
  offersThisWeek: number; // AI recommendations created in the last 7 days
};

export type OfferTemplate = {
  id: string;
  name: string;
  kind: "free_item" | "percent_off" | "amount_off" | "points_multiplier" | "experience";
  value: number | null;
  min_tier: Tier;
  cost_estimate_cents: number;
  ai_eligible: boolean;
  is_active: boolean;
};

export type Candidate = { member: MemberSnapshot; kind: OfferKind; reason: string };

/**
 * Who should get an offer, and of what kind. Deterministic apart from the small random
 * "surprise & delight" draw (pass `random` to make it reproducible).
 */
export function pickCandidate(m: MemberSnapshot, settings: AiSettings, random: () => number = Math.random): Candidate | null {
  if (m.activeOfferRewards > 0) return null; // one open AI offer at a time
  if (m.offersThisWeek >= settings.max_offers_per_customer_per_week) return null;
  const usual = m.avgGapDays ? ` (usually every ${Math.round(m.avgGapDays)} days)` : "";

  switch (m.segment) {
    case "lapsed":
      return { member: m, kind: "winback", reason: `Lapsed: last visit ${m.recencyDays} days ago${usual}` };
    case "at_risk":
      return { member: m, kind: "winback", reason: `At risk: ${m.recencyDays} days since last visit${usual}` };
    case "vip":
      return random() < 0.25 ? { member: m, kind: "vip", reason: `VIP (${m.tier}) with ${m.visitCount} visits` } : null;
    case "new":
      if (m.visitCount === 1 && m.recencyDays !== null && m.recencyDays >= 3 && m.recencyDays <= 21) {
        return { member: m, kind: "surprise", reason: "First visit only: nudge a second one" };
      }
      return null;
    case "regular":
      return random() < 0.05 ? { member: m, kind: "surprise", reason: "Random surprise for a regular" } : null;
  }
}

/** Templates the model may choose from for this candidate, best first. */
export function eligibleTemplates(c: Candidate, templates: OfferTemplate[], settings: AiSettings): OfferTemplate[] {
  const ok = templates.filter(
    (t) =>
      t.is_active &&
      t.ai_eligible &&
      tierRank(c.member.tier) >= tierRank(t.min_tier) &&
      !(t.kind === "percent_off" && (t.value ?? 0) > settings.max_discount_percent),
  );
  const byCost = (dir: 1 | -1) => (a: OfferTemplate, b: OfferTemplate) => dir * (a.cost_estimate_cents - b.cost_estimate_cents);
  switch (c.kind) {
    case "winback":
      return ok.sort(byCost(-1)).slice(0, 4); // worth more to bring someone back
    case "vip":
      return ok.sort((a, b) => Number(b.kind === "experience") - Number(a.kind === "experience") || byCost(-1)(a, b)).slice(0, 4);
    case "surprise":
      return ok.sort(byCost(1)).slice(0, 3); // small, cheap delights
  }
}

/** What the model returns. Shared by the API call (structured output) and validation. */
export const OfferDraft = z.object({
  templateId: z.string(),
  title: z.string().min(2).max(40),
  message: z.string().min(5).max(160),
  rationale: z.string().max(300),
  confidence: z.number().min(0).max(1),
});
export type OfferDraft = z.infer<typeof OfferDraft>;

const MONEY_OR_PERCENT = /(\d+(?:[.,]\d+)?\s*%|[$£€₹]\s*\d+)/g;

export type GuardrailInput = {
  draft: OfferDraft;
  eligible: OfferTemplate[];
  settings: AiSettings;
  spentThisMonthCents: number; // cost of AI rewards proposed or issued this month
};

/** Checks every offer must pass before it reaches the owner or a guest. */
export function checkGuardrails(g: GuardrailInput): { ok: true; template: OfferTemplate } | { ok: false; reason: string } {
  const template = g.eligible.find((t) => t.id === g.draft.templateId);
  if (!template) return { ok: false, reason: "template_not_eligible" };
  if (g.spentThisMonthCents + template.cost_estimate_cents > g.settings.monthly_reward_budget * 100) {
    return { ok: false, reason: "monthly_budget" };
  }
  // The copy may not promise a value other than the template's own.
  const claims = `${g.draft.title} ${g.draft.message}`.match(MONEY_OR_PERCENT) ?? [];
  const allowed = template.value != null ? String(template.value).replace(/\.0+$/, "") : null;
  if (claims.some((c) => !allowed || c.replace(/[^\d.,]/g, "").replace(",", ".") !== allowed)) {
    return { ok: false, reason: "copy_claims_other_value" };
  }
  if (/https?:\/\/|www\./i.test(g.draft.message)) return { ok: false, reason: "copy_contains_link" };
  return { ok: true, template };
}

/** Plain, safe copy used when no model is configured or its draft fails the guardrails. */
export function defaultCopy(c: Candidate, t: OfferTemplate, restaurantName: string): Omit<OfferDraft, "templateId" | "confidence"> {
  const name = c.member.firstName ? `${c.member.firstName}, ` : "";
  const fav = c.member.favouriteItems[0];
  switch (c.kind) {
    case "winback":
      return {
        title: "We've missed you",
        message: `${name}it's been a while! Come back to ${restaurantName}${fav ? ` for your ${fav}` : ""}. ${t.name} is on us this week.`.slice(0, 160),
        rationale: c.reason,
      };
    case "vip":
      return { title: "A thank-you for you", message: `${name}you're one of our favourite regulars. Enjoy: ${t.name}.`.slice(0, 160), rationale: c.reason };
    case "surprise":
      return { title: "A little surprise", message: `${name}just because: ${t.name} on your next visit to ${restaurantName}.`.slice(0, 160), rationale: c.reason };
  }
}
