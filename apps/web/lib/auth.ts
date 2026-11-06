import "server-only";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export type StaffRole = "owner" | "manager" | "staff";
const ROLE_RANK: Record<StaffRole, number> = { staff: 0, manager: 1, owner: 2 };

/** The signed-in user, verified with Supabase Auth (not just decoded from the cookie). */
export async function getUser() {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/** Ensures the user is staff at the restaurant with at least `minRole`, or redirects. */
export async function requireStaff(restaurantId: string, minRole: StaffRole = "staff", next = "/admin") {
  const supabase = await createUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);

  const { data: staff } = await supabase
    .from("staff_members")
    .select("role, restaurants(id, name, slug)")
    .eq("restaurant_id", restaurantId)
    .eq("user_id", user.id)
    .maybeSingle();

  const role = staff?.role as StaffRole | undefined;
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) redirect("/admin?error=forbidden");

  const restaurant = staff!.restaurants as unknown as { id: string; name: string; slug: string };
  return { supabase, user, role, restaurant };
}

/** Only allow same-site relative redirects, to avoid open redirects via ?next=. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
