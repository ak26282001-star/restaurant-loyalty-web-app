import { Suspense } from "react";
import { safeNext } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

export default function StaffLoginPage(props: PageProps<"/login">) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-8" style={{ ["--brand" as string]: "#E4572E" }}>
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="mb-6 mt-1 text-neutral-600">Restaurant owners and staff: we&apos;ll email you a sign-in link.</p>
      <Suspense>
        <StaffLogin {...props} />
      </Suspense>
    </main>
  );
}

async function StaffLogin({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  return (
    <>
      {error === "link_expired" && (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">That sign-in link has expired. Request a new one.</p>
      )}
      <LoginForm next={safeNext(typeof next === "string" ? next : null, "/admin")} defaultMode="email" />
    </>
  );
}
