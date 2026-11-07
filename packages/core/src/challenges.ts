import { z } from "zod";

export const DAYPARTS = ["breakfast", "lunch", "afternoon", "dinner", "late"] as const;
export type Daypart = (typeof DAYPARTS)[number];
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const withinDays = z.number().int().min(1).max(365).optional();

/** Rule shapes stored in challenges.rule, keyed by challenges.kind. Mirrors challenge_progress_value() in SQL. */
export const ChallengeRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visit_count"), rule: z.object({ visits: z.number().int().min(1).max(100), within_days: withinDays }) }),
  z.object({ kind: z.literal("spend_amount"), rule: z.object({ spend_cents: z.number().int().min(100).max(10_000_000), within_days: withinDays }) }),
  z.object({
    kind: z.literal("time_window"),
    rule: z.object({
      visits: z.number().int().min(1).max(100),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      daypart: z.enum(DAYPARTS).optional(),
      within_days: withinDays,
    }),
  }),
  z.object({ kind: z.literal("streak"), rule: z.object({ length: z.number().int().min(2).max(100) }) }),
  z.object({
    kind: z.literal("try_items"),
    rule: z
      .object({ menu_item_ids: z.array(z.guid()).min(1).max(20), need: z.number().int().min(1).max(20).optional(), within_days: withinDays })
      .refine((r) => (r.need ?? r.menu_item_ids.length) <= r.menu_item_ids.length, "need can't exceed the number of dishes"),
  }),
]);
export type ChallengeRule = z.infer<typeof ChallengeRule>;
export type ChallengeKind = ChallengeRule["kind"];

export type ChallengeProgress = { value: number; target: number; fraction: number; done: boolean };

/** Progress for display. Before the first evaluation there is no stored row, so value starts at 0. */
export function challengeProgress(
  c: ChallengeRule,
  stored: { value: number; target: number } | null,
  status: "active" | "completed" | "expired" | null,
  currentStreak = 0,
): ChallengeProgress {
  const target = stored?.target ?? challengeTarget(c);
  const value = c.kind === "streak" && status !== "completed" ? currentStreak : (stored?.value ?? 0);
  const done = status === "completed";
  return { value, target, done, fraction: done ? 1 : Math.min(1, target > 0 ? value / target : 0) };
}

export function challengeTarget(c: ChallengeRule): number {
  switch (c.kind) {
    case "visit_count":
    case "time_window":
      return c.rule.visits;
    case "spend_amount":
      return c.rule.spend_cents;
    case "streak":
      return c.rule.length;
    case "try_items":
      return c.rule.need ?? c.rule.menu_item_ids.length;
  }
}

/** Short human description of what the rule asks for, e.g. "2 visits · Mon, Tue · lunch". */
export function describeRule(c: ChallengeRule, formatMoney: (cents: number) => string): string {
  const days = (n?: number) => (n ? ` in ${n} days` : "");
  switch (c.kind) {
    case "visit_count":
      return `${plural(c.rule.visits, "visit")}${days(c.rule.within_days)}`;
    case "spend_amount":
      return `Spend ${formatMoney(c.rule.spend_cents)}${days(c.rule.within_days)}`;
    case "time_window": {
      const parts = [plural(c.rule.visits, "visit")];
      if (c.rule.weekdays) parts.push(c.rule.weekdays.map((d) => WEEKDAY_NAMES[d]).join(", "));
      if (c.rule.daypart) parts.push(c.rule.daypart);
      return parts.join(" · ") + days(c.rule.within_days);
    }
    case "streak":
      return `Reach a ${c.rule.length}-visit streak`;
    case "try_items": {
      const total = c.rule.menu_item_ids.length;
      const need = c.rule.need ?? total;
      return (need === total ? `Try ${plural(total, "dish", "dishes")}` : `Try ${need} of ${total} dishes`) + days(c.rule.within_days);
    }
  }
}

/** "1 / 3" or "£25.00 / £60.00", depending on the kind. */
export function progressLabel(c: ChallengeRule, p: ChallengeProgress, formatMoney: (cents: number) => string): string {
  if (c.kind === "spend_amount") return `${formatMoney(Math.min(p.value, p.target))} / ${formatMoney(p.target)}`;
  return `${Math.min(p.value, p.target)} / ${p.target}`;
}

/** The next streak milestone that pays a bonus, if any. */
export function nextStreakBonus(streak: number, bonuses: Record<string, number>): { at: number; points: number } | null {
  const next = Object.entries(bonuses)
    .map(([k, v]) => ({ at: Number(k), points: v }))
    .filter((b) => b.at > streak && b.points > 0)
    .sort((a, b) => a.at - b.at)[0];
  return next ?? null;
}

function plural(n: number, word: string, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}
