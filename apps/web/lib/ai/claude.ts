import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { OfferDraft, type Candidate, type OfferTemplate } from "@loyalty/core";

export const OFFER_MODEL = "claude-opus-5-5";

let client: Anthropic | undefined;
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

export type OfferPrompt = {
  restaurant: { name: string; currency: string; ownerFeedback: string[] };
  candidate: Candidate;
  eligible: OfferTemplate[];
};

// Identical for every guest of a restaurant within a run, so it is cached after the first call.
function systemPrompt(r: OfferPrompt["restaurant"]) {
  return [
    `You write short, warm loyalty offers for guests of ${r.name}, a restaurant.`,
    "Choose exactly one reward template from the eligible list (use its id) and write a title and a message for this guest.",
    "Mention what they actually like when it fits. Never promise a discount, price, item or amount that is not the chosen",
    "template itself; never include links. The message is shown in their rewards wallet and may be sent as a phone",
    "notification, so keep it under 160 characters. Don't guilt-trip people about how long they've been away and don't",
    "mention tracking, data or scores. The rationale is for the owner: one sentence on why this guest and this reward.",
    "Confidence is how likely you think the offer brings them in (0 to 1).",
    r.ownerFeedback.length ? `The owner rejected earlier offers with this feedback; respect it: ${r.ownerFeedback.join(" | ")}` : "",
  ].join(" ");
}

/**
 * Ask Claude to pick a template and write the copy. Returns null when the model declines
 * or the output can't be used, so the caller falls back to template copy.
 */
export async function draftOffer(p: OfferPrompt): Promise<{ draft: OfferDraft; model: string } | null> {
  if (!aiConfigured()) return null;
  client ??= new Anthropic();
  const m = p.candidate.member;
  const guest = {
    offerType: p.candidate.kind,
    why: p.candidate.reason,
    firstName: m.firstName,
    tier: m.tier,
    visits: m.visitCount,
    daysSinceLastVisit: m.recencyDays,
    usualDaysBetweenVisits: m.avgGapDays,
    favouriteItems: m.favouriteItems,
    usualTimeOfDay: m.preferredDaypart,
    eligibleTemplates: p.eligible.map((t) => ({ id: t.id, name: t.name, kind: t.kind, value: t.value })),
    currency: p.restaurant.currency,
  };

  try {
    const response = await client.beta.messages.parse({
      model: OFFER_MODEL,
      max_tokens: 4000,
      // Low effort is plenty for short copy, and keeps the nightly run cheap.
      output_config: { effort: "low", format: betaZodOutputFormat(OfferDraft) },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: systemPrompt(p.restaurant), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(guest) }],
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) return null;
    return { draft: response.parsed_output, model: response.model };
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("offer draft failed", e.status, e.message, e.cause ?? "");
    else console.error("offer draft failed", e);
    return null;
  }
}
