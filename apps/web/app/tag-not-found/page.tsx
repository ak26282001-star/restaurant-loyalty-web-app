export default function TagNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl">🤔</p>
      <h1 className="mt-4 text-xl font-bold">We don&apos;t recognise this tag</h1>
      <p className="mt-2 text-neutral-600">It may have been replaced. Ask a team member for the current QR code.</p>
    </main>
  );
}
