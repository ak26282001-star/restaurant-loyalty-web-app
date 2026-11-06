import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <p className="text-5xl">📲</p>
      <h1 className="mt-4 text-3xl font-bold">Tap Rewards</h1>
      <p className="mt-3 text-neutral-600">
        Loyalty for restaurants with no app to download. Guests tap an NFC tag or scan a QR code, check in, and earn points,
        streaks and rewards.
      </p>
      <div className="mt-8 space-y-3">
        <Link href="/admin" className="block rounded-xl bg-neutral-900 px-4 py-3 text-center font-semibold text-white">
          Restaurant dashboard
        </Link>
        <Link href="/t/DEMO01" className="block rounded-xl border border-neutral-300 px-4 py-3 text-center font-semibold">
          Try the demo tap
        </Link>
      </div>
    </main>
  );
}
