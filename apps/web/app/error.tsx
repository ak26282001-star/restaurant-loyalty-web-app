"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl">😕</p>
      <h1 className="mt-4 text-xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-neutral-600">Please try again in a moment.</p>
      {error.digest && <p className="mt-3 font-mono text-xs text-neutral-400">Reference: {error.digest}</p>}
      <button onClick={reset} className="mt-6 rounded-xl bg-neutral-900 px-5 py-2.5 font-semibold text-white">Try again</button>
    </main>
  );
}
