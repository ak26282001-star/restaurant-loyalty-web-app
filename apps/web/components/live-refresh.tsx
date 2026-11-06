"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Subscribes to this member's balance, rewards and challenge progress through Supabase
 * Realtime and refreshes the page when any of them change (e.g. staff confirm a visit
 * while the customer has the page open). RLS ensures only the member's own rows arrive.
 */
export function LiveRefresh({ membershipId }: { membershipId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createBrowserSupabase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let cancelled = false;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 250); // one refresh for a burst of row changes
    };

    (async () => {
      // Realtime applies RLS using the token it was given. Without the user's access token it
      // connects as anonymous and the member's own rows are filtered out, so set it first.
      const { data } = await supabase.auth.getSession();
      if (cancelled || !data.session) return;
      await supabase.realtime.setAuth(data.session.access_token);

      channel = supabase
        .channel(`membership:${membershipId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "memberships", filter: `id=eq.${membershipId}` }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "rewards", filter: `membership_id=eq.${membershipId}` }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "challenge_progress", filter: `membership_id=eq.${membershipId}` }, refresh)
        // The channel's SUBSCRIBED status arrives before the database change feed is attached.
        // Wait for the feed, then refresh once to pick up anything that changed in between.
        .on("system", {}, (payload: { extension?: string; status?: string }) => {
          if (payload.extension === "postgres_changes" && payload.status === "ok") {
            document.documentElement.dataset.live = "on";
            refresh();
          }
        })
        .subscribe();
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      delete document.documentElement.dataset.live;
      if (channel) supabase.removeChannel(channel);
    };
  }, [membershipId, router]);

  return null;
}
