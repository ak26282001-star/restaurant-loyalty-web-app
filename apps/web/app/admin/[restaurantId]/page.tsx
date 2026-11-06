import { Suspense } from "react";
import Link from "next/link";
import { TIER_LABELS, type Tier } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getDashboard } from "@/lib/data/dashboard";
import { ActionForm } from "@/components/action-form";
import { createRewardTemplate, createTag, setTemplateActive } from "./actions";

export default function AdminDashboardPage(props: PageProps<"/admin/[restaurantId]">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading dashboard…</p>}>
      <Dashboard {...props} />
    </Suspense>
  );
}

async function Dashboard({ params }: PageProps<"/admin/[restaurantId]">) {
  const { restaurantId } = await params;
  const { supabase, restaurant } = await requireStaff(restaurantId, "manager", `/admin/${restaurantId}`);
  const { members, active30, visits7, redeemed30, recent, templates, tags, locations, currency } = await getDashboard(supabase, restaurantId);

  const kpis = [
    { label: "Members", value: members.count ?? 0 },
    { label: "Active (30 days)", value: active30.count ?? 0 },
    { label: "Visits (7 days)", value: visits7.count ?? 0 },
    { label: "Rewards redeemed (30 days)", value: redeemed30.count ?? 0 },
  ];
  const input = "rounded-lg border border-neutral-300 px-3 py-2 text-sm";
  const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500";

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{restaurant.name}</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href={`/r/${restaurant.slug}`}>Customer page</Link>
          <Link className="underline" href={`/staff/${restaurantId}`}>Staff mode</Link>
        </nav>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-3xl font-bold tabular-nums">{k.value}</p>
            <p className="text-sm text-neutral-500">{k.label}</p>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <h2 className="p-4 text-lg font-semibold">Recent visits</h2>
        {!recent.data?.length ? (
          <p className="px-4 pb-4 text-sm text-neutral-500">No visits yet. Print a QR code below to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50"><tr><th className={th}>Guest</th><th className={th}>When</th><th className={th}>Source</th><th className={th}>Bill</th><th className={th}>Status</th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {recent.data.map((v) => (
                  <tr key={v.id}>
                    <td className="px-4 py-2">{v.customers?.first_name ?? "Guest"}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(v.visited_at)}</td>
                    <td className="px-4 py-2 capitalize">{v.source}</td>
                    <td className="px-4 py-2">{v.spend_cents != null ? formatMoney(v.spend_cents, currency.data?.currency ?? "USD") : "—"}</td>
                    <td className="px-4 py-2 capitalize">{v.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Rewards catalogue</h2>
        <ul className="divide-y divide-neutral-100">
          {(templates.data ?? []).map((t) => (
            <li key={t.id} className={`flex items-center justify-between gap-3 py-2 ${t.is_active ? "" : "opacity-50"}`}>
              <div>
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-neutral-500">
                  {t.points_cost != null ? `${t.points_cost} points` : "Not sold for points"} · {TIER_LABELS[t.min_tier as Tier]}+ · valid {t.valid_days} days
                </p>
              </div>
              <ActionForm action={setTemplateActive}>
                <input type="hidden" name="restaurantId" value={restaurantId} />
                <input type="hidden" name="templateId" value={t.id} />
                <input type="hidden" name="active" value={String(!t.is_active)} />
                <button className="text-sm underline">{t.is_active ? "Hide" : "Show"}</button>
              </ActionForm>
            </li>
          ))}
        </ul>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Add a reward</summary>
          <ActionForm action={createRewardTemplate} className="mt-3 grid gap-3 sm:grid-cols-3">
            <input type="hidden" name="restaurantId" value={restaurantId} />
            <input name="name" placeholder="Name, e.g. Free espresso" className={`${input} sm:col-span-3`} required />
            <select name="kind" className={input} defaultValue="free_item">
              <option value="free_item">Free item</option>
              <option value="percent_off">% off</option>
              <option value="amount_off">Amount off</option>
              <option value="experience">Experience</option>
            </select>
            <input name="value" type="number" step="0.01" min="0" placeholder="Value (% or amount)" className={input} />
            <input name="points_cost" type="number" min="1" placeholder="Points cost" className={input} required />
            <select name="min_tier" className={input} defaultValue="member">
              {Object.entries(TIER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}+</option>)}
            </select>
            <input name="valid_days" type="number" min="1" max="365" defaultValue={14} className={input} aria-label="Valid for days" />
            <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Add reward</button>
          </ActionForm>
        </details>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold">Tags &amp; QR codes</h2>
        <p className="mb-3 text-sm text-neutral-500">
          Print the QR code, or write the tap URL to an NFC sticker (NTAG213/215) as a URL record with any NFC writer app.
        </p>
        <ul className="divide-y divide-neutral-100">
          {(tags.data ?? []).map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div>
                <p className="font-medium">{t.label ?? t.code} <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase">{t.kind}</span></p>
                <p className="font-mono text-xs text-neutral-500">/t/{t.code}{t.locations ? ` · ${t.locations.name}` : ""}</p>
              </div>
              <a className="text-sm underline" href={`/admin/${restaurantId}/tags/${t.id}/qr`} download={`qr-${t.code}.svg`}>Download QR</a>
            </li>
          ))}
        </ul>
        <ActionForm action={createTag} className="mt-4 flex flex-wrap gap-3">
          <input type="hidden" name="restaurantId" value={restaurantId} />
          <input name="label" placeholder="Label, e.g. Table 4" className={`${input} flex-1`} required />
          <select name="kind" className={input} defaultValue="qr"><option value="qr">QR code</option><option value="nfc">NFC sticker</option></select>
          <select name="locationId" className={input} defaultValue={locations.data?.[0]?.id ?? ""}>
            <option value="">No location</option>
            {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Create tag</button>
        </ActionForm>
      </section>
    </main>
  );
}
