"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CheckInResult } from "@loyalty/core";

type State =
  | { kind: "loading" }
  | { kind: "result"; result: CheckInResult }
  | { kind: "locating" }
  | { kind: "error"; message: string };

const ERRORS: Record<string, string> = {
  no_recent_tap: "Tap the tag again to check in.",
  tag_mismatch: "That tag belongs to a different restaurant.",
  rate_limited: "Too many attempts. Try again in a minute.",
};

async function postCheckIn(restaurantId: string, geo?: { lat: number; lng: number }) {
  const res = await fetch("/api/v1/visits/check-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restaurantId, geo }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(ERRORS[body?.error?.code] ?? "We couldn't check you in. Please ask a team member.");
  return body as CheckInResult;
}

function currentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    ),
  );
}

/**
 * Runs the check-in after a tap and shows the outcome. Always mounted on the member page:
 * it remembers whether the first render came from a tap, so the result stays visible after
 * router.refresh() re-renders the page without ?from=tap.
 */
export function CheckInBanner({ restaurantId, fromTap }: { restaurantId: string; fromTap: boolean }) {
  const router = useRouter();
  const [active] = useState(fromTap);
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  const finish = useCallback((result: CheckInResult) => {
    setState({ kind: "result", result });
    if (result.status === "confirmed") router.refresh(); // pull the new balance and streak
  }, [router]);

  useEffect(() => {
    if (!active || started.current) return; // run once, and only after a tap
    started.current = true;
    window.history.replaceState(null, "", window.location.pathname); // a reload must not re-check-in

    (async () => {
      try {
        // Use location silently only if the customer already granted it; never prompt unprompted.
        let geo: { lat: number; lng: number } | undefined;
        const perm = await navigator.permissions?.query({ name: "geolocation" }).catch(() => null);
        if (perm?.state === "granted") geo = await currentPosition().catch(() => undefined);
        finish(await postCheckIn(restaurantId, geo));
      } catch (e) {
        setState({ kind: "error", message: (e as Error).message });
      }
    })();
  }, [active, restaurantId, finish]);

  const verifyWithLocation = async () => {
    setState({ kind: "locating" });
    try {
      const geo = await currentPosition();
      const result = await postCheckIn(restaurantId, geo);
      finish(result);
    } catch (e) {
      const message = e instanceof GeolocationPositionError
        ? "We couldn't get your location. Show this screen to a team member instead."
        : (e as Error).message;
      setState({ kind: "error", message });
    }
  };

  const box = "mb-4 rounded-2xl p-4 text-center shadow-sm";

  if (!active) return null;

  if (state.kind === "loading" || state.kind === "locating") {
    return <div className={`${box} animate-pulse bg-white text-neutral-500`} aria-live="polite">{state.kind === "loading" ? "Checking you in…" : "Checking your location…"}</div>;
  }
  if (state.kind === "error") {
    return <div className={`${box} border border-red-200 bg-red-50 text-red-700`} role="alert">{state.message}</div>;
  }

  const { result } = state;
  if (result.status === "confirmed") {
    return (
      <div className={`${box} animate-[pop_400ms_ease-out] bg-[var(--brand)] text-white`} aria-live="polite">
        <p className="text-2xl font-bold">{result.already_confirmed ? "You're checked in ✅" : "Checked in! 🎉"}</p>
        {result.points_awarded ? <p className="mt-1 text-lg">+{result.points_awarded} points</p> : null}
        {result.tier_upgraded ? <p className="mt-1 font-semibold">You&apos;ve reached a new tier!</p> : null}
      </div>
    );
  }
  if (result.status === "cooldown") {
    return (
      <div className={`${box} bg-white text-neutral-700`} aria-live="polite">
        You&apos;ve already checked in today. Thanks for coming back! 💛
      </div>
    );
  }
  return (
    <div className={`${box} border border-amber-300 bg-amber-50 text-amber-900`} aria-live="polite">
      <p className="font-semibold">Almost there</p>
      <p className="mt-1 text-sm">Show this screen to a team member to confirm your visit, or verify with your location.</p>
      <button onClick={verifyWithLocation} className="mt-3 w-full rounded-xl bg-amber-500 px-4 py-2.5 font-semibold text-white">
        Verify with my location
      </button>
    </div>
  );
}
