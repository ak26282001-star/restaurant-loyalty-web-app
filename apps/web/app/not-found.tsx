import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-bold">Page not found</h1>
      <Link href="/" className="mt-4 underline">Go home</Link>
    </main>
  );
}
