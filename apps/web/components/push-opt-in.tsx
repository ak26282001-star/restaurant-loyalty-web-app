"use client";

import { useEffect, useState } from "react";
import { deletePushSubscription, savePushSubscription } from "@/app/r/[slug]/push-actions";

type State = "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy";

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Offer streak reminders. On iOS, web push only works once the site is added to the Home Screen. */
export function PushOptIn({ restaurantId }: { restaurantId: string }) {
  const [state, setState] = useState<State>("busy");
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    (async () => {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!vapidKey || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        return setState(ios && !standalone ? "ios-install" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, [vapidKey]);

  const enable = async () => {
    setState("busy");
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey!) });
      const { ok } = await savePushSubscription({ restaurantId, ...sub.toJSON() }, navigator.userAgent);
      setState(ok ? "on" : "off");
    } catch {
      setState("off");
    }
  };

  const disable = async () => {
    setState("busy");
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) {
      await deletePushSubscription(sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
  };

  if (state === "unsupported" || state === "busy") return null;
  const box = "rounded-2xl bg-white p-4 text-sm shadow-sm";
  if (state === "ios-install") {
    return <p className={box}>🔔 Want streak reminders? Tap <strong>Share → Add to Home Screen</strong>, then open Rewards from your Home Screen.</p>;
  }
  if (state === "denied") return null; // respect the decision; the browser blocks re-prompting anyway
  return (
    <div className={`${box} flex items-center justify-between gap-3`}>
      <span>{state === "on" ? "🔔 Streak reminders are on" : "🔔 Get a reminder before your streak ends"}</span>
      <button onClick={state === "on" ? disable : enable} className="shrink-0 rounded-full border border-neutral-300 px-3 py-1.5 font-medium">
        {state === "on" ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}
