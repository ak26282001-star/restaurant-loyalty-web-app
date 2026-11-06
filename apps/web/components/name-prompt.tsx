"use client";

import { useActionState } from "react";
import { saveFirstName, type NameState } from "@/app/r/[slug]/actions";

export function NamePrompt() {
  const [state, action, pending] = useActionState<NameState, FormData>(saveFirstName, null);
  return (
    <form action={action} className="rounded-2xl bg-white p-4 shadow-sm">
      <label htmlFor="firstName" className="font-semibold">What should we call you?</label>
      <p className="text-sm text-neutral-500">So the team can greet you by name.</p>
      <div className="mt-3 flex gap-2">
        <input id="firstName" name="firstName" autoComplete="given-name" placeholder="First name" maxLength={40}
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 px-3 py-2" required />
        <button disabled={pending} className="rounded-xl bg-[var(--brand)] px-4 py-2 font-semibold text-white disabled:opacity-60">
          {pending ? "…" : "Save"}
        </button>
      </div>
      {state?.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
