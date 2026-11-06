"use client";

import { useActionState } from "react";

export type ActionState = { error?: string; message?: string } | null;

/** Small wrapper around useActionState that shows the action's success or error message. */
export function ActionForm({
  action,
  children,
  className,
  onReset,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  /** React resets uncontrolled fields after a successful action; use this to reset related state. */
  onReset?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className} aria-busy={pending} onReset={onReset}>
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      {state?.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
      {state?.message && <p aria-live="polite" className="mt-2 text-sm text-emerald-700">{state.message}</p>}
    </form>
  );
}
