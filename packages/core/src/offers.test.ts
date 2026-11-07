import { describe, expect, it } from "vitest";
import { checkGuardrails, defaultCopy, eligibleTemplates, parseAiSettings, pickCandidate, type MemberSnapshot, type OfferTemplate } from "./index";

const settings = parseAiSettings({});
const member = (over: Partial<MemberSnapshot> = {}): MemberSnapshot => ({
  membershipId: "m1", firstName: "Ada", tier: "regular", visitCount: 6, currentStreak: 0, segment: "lapsed",
  recencyDays: 40, avgGapDays: 7, churnRisk: 0.95, favouriteItems: ["carrot cake"], preferredDaypart: "lunch",
  activeOfferRewards: 0, offersThisWeek: 0, ...over,
});
const tpl = (over: Partial<OfferTemplate>): OfferTemplate => ({
  id: "t", name: "Free coffee", kind: "free_item", value: null, min_tier: "member", cost_estimate_cents: 150, ai_eligible: true, is_active: true, ...over,
});
const templates = [
  tpl({ id: "coffee", name: "Free coffee", cost_estimate_cents: 150 }),
  tpl({ id: "dessert", name: "Free dessert", cost_estimate_cents: 400 }),
  tpl({ id: "pct20", name: "20% off", kind: "percent_off", value: 20, cost_estimate_cents: 900 }),
  tpl({ id: "pct40", name: "40% off", kind: "percent_off", value: 40, cost_estimate_cents: 1500 }),
  tpl({ id: "chef", name: "Chef's table", kind: "experience", min_tier: "vip", cost_estimate_cents: 2500 }),
  tpl({ id: "hidden", name: "Hidden", ai_eligible: false }),
];

describe("pickCandidate", () => {
  it("wins back lapsed and at-risk guests", () => {
    expect(pickCandidate(member(), settings)).toMatchObject({ kind: "winback", reason: "Lapsed: last visit 40 days ago (usually every 7 days)" });
    expect(pickCandidate(member({ segment: "at_risk", recencyDays: 12 }), settings)?.kind).toBe("winback");
  });
  it("respects open offers and the weekly cap", () => {
    expect(pickCandidate(member({ activeOfferRewards: 1 }), settings)).toBeNull();
    expect(pickCandidate(member({ offersThisWeek: 2 }), settings)).toBeNull();
  });
  it("nudges first-timers to a second visit, but not on day one", () => {
    expect(pickCandidate(member({ segment: "new", visitCount: 1, recencyDays: 5 }), settings)?.kind).toBe("surprise");
    expect(pickCandidate(member({ segment: "new", visitCount: 1, recencyDays: 0 }), settings)).toBeNull();
  });
  it("uses the random draw for VIPs and regulars", () => {
    expect(pickCandidate(member({ segment: "vip", tier: "vip" }), settings, () => 0.1)?.kind).toBe("vip");
    expect(pickCandidate(member({ segment: "vip", tier: "vip" }), settings, () => 0.9)).toBeNull();
    expect(pickCandidate(member({ segment: "regular" }), settings, () => 0.01)?.kind).toBe("surprise");
    expect(pickCandidate(member({ segment: "regular" }), settings, () => 0.5)).toBeNull();
  });
});

describe("eligibleTemplates", () => {
  it("drops over-cap discounts, tier-locked and non-AI templates; winback prefers bigger rewards", () => {
    const ids = eligibleTemplates({ member: member(), kind: "winback", reason: "" }, templates, settings).map((t) => t.id);
    expect(ids).toEqual(["pct20", "dessert", "coffee"]);
  });
  it("surprise prefers cheap rewards; VIPs get experiences first", () => {
    expect(eligibleTemplates({ member: member(), kind: "surprise", reason: "" }, templates, settings)[0].id).toBe("coffee");
    expect(eligibleTemplates({ member: member({ tier: "vip" }), kind: "vip", reason: "" }, templates, settings)[0].id).toBe("chef");
  });
});

describe("checkGuardrails", () => {
  const eligible = templates.slice(0, 3);
  const draft = { templateId: "pct20", title: "We miss you", message: "Ada, 20% off your next visit this week.", rationale: "lapsed", confidence: 0.8 };
  const base = { eligible, settings, spentThisMonthCents: 0 };
  it("accepts a good draft", () => expect(checkGuardrails({ ...base, draft })).toMatchObject({ ok: true }));
  it("rejects a template the rules didn't offer", () => {
    expect(checkGuardrails({ ...base, draft: { ...draft, templateId: "pct40" } })).toEqual({ ok: false, reason: "template_not_eligible" });
  });
  it("rejects copy that promises a different value", () => {
    expect(checkGuardrails({ ...base, draft: { ...draft, message: "50% off everything!" } })).toEqual({ ok: false, reason: "copy_claims_other_value" });
    expect(checkGuardrails({ ...base, draft: { ...draft, templateId: "coffee", message: "Free coffee worth £5" } })).toEqual({ ok: false, reason: "copy_claims_other_value" });
  });
  it("rejects links and blown budgets", () => {
    expect(checkGuardrails({ ...base, draft: { ...draft, message: "20% off at https://x.co" } })).toEqual({ ok: false, reason: "copy_contains_link" });
    expect(checkGuardrails({ ...base, draft, spentThisMonthCents: 49_500 })).toEqual({ ok: false, reason: "monthly_budget" });
  });
});

describe("defaultCopy", () => {
  it("writes safe copy within limits", () => {
    const c = defaultCopy({ member: member(), kind: "winback", reason: "Lapsed" }, templates[1], "Demo Bistro");
    expect(c.message).toBe("Ada, it's been a while! Come back to Demo Bistro for your carrot cake. Free dessert is on us this week.");
    expect(checkGuardrails({ draft: { ...c, templateId: "dessert", confidence: 1 }, eligible: templates, settings, spentThisMonthCents: 0 }).ok).toBe(true);
  });
});
