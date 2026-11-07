import { describe, expect, it } from "vitest";
import { ChallengeRule, challengeProgress, describeRule, nextStreakBonus, parseSettings, progressLabel } from "./index";

const gbp = (c: number) => `£${(c / 100).toFixed(2)}`;

describe("ChallengeRule", () => {
  it("accepts each kind", () => {
    for (const c of [
      { kind: "visit_count", rule: { visits: 3, within_days: 14 } },
      { kind: "spend_amount", rule: { spend_cents: 6000 } },
      { kind: "time_window", rule: { visits: 2, weekdays: [1, 2], daypart: "lunch" } },
      { kind: "streak", rule: { length: 4 } },
    ]) expect(ChallengeRule.safeParse(c).success).toBe(true);
  });
  it("accepts try_items with dish ids", () => {
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    expect(ChallengeRule.safeParse({ kind: "try_items", rule: { menu_item_ids: ids, need: 2 } }).success).toBe(true);
    expect(ChallengeRule.safeParse({ kind: "try_items", rule: { menu_item_ids: ids, need: 3 } }).success).toBe(false);
    expect(describeRule({ kind: "try_items", rule: { menu_item_ids: ids } }, gbp)).toBe("Try 2 dishes");
    expect(describeRule({ kind: "try_items", rule: { menu_item_ids: [...ids, ids[0].replace(/1/g, "3")], need: 2, within_days: 30 } }, gbp)).toBe("Try 2 of 3 dishes in 30 days");
  });
  it("rejects bad rules", () => {
    expect(ChallengeRule.safeParse({ kind: "visit_count", rule: { visits: 0 } }).success).toBe(false);
    expect(ChallengeRule.safeParse({ kind: "time_window", rule: { visits: 1, weekdays: [7] } }).success).toBe(false);
    expect(ChallengeRule.safeParse({ kind: "time_window", rule: { visits: 1, daypart: "brunch" } }).success).toBe(false);
    expect(ChallengeRule.safeParse({ kind: "try_items", rule: { menu_item_ids: [] } }).success).toBe(false);
  });
});

describe("describeRule", () => {
  it("describes rules in plain words", () => {
    expect(describeRule({ kind: "visit_count", rule: { visits: 3, within_days: 14 } }, gbp)).toBe("3 visits in 14 days");
    expect(describeRule({ kind: "visit_count", rule: { visits: 1 } }, gbp)).toBe("1 visit");
    expect(describeRule({ kind: "spend_amount", rule: { spend_cents: 6000, within_days: 30 } }, gbp)).toBe("Spend £60.00 in 30 days");
    expect(describeRule({ kind: "time_window", rule: { visits: 2, weekdays: [1, 2], daypart: "lunch" } }, gbp)).toBe("2 visits · Mon, Tue · lunch");
    expect(describeRule({ kind: "streak", rule: { length: 4 } }, gbp)).toBe("Reach a 4-visit streak");
  });
});

describe("challengeProgress", () => {
  const visits = { kind: "visit_count", rule: { visits: 3 } } as const;
  it("starts at zero before any evaluation", () => {
    expect(challengeProgress(visits, null, null)).toEqual({ value: 0, target: 3, fraction: 0, done: false });
  });
  it("uses the stored value", () => {
    const p = challengeProgress(visits, { value: 2, target: 3 }, "active");
    expect(p.fraction).toBeCloseTo(2 / 3);
    expect(progressLabel(visits, p, gbp)).toBe("2 / 3");
  });
  it("is full once completed", () => {
    expect(challengeProgress(visits, { value: 3, target: 3 }, "completed")).toMatchObject({ done: true, fraction: 1 });
  });
  it("uses the live streak for streak challenges", () => {
    expect(challengeProgress({ kind: "streak", rule: { length: 5 } }, null, null, 3)).toMatchObject({ value: 3, target: 5 });
  });
  it("formats spend progress and caps at the target", () => {
    const spend = { kind: "spend_amount", rule: { spend_cents: 6000 } } as const;
    expect(progressLabel(spend, challengeProgress(spend, { value: 7500, target: 6000 }, "completed"), gbp)).toBe("£60.00 / £60.00");
  });
});

describe("streak bonuses", () => {
  it("defaults in settings", () => expect(parseSettings({}).streak_bonuses).toEqual({ "3": 20, "5": 50, "10": 100 }));
  it("finds the next milestone", () => {
    const b = { "3": 20, "5": 50, "10": 100 };
    expect(nextStreakBonus(0, b)).toEqual({ at: 3, points: 20 });
    expect(nextStreakBonus(3, b)).toEqual({ at: 5, points: 50 });
    expect(nextStreakBonus(10, b)).toBeNull();
    expect(nextStreakBonus(1, { "2": 0, "4": 30 })).toEqual({ at: 4, points: 30 });
  });
});
