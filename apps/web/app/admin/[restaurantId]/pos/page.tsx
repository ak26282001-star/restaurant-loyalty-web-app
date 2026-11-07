import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { cloverConfigured } from "@/lib/clover/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ActionForm } from "@/components/action-form";
import { AdminNav } from "@/components/admin-nav";
import { disconnectPos, syncMenuNow } from "./actions";

type Conn = { id: string; merchant_id: string; environment: string; status: string; connected_at: string; last_webhook_at: string | null; last_order_at: string | null; menu_synced_at: string | null; last_error: string | null };
type LogRow = { id: number; object_id: string; event_type: string; status: string; detail: string | null; received_at: string };
type OrderRow = { id: string; total_cents: number; ordered_at: string; customer_id: string | null; visit_id: string | null };

const ERRORS: Record<string, string> = {
  not_configured: "Clover isn't set up on the server yet. Add the CLOVER_* and TOKEN_ENCRYPTION_KEY environment variables (see README).",
  bad_callback: "Clover sent back an unexpected response. Please try connecting again.",
  session_changed: "You were signed in as someone else when Clover sent you back. Sign in as the owner and try again.",
  token_exchange: "Clover didn't accept the connection. Check the app ID and secret, then try again.",
  merchant_in_use: "That Clover merchant is already connected to another restaurant.",
  save_failed: "Couldn't save the connection. Please try again.",
};

export default function PosPage(props: PageProps<"/admin/[restaurantId]/pos">) {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading…</p>}>
      <Pos {...props} />
    </Suspense>
  );
}

async function Pos({ params, searchParams }: PageProps<"/admin/[restaurantId]/pos">) {
  const { restaurantId } = await params;
  const { connected, error } = await searchParams;
  const { supabase, restaurant, role } = await requireStaff(restaurantId, "manager", `/admin/${restaurantId}/pos`);

  const [{ data: conns }, { data: log }, { data: orders }, { data: r }] = await Promise.all([
    supabase.from("pos_connections").select("*").eq("restaurant_id", restaurantId).neq("status", "disconnected").returns<Conn[]>(),
    supabase.from("pos_webhook_log").select("id, object_id, event_type, status, detail, received_at").eq("restaurant_id", restaurantId).order("received_at", { ascending: false }).limit(15).returns<LogRow[]>(),
    supabase.from("orders").select("id, total_cents, ordered_at, customer_id, visit_id").eq("restaurant_id", restaurantId).not("pos_order_id", "is", null).order("ordered_at", { ascending: false }).limit(10).returns<OrderRow[]>(),
    supabase.from("restaurants").select("currency, settings").eq("id", restaurantId).single<{ currency: string; settings: { country_calling_code?: string } }>(),
  ]);
  const conn = conns?.[0];
  const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500";

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <AdminNav restaurantId={restaurantId} name={restaurant.name} slug={restaurant.slug} current="/pos" />
      {connected === "1" && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Clover connected. Your menu is syncing now.</p>}
      {typeof error === "string" && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{ERRORS[error] ?? "Something went wrong."}</p>}

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Clover</h2>
        {!conn ? (
          <>
            <p className="mt-1 text-sm text-neutral-600">
              Connect Clover to credit guests automatically from paid orders (matched by the phone number or email on the order),
              record the dishes they order, and unlock &ldquo;try these dishes&rdquo; challenges and AI offers.
            </p>
            {!r?.settings?.country_calling_code && (
              <p className="mt-2 text-sm text-amber-700">Set your country calling code in Settings first, so phone numbers typed without +country match.</p>
            )}
            {role === "owner" ? (
              cloverConfigured() ? (
                <a href={`/api/pos/clover/connect?restaurantId=${restaurantId}`} className="mt-4 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Connect Clover</a>
              ) : (
                <p className="mt-3 text-sm text-neutral-500">{ERRORS.not_configured}</p>
              )
            ) : (
              <p className="mt-3 text-sm text-neutral-500">Ask the owner to connect Clover.</p>
            )}
          </>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-neutral-500">Merchant</dt><dd className="font-mono">{conn.merchant_id} <span className="text-xs uppercase text-neutral-400">{conn.environment}</span></dd></div>
              <div><dt className="text-neutral-500">Status</dt><dd className={conn.status === "active" ? "text-emerald-700" : "text-red-700"}>{conn.status}</dd></div>
              <div><dt className="text-neutral-500">Connected</dt><dd>{formatDateTime(conn.connected_at)}</dd></div>
              <div><dt className="text-neutral-500">Last webhook</dt><dd>{conn.last_webhook_at ? formatDateTime(conn.last_webhook_at) : "None yet"}</dd></div>
              <div><dt className="text-neutral-500">Last order recorded</dt><dd>{conn.last_order_at ? formatDateTime(conn.last_order_at) : "None yet"}</dd></div>
              <div><dt className="text-neutral-500">Menu synced</dt><dd>{conn.menu_synced_at ? formatDateTime(conn.menu_synced_at) : "Not yet"}</dd></div>
            </dl>
            {conn.last_error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700">{conn.last_error}</p>}
            <div className="mt-4 flex flex-wrap gap-3">
              <ActionForm action={syncMenuNow}>
                <input type="hidden" name="restaurantId" value={restaurantId} />
                <input type="hidden" name="connectionId" value={conn.id} />
                <button className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium">Sync menu now</button>
              </ActionForm>
              {role === "owner" && (
                <ActionForm action={disconnectPos}>
                  <input type="hidden" name="restaurantId" value={restaurantId} />
                  <input type="hidden" name="connectionId" value={conn.id} />
                  <button className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700">Disconnect</button>
                </ActionForm>
              )}
            </div>
          </>
        )}
      </section>

      {conn && (
        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <h2 className="p-4 text-lg font-semibold">Recent Clover orders</h2>
          {!orders?.length ? (
            <p className="px-4 pb-4 text-sm text-neutral-500">No paid orders received yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-neutral-50"><tr><th className={th}>When</th><th className={th}>Total</th><th className={th}>Guest</th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="px-3 py-2">{formatDateTime(o.ordered_at)}</td>
                    <td className="px-3 py-2">{formatMoney(o.total_cents, r?.currency ?? "USD")}</td>
                    <td className="px-3 py-2">{o.customer_id ? "✅ Member credited" : "Not a member (no matching phone/email)"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {conn && !!log?.length && (
        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <h2 className="p-4 text-lg font-semibold">Webhook activity</h2>
          <table className="w-full text-sm">
            <thead className="bg-neutral-50"><tr><th className={th}>Received</th><th className={th}>Event</th><th className={th}>Result</th></tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(l.received_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.event_type} {l.object_id}</td>
                  <td className={`px-3 py-2 ${l.status === "failed" ? "text-red-700" : ""}`}>{l.status}{l.detail ? `: ${l.detail}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
