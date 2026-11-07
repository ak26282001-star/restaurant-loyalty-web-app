import { Suspense } from "react";
import { parseSettings } from "@loyalty/core";
import { requireStaff } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { AdminNav } from "@/components/admin-nav";
import { saveSettings } from "./actions";

export default function SettingsPage(props: PageProps<"/admin/[restaurantId]/settings">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading settings…</p>}>
      <Settings {...props} />
    </Suspense>
  );
}

async function Settings({ params }: PageProps<"/admin/[restaurantId]/settings">) {
  const { restaurantId } = await params;
  const { supabase, restaurant } = await requireStaff(restaurantId, "owner", `/admin/${restaurantId}/settings`);
  const { data } = await supabase.from("restaurants").select("settings, currency").eq("id", restaurantId).single<{ settings: unknown; currency: string }>();
  const s = parseSettings(data?.settings);
  const callingCode = (data?.settings as { country_calling_code?: string } | null)?.country_calling_code ?? "";
  const bonuses = Object.entries(s.streak_bonuses).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${k}=${v}`).join(", ");

  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm";
  const label = "block text-sm font-medium";
  const hint = "text-xs text-neutral-500";

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <AdminNav restaurantId={restaurantId} name={restaurant.name} slug={restaurant.slug} current="/settings" />
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Loyalty rules</h2>
        <ActionForm action={saveSettings} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="restaurantId" value={restaurantId} />
          <div>
            <label className={label} htmlFor="points_per_visit">Points per visit</label>
            <input id="points_per_visit" name="points_per_visit" type="number" min={0} defaultValue={s.points_per_visit} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="points_per_currency_unit">Points per {data?.currency ?? "unit"} spent</label>
            <input id="points_per_currency_unit" name="points_per_currency_unit" type="number" min={0} step="0.1" defaultValue={s.points_per_currency_unit} className={input} />
            <p className={hint}>Only applies when staff enter the bill.</p>
          </div>
          <div>
            <label className={label} htmlFor="visit_cooldown_minutes">Minutes between visits</label>
            <input id="visit_cooldown_minutes" name="visit_cooldown_minutes" type="number" min={15} defaultValue={s.visit_cooldown_minutes} className={input} />
            <p className={hint}>Stops repeat check-ins in one sitting.</p>
          </div>
          <div>
            <label className={label} htmlFor="streak_window_days">Streak window (days)</label>
            <input id="streak_window_days" name="streak_window_days" type="number" min={1} defaultValue={s.streak_window_days} className={input} />
            <p className={hint}>Guests keep their streak by returning within this many days.</p>
          </div>
          <fieldset className="sm:col-span-2">
            <legend className={label}>Tiers (visits needed)</legend>
            <div className="mt-1 grid grid-cols-3 gap-3">
              {([["tier_regular", "Regular", s.tiers.regular], ["tier_vip", "VIP", s.tiers.vip], ["tier_legend", "Legend", s.tiers.legend]] as const).map(([name, text, value]) => (
                <label key={name} className="text-xs text-neutral-600">{text}
                  <input name={name} type="number" min={1} defaultValue={value} className={input} />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="streak_bonuses">Streak bonuses</label>
            <input id="streak_bonuses" name="streak_bonuses" defaultValue={bonuses} placeholder="3=20, 5=50, 10=100" className={input} />
            <p className={hint}>Streak length = bonus points. Leave empty for no streak bonuses.</p>
          </div>
          <div>
            <label className={label} htmlFor="country_calling_code">Country calling code</label>
            <input id="country_calling_code" name="country_calling_code" inputMode="numeric" placeholder="e.g. 44, 1, 91" defaultValue={callingCode} className={input} />
            <p className={hint}>Used to match phone numbers on POS orders that were typed without +country.</p>
          </div>
          <div className="sm:col-span-2">
            <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Save settings</button>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}
