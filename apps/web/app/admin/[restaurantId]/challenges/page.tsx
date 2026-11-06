import { Suspense } from "react";
import { ChallengeRule, describeRule } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { getChallengeAdmin } from "@/lib/data/challenges";
import { ActionForm } from "@/components/action-form";
import { AdminNav } from "@/components/admin-nav";
import { ChallengeForm } from "@/components/challenge-form";
import { setChallengeActive } from "./actions";

export default function ChallengesPage(props: PageProps<"/admin/[restaurantId]/challenges">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading challenges…</p>}>
      <Challenges {...props} />
    </Suspense>
  );
}

async function Challenges({ params }: PageProps<"/admin/[restaurantId]/challenges">) {
  const { restaurantId } = await params;
  const { supabase, restaurant } = await requireStaff(restaurantId, "manager", `/admin/${restaurantId}/challenges`);
  const { challenges, stats, rewards, currency } = await getChallengeAdmin(supabase, restaurantId);
  const money = (c: number) => formatMoney(c, currency);

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <AdminNav restaurantId={restaurantId} name={restaurant.name} slug={restaurant.slug} current="/challenges" />

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold">Challenges</h2>
        <p className="mb-3 text-sm text-neutral-500">Progress updates on every confirmed visit. Each guest can complete a challenge once.</p>
        {challenges.length === 0 ? (
          <p className="text-sm text-neutral-500">No challenges yet. Launch your first one below.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {challenges.map((c) => {
              const rule = ChallengeRule.safeParse({ kind: c.kind, rule: c.rule });
              const s = stats.get(c.id) ?? { joined: 0, completed: 0 };
              const prize = [c.reward_templates?.name, c.bonus_points ? `+${c.bonus_points} pts` : null].filter(Boolean).join(" + ");
              return (
                <li key={c.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${c.is_active ? "" : "opacity-50"}`}>
                  <div className="min-w-0">
                    <p className="font-medium">{c.title}</p>
                    <p className="text-xs text-neutral-500">
                      {rule.success ? describeRule(rule.data, money) : c.kind} · prize: {prize || "none"}
                      {c.ends_at ? ` · ends ${formatDate(c.ends_at)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-5 text-sm">
                    <span><strong className="tabular-nums">{s.joined}</strong> <span className="text-neutral-500">in progress</span></span>
                    <span><strong className="tabular-nums">{s.completed}</strong> <span className="text-neutral-500">completed</span></span>
                    <ActionForm action={setChallengeActive}>
                      <input type="hidden" name="restaurantId" value={restaurantId} />
                      <input type="hidden" name="challengeId" value={c.id} />
                      <input type="hidden" name="active" value={String(!c.is_active)} />
                      <button className="underline">{c.is_active ? "Pause" : "Resume"}</button>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">New challenge</h2>
        <ChallengeForm restaurantId={restaurantId} rewards={rewards} currency={currency} />
      </section>
    </main>
  );
}
