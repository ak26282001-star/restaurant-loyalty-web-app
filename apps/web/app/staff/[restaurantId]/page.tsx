import { Suspense } from "react";
import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getPendingVisits, getRecentlyConfirmed } from "@/lib/data/staff";
import { ActionForm } from "@/components/action-form";
import { confirmVisit, redeemReward, rejectVisit } from "./actions";

export default function StaffPage(props: PageProps<"/staff/[restaurantId]">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading…</p>}>
      <StaffMode {...props} />
    </Suspense>
  );
}

async function StaffMode({ params }: PageProps<"/staff/[restaurantId]">) {
  const { restaurantId } = await params;
  const { supabase, restaurant, role } = await requireStaff(restaurantId, "staff", `/staff/${restaurantId}`);

  const [pending, confirmed] = await Promise.all([
    getPendingVisits(supabase, restaurantId),
    getRecentlyConfirmed(supabase, restaurantId),
  ]);

  const input = "rounded-xl border border-neutral-300 px-4 py-3 text-lg";

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{restaurant.name} · Staff</h1>
        {role !== "staff" && <Link href={`/admin/${restaurantId}`} className="text-sm underline">Dashboard</Link>}
      </header>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Redeem a reward</h2>
        <ActionForm action={redeemReward} className="flex flex-wrap gap-3">
          <input type="hidden" name="restaurantId" value={restaurantId} />
          <input name="code" placeholder="e.g. 3F9A1C2B" autoComplete="off" autoCapitalize="characters" className={`${input} min-w-0 flex-1 font-mono uppercase tracking-widest`} required />
          <button className="rounded-xl bg-neutral-900 px-6 py-3 text-lg font-semibold text-white">Redeem</button>
        </ActionForm>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Visits waiting for confirmation</h2>
        {!pending.length ? (
          <p className="rounded-2xl bg-white p-5 text-neutral-500 shadow-sm">Nothing to confirm right now.</p>
        ) : (
          <ul className="space-y-3">
            {pending.map((v) => (
              <li key={v.id} className="rounded-2xl bg-white p-5 shadow-sm">
                <p className="text-lg font-semibold">
                  {v.customers?.first_name ?? "Guest"}
                  {v.customers?.phone && <span className="ml-2 font-normal text-neutral-500">···{v.customers.phone.slice(-4)}</span>}
                </p>
                <p className="text-sm text-neutral-500">Tapped {formatDateTime(v.visited_at)}</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <ActionForm action={confirmVisit} className="flex flex-1 flex-wrap gap-3">
                    <input type="hidden" name="restaurantId" value={restaurantId} />
                    <input type="hidden" name="visitId" value={v.id} />
                    <input name="spend" inputMode="decimal" placeholder="Bill (optional)" className={`${input} w-40`} />
                    <button className="rounded-xl bg-emerald-600 px-6 py-3 text-lg font-semibold text-white">Confirm</button>
                  </ActionForm>
                  <ActionForm action={rejectVisit}>
                    <input type="hidden" name="restaurantId" value={restaurantId} />
                    <input type="hidden" name="visitId" value={v.id} />
                    <button className="rounded-xl border border-neutral-300 px-6 py-3 text-lg">Reject</button>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmed.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Just confirmed</h2>
          <ul className="divide-y divide-neutral-100 rounded-2xl bg-white shadow-sm">
            {confirmed.map((v) => (
              <li key={v.id} className="flex items-center justify-between p-4">
                <span>
                  {v.first_name ?? "Guest"} <span className="text-sm text-neutral-500">· {formatDateTime(v.visited_at)}</span>
                </span>
                <span className="font-semibold text-emerald-700">{v.points != null ? `+${v.points} pts` : "✓"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
