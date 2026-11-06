import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import { getRestaurantBySlug } from "@/lib/data/customer";
import { safeNext } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

export default function CustomerLoginPage(props: PageProps<"/r/[slug]/login">) {
  return (
    <Suspense>
      <CustomerLogin {...props} />
    </Suspense>
  );
}

async function CustomerLogin({ params, searchParams }: PageProps<"/r/[slug]/login">) {
  const { slug } = await params;
  const { next } = await searchParams;
  const restaurant = await getRestaurantBySlug(await createUserClient(), slug);
  if (!restaurant) notFound();

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-8"
      style={{ ["--brand" as string]: restaurant.brand_color ?? "#E4572E" }}
    >
      <h1 className="text-2xl font-bold">Join {restaurant.name} rewards</h1>
      <p className="mb-6 mt-1 text-neutral-600">We&apos;ll text you a code. No password needed.</p>
      <LoginForm next={safeNext(typeof next === "string" ? next : null, `/r/${slug}`)} />
      <p className="mt-6 text-xs text-neutral-400">
        By joining you agree to {restaurant.name}&apos;s rewards terms. We&apos;ll only send marketing messages if you opt in.
      </p>
    </main>
  );
}
