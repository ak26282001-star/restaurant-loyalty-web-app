import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { TIER_LABELS, nextTierProgress, parseSettings, streakStatus, tierRank } from "@loyalty/core";
import { createUserClient } from "@/lib/supabase/server";
import { getCustomerHome, getRestaurantBySlug } from "@/lib/data/customer";
import type { Restaurant } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { CheckInBanner } from "@/components/check-in-banner";
import { ClaimButton } from "@/components/claim-button";
import { SignOutButton } from "@/components/sign-out-button";

export default function LoyaltyPage(props: PageProps<"/r/[slug]">) {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <LoyaltyHome {...props} />
    </Suspense>
  );
}

async function LoyaltyHome({ params, searchParams }: PageProps<"/r/[slug]">) {
  const { slug } = await params;
  const { from } = await searchParams;
  const supabase = await createUserClient();

  const restaurant = await getRestaurantBySlug(supabase, slug);
  if (!restaurant) notFound();

  const { data: { user } } = await supabase.auth.getUser();
  const fromTap = from === "tap";

  return (
    <Shell restaurant={restaurant}>
      {user ? (
        <>
          <CheckInBanner restaurantId={restaurant.id} fromTap={fromTap} />
          <MemberHome restaurant={restaurant} customerId={user.id} />
        </>
      ) : (
        <Teaser restaurant={restaurant} fromTap={fromTap} />
      )}
    </Shell>
  );
}

function Shell({ restaurant, children }: { restaurant: Restaurant; children: React.ReactNode }) {
  return (
    <main
      className="mx-auto min-h-dvh w-full max-w-md px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]"
      style={{ ["--brand" as string]: restaurant.brand_color ?? "#E4572E" }}
    >
      <header className="mb-5 flex items-center gap-3">
        {restaurant.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={restaurant.logo_url} alt="" className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--brand)] font-bold text-white">
            {restaurant.name[0]}
          </div>
        )}
        <p className="font-semibold">{restaurant.name}</p>
      </header>
      {children}
    </main>
  );
}

function Teaser({ restaurant, fromTap }: { restaurant: Restaurant; fromTap: boolean }) {
  const settings = parseSettings(restaurant.settings);
  const next = `/r/${restaurant.slug}${fromTap ? "?from=tap" : ""}`;
  return (
    <section className="rounded-3xl bg-white p-6 text-center shadow-sm">
      <p className="text-4xl">👋</p>
      <h1 className="mt-3 text-2xl font-bold">Welcome to {restaurant.name}</h1>
      <p className="mt-2 text-neutral-600">
        Join our rewards and earn <strong>{settings.points_per_visit} points</strong> every visit. Unlock free treats,
        streak bonuses and VIP perks.
      </p>
      <Link
        href={`/r/${restaurant.slug}/login?next=${encodeURIComponent(next)}`}
        className="mt-6 block rounded-xl bg-[var(--brand)] px-4 py-3 font-semibold text-white"
      >
        {fromTap ? "Join & check in" : "Join or sign in"}
      </Link>
      <p className="mt-3 text-xs text-neutral-400">Takes 20 seconds. No password, no app to download.</p>
    </section>
  );
}

