"use client";

import { useState } from "react";
import { DAYPARTS, WEEKDAY_NAMES } from "@loyalty/core";
import { ActionForm } from "@/components/action-form";
import { createChallenge } from "@/app/admin/[restaurantId]/challenges/actions";

const KINDS = [
  { value: "visit_count", label: "Visit a number of times" },
  { value: "spend_amount", label: "Spend an amount" },
  { value: "time_window", label: "Visit on certain days / times" },
  { value: "streak", label: "Reach a streak" },
  { value: "try_items", label: "Try specific dishes" },
] as const;

export function ChallengeForm({ restaurantId, rewards, currency, dishes }: {
  restaurantId: string;
  rewards: { id: string; name: string }[];
  currency: string;
  dishes: { id: string; name: string }[];
}) {
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("visit_count");
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-neutral-600";

  return (
    <ActionForm action={createChallenge} className="grid gap-3 sm:grid-cols-2" onReset={() => setKind("visit_count")}>
      <input type="hidden" name="restaurantId" value={restaurantId} />
      <div className="sm:col-span-2">
        <label className={label} htmlFor="title">Title</label>
        <input id="title" name="title" placeholder="e.g. Hat-trick" className={input} required />
      </div>
      <div className="sm:col-span-2">
        <label className={label} htmlFor="description">Description shown to guests (optional)</label>
        <input id="description" name="description" placeholder="Visit 3 times in 2 weeks and dessert is on us" className={input} />
      </div>
      <div className="sm:col-span-2">
        <label className={label} htmlFor="kind">Goal</label>
        <select id="kind" name="kind" className={input} defaultValue="visit_count" onChange={(e) => setKind(e.target.value as typeof kind)}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>

      {(kind === "visit_count" || kind === "time_window") && (
        <div>
          <label className={label} htmlFor="visits">Number of visits</label>
          <input id="visits" name="visits" type="number" min={1} max={100} defaultValue={3} className={input} required />
        </div>
      )}
      {kind === "spend_amount" && (
        <div>
          <label className={label} htmlFor="spend">Total spend ({currency})</label>
          <input id="spend" name="spend" type="number" min={1} step="0.01" placeholder="60" className={input} required />
        </div>
      )}
      {kind === "streak" && (
        <div>
          <label className={label} htmlFor="length">Streak length (visits)</label>
          <input id="length" name="length" type="number" min={2} max={100} defaultValue={4} className={input} required />
        </div>
      )}
      {kind === "try_items" && (
        <>
          <fieldset className="sm:col-span-2">
            <legend className={label}>Dishes {dishes.length === 0 && "(connect your POS or sync the menu first)"}</legend>
            <div className="mt-1 flex max-h-48 flex-wrap gap-2 overflow-y-auto">
              {dishes.map((d) => (
                <label key={d.id} className="flex items-center gap-1 rounded-lg border border-neutral-300 px-2 py-1 text-sm">
                  <input type="checkbox" name="dishes" value={d.id} /> {d.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label className={label} htmlFor="need">How many of them (optional, default all)</label>
            <input id="need" name="need" type="number" min={1} max={20} className={input} />
          </div>
        </>
      )}
      {kind !== "streak" && (
        <div>
          <label className={label} htmlFor="within_days">Within how many days (optional)</label>
          <input id="within_days" name="within_days" type="number" min={1} max={365} placeholder="e.g. 14" className={input} />
        </div>
      )}
      {kind === "time_window" && (
        <>
          <fieldset className="sm:col-span-2">
            <legend className={label}>Days</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAY_NAMES.map((d, i) => (
                <label key={d} className="flex items-center gap-1 rounded-lg border border-neutral-300 px-2 py-1 text-sm">
                  <input type="checkbox" name="weekdays" value={i} /> {d}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label className={label} htmlFor="daypart">Time of day</label>
            <select id="daypart" name="daypart" className={input} defaultValue="">
              <option value="">Any time</option>
              {DAYPARTS.map((d) => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
            </select>
          </div>
        </>
      )}

      <div>
        <label className={label} htmlFor="bonus_points">Bonus points</label>
        <input id="bonus_points" name="bonus_points" type="number" min={0} defaultValue={50} className={input} />
      </div>
      <div>
        <label className={label} htmlFor="reward_template_id">Reward (optional)</label>
        <select id="reward_template_id" name="reward_template_id" className={input} defaultValue="">
          <option value="">No reward</option>
          {rewards.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="ends_on">Ends on (optional)</label>
        <input id="ends_on" name="ends_on" type="date" className={input} />
      </div>
      <div className="flex items-end">
        <button className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Launch challenge</button>
      </div>
    </ActionForm>
  );
}
