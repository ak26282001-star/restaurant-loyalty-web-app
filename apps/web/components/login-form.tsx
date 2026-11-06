"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

type Mode = "phone" | "email";
type Step = "enter" | "verify" | "email_sent";

/** Passwordless sign-in: SMS one-time code (default) or email magic link. */
export function LoginForm({ next, defaultMode = "phone" }: { next: string; defaultMode?: Mode }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [step, setStep] = useState<Step>("enter");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setError(await fn());
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      const normalised = phone.replace(/[\s()-]/g, "");
      if (!/^\+[1-9]\d{6,14}$/.test(normalised)) return "Enter your number with country code, e.g. +44 7700 900123";
      const { error } = await createBrowserSupabase().auth.signInWithOtp({ phone: normalised });
      if (error) return error.message;
      setPhone(normalised);
      setStep("verify");
      return null;
    });

  const verifyCode = () =>
    run(async () => {
      const { error } = await createBrowserSupabase().auth.verifyOtp({ phone, token: code, type: "sms" });
      if (error) return "That code didn't work. Check it and try again.";
      router.replace(next);
      router.refresh();
      return null;
    });

  const sendLink = () =>
    run(async () => {
      if (!/^\S+@\S+\.\S+$/.test(email)) return "Enter a valid email address";
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error } = await createBrowserSupabase().auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) return error.message;
      setStep("email_sent");
      return null;
    });

  const input = "w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/20";
  const button = "w-full rounded-xl bg-[var(--brand)] px-4 py-3 font-semibold text-white disabled:opacity-60";

  if (step === "email_sent") {
    return (
      <p className="rounded-xl bg-white p-4 text-center text-neutral-700 shadow-sm">
        Check <strong>{email}</strong> for a sign-in link. You can close this tab once you&apos;ve opened it.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {step === "enter" && mode === "phone" && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
          <label className="block text-sm font-medium text-neutral-700" htmlFor="phone">Mobile number</label>
          <input id="phone" className={input} type="tel" inputMode="tel" autoComplete="tel" placeholder="+44 7700 900123"
            value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <button className={button} disabled={busy}>{busy ? "Sending…" : "Text me a code"}</button>
        </form>
      )}

      {step === "verify" && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); verifyCode(); }}>
          <label className="block text-sm font-medium text-neutral-700" htmlFor="code">Enter the 6-digit code sent to {phone}</label>
          <input id="code" className={`${input} text-center text-2xl tracking-[0.5em]`} inputMode="numeric" autoComplete="one-time-code"
            pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus />
          <button className={button} disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Continue"}</button>
          <button type="button" className="w-full text-sm text-neutral-500 underline" onClick={() => { setStep("enter"); setCode(""); }}>
            Use a different number
          </button>
        </form>
      )}

      {step === "enter" && mode === "email" && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); sendLink(); }}>
          <label className="block text-sm font-medium text-neutral-700" htmlFor="email">Email</label>
          <input id="email" className={input} type="email" autoComplete="email" placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className={button} disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
        </form>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {step === "enter" && (
        <button type="button" className="w-full text-sm text-neutral-500 underline" onClick={() => { setMode(mode === "phone" ? "email" : "phone"); setError(null); }}>
          {mode === "phone" ? "Use email instead" : "Use my phone number instead"}
        </button>
      )}
    </div>
  );
}
