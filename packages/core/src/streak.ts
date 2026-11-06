const DAY_MS = 24 * 60 * 60 * 1000;

export type StreakStatus =
  | { state: "none" }
  | { state: "active"; streak: number; expiresAt: Date; daysLeft: number; atRisk: boolean }
  | { state: "expired" };

/**
 * Whether the current streak is still alive and when it ends. A streak survives
 * while the next visit lands within `windowDays` of the last one (same rule as
 * confirm_visit in SQL). "At risk" means two days or fewer remain.
 */
export function streakStatus(streak: number, lastVisitAt: Date | null, windowDays: number, now = new Date()): StreakStatus {
  if (!lastVisitAt || streak <= 0) return { state: "none" };
  const expiresAt = new Date(lastVisitAt.getTime() + windowDays * DAY_MS);
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft < 0) return { state: "expired" };
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  return { state: "active", streak, expiresAt, daysLeft, atRisk: daysLeft <= 2 };
}
