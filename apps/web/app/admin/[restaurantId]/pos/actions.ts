"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import type { Connection } from "@/lib/clover/client";
import { syncMenu } from "@/lib/clover/sync";
import type { ActionState } from "@/components/action-form";

const Ids = z.object({ restaurantId: z.guid(), connectionId: z.guid() });

async function ownConnection(restaurantId: string, connectionId: string) {
  const { data } = await adminClient()
    .from("pos_connections")
    .select("id, restaurant_id, location_id, environment, merchant_id")
    .eq("id", connectionId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle<Connection>();
  return data;
}

export async function syncMenuNow(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ids = Ids.safeParse(Object.fromEntries(formData));
  if (!ids.success) return { error: "Invalid request." };
  await requireStaff(ids.data.restaurantId, "manager");
  const conn = await ownConnection(ids.data.restaurantId, ids.data.connectionId);
  if (!conn) return { error: "Connection not found." };
  try {
    const n = await syncMenu(conn);
    refresh();
    return { message: `Synced ${n} menu items from Clover.` };
  } catch (e) {
    console.error("menu sync failed", e);
    return { error: "Couldn't reach Clover. Try again, or reconnect if this keeps happening." };
  }
}

export async function disconnectPos(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ids = Ids.safeParse(Object.fromEntries(formData));
  if (!ids.success) return { error: "Invalid request." };
  await requireStaff(ids.data.restaurantId, "owner");
  const conn = await ownConnection(ids.data.restaurantId, ids.data.connectionId);
  if (!conn) return { error: "Connection not found." };
  const db = adminClient();
  await db.from("pos_credentials").delete().eq("connection_id", conn.id); // tokens are gone for good
  await db.from("pos_connections").update({ status: "disconnected" }).eq("id", conn.id);
  refresh();
  return { message: "Disconnected. Orders from Clover will no longer be recorded." };
}