async function MemberHome({ restaurant, customerId }: { restaurant: Restaurant; customerId: string }) {
  const supabase = await createUserClient();
  const { firstName, membership, catalog, rewards, ledger } = await getCustomerHome(supabase, restaurant.id, customerId);
  const settings = parseSettings(restaurant.settings);

  if (!membership) {
    return (
      <section className="rounded-3xl bg-white p-6 text-center shadow-sm">
        <h1 className="text-xl font-bold">You&apos;re signed in 🎉</h1>
        <p className="mt-2 text-neutral-600">Tap the {restaurant.name} tag or scan the QR code in store to check in and start earning.</p>
        <SignOutButton />
      </section>
    );
  }

  const progress = nextTierProgress(membership.tier, membership.visit_count, settings.tiers);
  const streak = streakStatus(
    membership.current_streak,
    membership.last_visit_at ? new Date(membership.last_visit_at) : null,
    settings.streak_window_days,
  );
  const qrSvgs = await Promise.all(rewards.map((r) => QRCode.toString(r.redeem_code, { type: "svg", margin: 1 })));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Hey {firstName ?? "there"} 👋</h1>

      <section className="rounded-3xl bg-[var(--brand)] p-5 text-white shadow-lg">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm opacity-80">Points</p>
            <p className="text-4xl font-bold tabular-nums">{membership.points_balance}</p>
          </div>
          <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-semibold">{TIER_LABELS[membership.tier]}</span>
        </div>
        {progress.next ? (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-white/25">
              <div className="h-full rounded-full bg-white" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm opacity-90">
              {progress.visitsNeeded} more {progress.visitsNeeded === 1 ? "visit" : "visits"} to {TIER_LABELS[progress.next]}
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm opacity-90">You&apos;re at our top tier. Thank you! 🏆</p>
        )}
      </section>

      {streak.state === "active" && (
        <section className={`rounded-2xl p-4 ${streak.atRisk ? "bg-amber-50 text-amber-900" : "bg-white"} shadow-sm`}>
          <p className="font-semibold">🔥 {streak.streak}-visit streak</p>
          <p className="text-sm text-neutral-600">
            Come back by {formatDate(streak.expiresAt.toISOString(), { weekday: "short", day: "numeric", month: "short" })} to keep it going.
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">Your rewards</h2>
        {rewards.length === 0 ? (
          <p className="rounded-2xl bg-white p-4 text-sm text-neutral-500 shadow-sm">No rewards yet. Spend your points below.</p>
        ) : (
          <ul className="space-y-3">
            {rewards.map((r, i) => (
              <li key={r.id} className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm">
                <div className="h-20 w-20 shrink-0 [&_svg]:h-full [&_svg]:w-full" aria-hidden dangerouslySetInnerHTML={{ __html: qrSvgs[i] }} />
                <div className="min-w-0">
                  <p className="font-semibold">{r.title}</p>
                  {r.message && <p className="text-sm text-neutral-600">{r.message}</p>}
                  <p className="mt-1 font-mono text-lg tracking-widest">{r.redeem_code}</p>
                  <p className="text-xs text-neutral-400">Show to staff · expires {formatDate(r.expires_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {catalog.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">Spend points</h2>
          <ul className="divide-y divide-neutral-100 rounded-2xl bg-white shadow-sm">
            {catalog.map((t) => {
              const locked = tierRank(membership.tier) < tierRank(t.min_tier);
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium">{t.name}</p>
                    {locked && <p className="text-xs text-neutral-500">🔒 {TIER_LABELS[t.min_tier]} and above</p>}
                  </div>
                  <ClaimButton
                    templateId={t.id}
                    slug={restaurant.slug}
                    cost={t.points_cost!}
                    affordable={!locked && membership.points_balance >= t.points_cost!}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {ledger.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">Recent activity</h2>
          <ul className="divide-y divide-neutral-100 rounded-2xl bg-white text-sm shadow-sm">
            {ledger.map((e) => (
              <li key={e.id} className="flex justify-between p-3">
                <span className="capitalize text-neutral-600">{e.reason.replace("_", " ")} · {formatDate(e.created_at)}</span>
                <span className={`font-semibold tabular-nums ${e.delta >= 0 ? "text-emerald-600" : "text-neutral-500"}`}>
                  {e.delta >= 0 ? `+${e.delta}` : e.delta}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-xs text-neutral-400">
        {membership.visit_count} {membership.visit_count === 1 ? "visit" : "visits"} · longest streak {membership.longest_streak}
      </p>
      <SignOutButton />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-md animate-pulse space-y-4 px-4 pt-6">
      <div className="h-10 w-40 rounded-full bg-neutral-200" />
      <div className="h-40 rounded-3xl bg-neutral-200" />
      <div className="h-20 rounded-2xl bg-neutral-200" />
      <div className="h-32 rounded-2xl bg-neutral-200" />
    </main>
  );
}
