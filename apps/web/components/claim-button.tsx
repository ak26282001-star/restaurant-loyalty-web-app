"use client";

import { useActionState } from "react";
import { claimReward, type ClaimState } from "@/app/r/[slug]/actions";

export function ClaimButton({ templateId, slug, cost, affordable }: { templateId: string; slug: string; cost: number; affordable: boolean }) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimReward, null);
  return (
    <form action={action} className="shrink-0 text-right">
      <input type="hidden" name="templateId" value={templateId} />
      <input type="hidden" name="slug" value={slug} />
      <button
        disabled={!affordable || pending}
        className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:bg-neutral-300"
      >
        {pending ? "…" : `${cost} pts`}
      </button>
      {state?.error && <p role="alert" className="mt-1 max-w-36 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}
