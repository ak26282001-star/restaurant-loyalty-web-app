import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

type StaffRow = { role: string; restaurants: { id: string; name: string } };

export default function AdminIndexPage(props: PageProps<"/admin">) {
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <Suspense fallback={<p className="text-neutral-500">Loading…</p>}>
        <RestaurantPicker {...props} />
      </Suspense>
    </main>
  );
}

async function RestaurantPicker({ searchParams }: PageProps<"/admin">) {
  const { error } = await searchParams;
  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");

  const { data } = await supabase
    .from("staff_members")
    .select("role, restaurants(id, name)")
    .eq("user_id", user.id)
    .returns<StaffRow[]>();
  const rows = data ?? [];

  if (rows.length === 1 && !error) {
    const r = rows[0];
    redirect(r.role === "staff" ? `/staff/${r.restaurants.id}` : `/admin/${r.restaurants.id}`);
  }

  return (
    <>
      <h1 className="text-2xl font-bold">Your restaurants</h1>
      {error === "forbidden" && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">You don&apos;t have access to that page.</p>}
      {rows.length === 0 ? (
        <p className="mt-4 text-neutral-600">
          You&apos;re signed in as {user.email ?? user.phone}, but you aren&apos;t on any restaurant&apos;s team yet. Ask the owner to invite you.
        </p>
      ) : (
        <ul className="mt-4 divide-y rounded-2xl bg-white shadow-sm">
          {rows.map((r) => (
            <li key={r.restaurants.id}>
              <Link className="flex justify-between p-4" href={r.role === "staff" ? `/staff/${r.restaurants.id}` : `/admin/${r.restaurants.id}`}>
                <span className="font-medium">{r.restaurants.name}</span>
                <span className="text-sm capitalize text-neutral-500">{r.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
