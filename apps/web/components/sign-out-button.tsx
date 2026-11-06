"use client";

import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="mx-auto mt-4 block text-sm text-neutral-400 underline"
      onClick={async () => {
        await createBrowserSupabase().auth.signOut();
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
