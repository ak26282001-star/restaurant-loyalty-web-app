import { Suspense } from "react";
import { parseAiSettings } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { aiConfigured } from "@/lib/ai/claude";
import { getAiInbox } from "@/lib/data/ai";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ActionForm } from "@/components/action-form";
import { AdminNav } from "@/components/admin-nav";
import { approveOffer, generateOffersNow, rejectOffer, saveAiSettings } from "./actions";

const SEGMENTS: [string, string, string][] = [
  ["new", "New", "1–2 visits, recently"],
  ["regular", "Regular", "Coming back on their usual rhythm"],
  ["vip", "VIP", "Top tier and still regular"],
  ["at_risk", "At risk", "Later than usual (1.5–3× their normal gap)"],
  ["lapsed", "Lapsed", "Much later than usual, or 90+ days away"],
];
const KIND_LABEL: Record<string, string> = { winback: "Win-back", vip: "VIP thank-you", surprise: "Surprise" };

export default function AiPage(props: PageProps<"/admin/[restaurantId]/ai">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading…</p>}>
      <Ai {...props} />
    </Suspense>
  );
}

async function Ai({ params }: PageProps<"/admin/[restaurantId]/ai">) {
  const { restaurantId } = await params;
  const { supabase, restaurant, role } = await requireStaff(restaurantId, "manager", `/admin/${restaurantId}/ai`);
  const { proposed, recent, segmentCounts, currency, aiSettings } = await getAiInbox(supabase, restaurantId);
  const ai = parseAiSettings(aiSettings);
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm";

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <AdminNav restaurantId={restaurantId} name={restaurant.name} slug={restaurant.slug} current="/ai" />

      <section>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SEGMENTS.map(([key, label, hint]) => (
            <div key={key} className="rounded-2xl bg-white p-4 shadow-sm" title={hint}>
              <p className="text-2xl font-bold tabular-nums">{segmentCounts[key] ?? 0}</p>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-neutral-500">{hint}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">Segments refresh every night and whenever you generate offers.</p>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Offers to review</h2>
            <p className="text-sm text-neutral-500">
              {ai.auto_issue ? "Auto-send is on: new offers go straight to guests." : "Nothing reaches a guest until you approve it."}
              {!aiConfigured() && " AI copywriting is off (no API key), so offers use standard wording."}
            </p>
          </div>
          <ActionForm action={generateOffersNow}>
            <input type="hidden" name="restaurantId" value={restaurantId} />
            <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white" disabled={!ai.enabled}>Generate offers now</button>
          </ActionForm>
        </div>
        {proposed.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No offers waiting.</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100">
            {proposed.map((r) => (
              <li key={r.id} className="py-4" data-testid="offer">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 max-w-xl">
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                      {KIND_LABEL[r.kind] ?? r.kind} · {r.memberships?.customers?.first_name ?? "Guest"} · {r.memberships?.visit_count ?? 0} visits
                    </p>
                    <p className="mt-1 font-semibold">{r.title}</p>
                    <p className="text-sm">{r.message}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      Reward: {r.reward_templates?.name} (≈{formatMoney(r.reward_templates?.cost_estimate_cents ?? 0, currency)}) ·{" "}
                      {r.model === "template" ? "standard wording" : "written by AI"}
                      {r.confidence != null ? ` · ${Math.round(r.confidence * 100)}% confidence` : ""}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">Why: {r.rationale}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <ActionForm action={approveOffer}>
                      <input type="hidden" name="restaurantId" value={restaurantId} />
                      <input type="hidden" name="recommendationId" value={r.id} />
                      <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">Approve &amp; send</button>
                    </ActionForm>
                    <ActionForm action={rejectOffer} className="flex gap-2">
                      <input type="hidden" name="restaurantId" value={restaurantId} />
                      <input type="hidden" name="recommendationId" value={r.id} />
                      <input name="feedback" placeholder="Why not? (optional)" maxLength={200} className="w-44 rounded-lg border border-neutral-300 px-2 py-1 text-sm" aria-label="Rejection feedback" />
                      <button className="rounded-lg border border-neutral-300 px-3 py-1 text-sm">Reject</button>
                    </ActionForm>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-lg font-semibold">Recent decisions</h2>
          <ul className="divide-y divide-neutral-100 text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{r.memberships?.customers?.first_name ?? "Guest"}: {r.title}</span>
                <span className="text-neutral-500">
                  {r.status === "rejected" ? "Rejected" : r.rewards?.status === "redeemed" ? "✅ Redeemed" : "Sent, not used yet"} · {formatDateTime(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {role === "owner" && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Guardrails</h2>
          <ActionForm action={saveAiSettings} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="restaurantId" value={restaurantId} />
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="enabled" defaultChecked={ai.enabled} /> Generate AI offers</label>
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="auto_issue" defaultChecked={ai.auto_issue} /> Send offers automatically (skip my approval)</label>
            <label className="text-sm">Max discount (%)<input name="max_discount_percent" type="number" min={0} max={100} defaultValue={ai.max_discount_percent} className={input} /></label>
            <label className="text-sm">Max offers per guest per week<input name="max_offers_per_customer_per_week" type="number" min={0} max={14} defaultValue={ai.max_offers_per_customer_per_week} className={input} /></label>
            <label className="text-sm">Monthly reward budget ({currency})<input name="monthly_reward_budget" type="number" min={0} defaultValue={ai.monthly_reward_budget} className={input} /></label>
            <div className="sm:col-span-3"><button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Save guardrails</button></div>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
