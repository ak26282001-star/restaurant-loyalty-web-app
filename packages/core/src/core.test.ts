import { describe, expect, it } from "vitest";
import {
  distanceMeters,
  generateTagCode,
  isValidTagCode,
  mapDbError,
  nextTierProgress,
  parseSettings,
  streakStatus,
  tierFor,
  withinGeofence,
} from "./index";

const tiers = { regular: 5, vip: 15, legend: 40 };

describe("settings", () => {
  it("fills defaults matching the SQL defaults", () => {
    const s = parseSettings({ points_per_visit: 20 });
    expect(s.points_per_visit).toBe(20);
    expect(s.visit_cooldown_minutes).toBe(240);
    expect(s.tiers).toEqual(tiers);
  });
  it("accepts null", () => expect(parseSettings(null).streak_window_days).toBe(14));
});

describe("tiers", () => {
  it.each([
    [0, "member"], [4, "member"], [5, "regular"], [14, "regular"], [15, "vip"], [40, "legend"], [99, "legend"],
  ] as const)("%i visits -> %s", (visits, tier) => expect(tierFor(visits, tiers)).toBe(tier));

  it("reports progress to the next tier", () => {
    expect(nextTierProgress("member", 3, tiers)).toEqual({ next: "regular", visitsNeeded: 2, fraction: 0.6 });
    expect(nextTierProgress("regular", 10, tiers)).toEqual({ next: "vip", visitsNeeded: 5, fraction: 0.5 });
    expect(nextTierProgress("legend", 50, tiers)).toEqual({ next: null });
  });
});

describe("streakStatus", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("is none without visits", () => expect(streakStatus(0, null, 14, now)).toEqual({ state: "none" }));
  it("is active and at risk near the deadline", () => {
    const s = streakStatus(4, new Date("2026-10-24T13:00:00Z"), 14, now);
    expect(s).toMatchObject({ state: "active", streak: 4, daysLeft: 2, atRisk: true }); // 25h left;
  });
  it("is active and safe early on", () => {
    expect(streakStatus(2, new Date("2026-11-05T12:00:00Z"), 14, now)).toMatchObject({ daysLeft: 13, atRisk: false });
  });
  it("expires after the window", () => {
    expect(streakStatus(3, new Date("2026-10-01T12:00:00Z"), 14, now)).toEqual({ state: "expired" });
  });
});

describe("geo", () => {
  const soho = { lat: 51.5136, lng: -0.1365 };
  it("measures distance", () => {
    // Soho -> Covent Garden is roughly 750 m
    expect(distanceMeters(soho, { lat: 51.5117, lng: -0.124 })).toBeGreaterThan(700);
    expect(distanceMeters(soho, { lat: 51.5117, lng: -0.124 })).toBeLessThan(950);
  });
  it("checks the geofence", () => {
    expect(withinGeofence({ lat: 51.5137, lng: -0.1366 }, { ...soho, geofence_m: 150 })).toBe(true);
    expect(withinGeofence({ lat: 51.5117, lng: -0.124 }, { ...soho, geofence_m: 150 })).toBe(false);
    expect(withinGeofence(soho, { lat: null, lng: null, geofence_m: 150 })).toBe(false);
  });
});

describe("tags", () => {
  it("validates codes", () => {
    expect(isValidTagCode("DEMO01")).toBe(true);
    expect(isValidTagCode("abc")).toBe(false);
    expect(isValidTagCode("ab-c12")).toBe(false);
    expect(isValidTagCode("../etc")).toBe(false);
  });
  it("generates valid codes without look-alikes", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateTagCode();
      expect(isValidTagCode(code)).toBe(true);
      expect(code).not.toMatch(/[0O1lI]/);
    }
  });
});

describe("mapDbError", () => {
  it("maps known errors", () => expect(mapDbError("insufficient_points")).toEqual({ code: "insufficient_points", status: 409 }));
  it("hides unknown errors", () => expect(mapDbError('relation "x" does not exist')).toEqual({ code: "internal_error", status: 500 }));
});
