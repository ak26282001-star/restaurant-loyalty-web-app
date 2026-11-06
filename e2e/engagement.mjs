// Phase 2 end-to-end checks: challenges, streak bonuses, live updates, owner settings,
// API hardening, push reminders and PWA. Needs a freshly reset database and the app
// started with PUSH_ENDPOINT_ALLOWLIST=127.0.0.1:8443 and NODE_EXTRA_CA_CERTS=<PUSH_TLS_DIR>/cert.pem.
// Usage: CRON_SECRET=… PUSH_TLS_DIR=… pnpm test:e2e:engagement [screenshot-dir]
import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import ece from "http_ece";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const RID = "11111111-1111-1111-1111-111111111111";
const OUT = process.argv[2] ?? "e2e/screenshots";
mkdirSync(OUT, { recursive: true });
const db = new pg.Client(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
await db.connect();
const q = async (sql, args) => (await db.query(sql, args)).rows;

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const expect = (cond, msg) => { if (!cond) throw new Error(`✘ ${msg}`); ok(msg); };

// ---------- Fake push service (what FCM/Apple/Mozilla would be) ----------
const received = [];
let pushStatus = 201;
const pushServer = https.createServer(
  { key: readFileSync(`${process.env.PUSH_TLS_DIR}/key.pem`), cert: readFileSync(`${process.env.PUSH_TLS_DIR}/cert.pem`) },
  (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(pushStatus).end();
    });
  },
);
await new Promise((r) => pushServer.listen(8443, "127.0.0.1", r));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function phoneLogin(page, number) {
  await page.getByLabel("Mobile number").fill(number);
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
}
const challenge = (page, title) => page.locator("li").filter({ hasText: title });

// ---------- Customer joins; name prompt ----------
const ctx = await browser.newContext(phone);
const page = await ctx.newPage();
await page.goto(`${BASE}/t/DEMO01`);
await page.getByRole("link", { name: "Join & check in" }).click();
await phoneLogin(page, "+447700900001");
await page.getByText("Almost there").waitFor();
await page.getByLabel("What should we call you?").fill("Ada");
await page.getByRole("button", { name: "Save" }).click();
await page.getByRole("heading", { name: "Hey Ada 👋" }).waitFor();
expect(await page.getByLabel("What should we call you?").count() === 0, "customer saves their first name and the prompt goes away");

await challenge(page, "Hat-trick").getByTestId("challenge-progress").getByText("0 / 3").waitFor();
await challenge(page, "Big night out").getByText("£0.00 / £60.00").waitFor();
ok("seeded challenges show with zero progress");

// ---------- Live updates: staff confirm while the customer watches ----------
await page.waitForFunction(() => document.documentElement.dataset.live === "on", null, { timeout: 15000 });
ok("Realtime subscription is connected");
const [cust] = await q("select id from customers where phone = '447700900001'");
const [pending] = await q("select id from visits where customer_id = $1 and status = 'pending'", [cust.id]);
await q("select confirm_visit($1, null, 2500)", [pending.id]);
const points = page.locator("section").filter({ hasText: "Points" }).first();
await points.getByText("35", { exact: true }).waitFor({ timeout: 10000 });
ok("balance updates to 35 without a reload after the visit is confirmed");
await challenge(page, "Hat-trick").getByText("1 / 3").waitFor();
await challenge(page, "Big night out").getByText("£25.00 / £60.00").waitFor();
ok("challenge progress updates live (1/3 visits, £25 of £60)");
await page.getByText("2 more visits earns a +20 streak bonus").waitFor();
ok("streak card shows the next bonus");

// Two more visits, a few days apart (move earlier visits back to stay outside the cooldown).
for (let i = 0; i < 2; i++) {
  await q("update visits set visited_at = visited_at - interval '3 days' where customer_id = $1", [cust.id]);
  await q("update memberships set last_visit_at = last_visit_at - interval '3 days' where customer_id = $1", [cust.id]);
  const [v] = await q("insert into visits (restaurant_id, customer_id, source, status) values ($1, $2, 'staff', 'pending') returning id", [RID, cust.id]);
  await q("select confirm_visit($1, null, 2500)", [v.id]);
}
// 3 × 10 + 3 × 25 spend + 20 streak bonus + 100 (Big night out) = 225
await points.getByText("225", { exact: true }).waitFor({ timeout: 10000 });
ok("third visit: streak bonus +20 and the £60 challenge's +100 arrive live (225)");
await challenge(page, "Hat-trick").getByText("Done").waitFor();
await challenge(page, "Big night out").getByText("Done").waitFor();
ok("both challenges show as done");
await page.locator("li").filter({ hasText: "Challenge complete: Hat-trick" }).getByText("Free dessert").waitFor();
ok("Hat-trick's free dessert appears in the wallet");
await page.getByText("Visit confirmed! 🎉").waitFor();
expect(await page.getByText("Almost there").count() === 0, "the pending banner turns into a confirmation once staff confirm");
await page.screenshot({ path: `${OUT}/p2-1-challenges.png`, fullPage: true });

// ---------- Owner: challenges and settings ----------
const owner = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
await owner.goto(`${BASE}/login`);
await owner.getByRole("button", { name: "Use my phone number instead" }).click();
await phoneLogin(owner, "+447700900002");
await owner.waitForURL(`${BASE}/admin`);
const [ownerUser] = await q("select id from auth.users where phone = '447700900002'");
await q("insert into staff_members (restaurant_id, user_id, role) values ($1, $2, 'owner')", [RID, ownerUser.id]);

await owner.goto(`${BASE}/admin/${RID}/challenges`);
const hat = owner.locator("li").filter({ hasText: "Hat-trick" });
expect((await hat.innerText()).includes("1 completed"), "challenge stats: Hat-trick completed by 1 guest");
await owner.getByLabel("Title").fill("Lunch club");
await owner.getByLabel("Goal").selectOption("time_window");
await owner.getByRole("button", { name: "Launch challenge" }).click();
await owner.getByText("Pick at least one day or a time of day.").waitFor();
ok("a day/time challenge needs at least one day or time of day");
await owner.getByLabel("Title").fill("Four in a row");
await owner.getByLabel("Goal").selectOption("streak");
await owner.getByLabel("Streak length (visits)").fill("4");
await owner.getByLabel("Bonus points").fill("40");
await owner.getByRole("button", { name: "Launch challenge" }).click();
await owner.getByText("Challenge “Four in a row” is live").waitFor();
expect((await owner.locator("li").filter({ hasText: "Four in a row" }).innerText()).includes("Reach a 4-visit streak"), "owner launches a streak challenge");
expect((await owner.getByLabel("Goal").inputValue()) === "visit_count" && (await owner.getByLabel("Number of visits").isVisible())
  && (await owner.getByLabel("Streak length (visits)").count()) === 0, "after launching, the form resets with fields matching the goal");
await owner.screenshot({ path: `${OUT}/p2-2-admin-challenges.png`, fullPage: true });

await owner.goto(`${BASE}/admin/${RID}/settings`);
await owner.getByLabel("Regular").fill("20");
await owner.getByRole("button", { name: "Save settings" }).click();
await owner.getByText("Tier thresholds must increase").waitFor();
ok("settings reject tiers that don't increase");
await owner.getByLabel("Regular").fill("5");
await owner.getByLabel("Points per visit").fill("15");
await owner.getByLabel("Streak bonuses").fill("3=25, 5=60");
await owner.getByRole("button", { name: "Save settings" }).click();
await owner.getByText("Settings saved").waitFor();
const [{ settings }] = await q("select settings from restaurants where id = $1", [RID]);
expect(settings.points_per_visit === 15 && settings.streak_bonuses["5"] === 60 && settings.ai?.monthly_reward_budget === 500,
  "owner saves settings; keys the form doesn't manage are kept");

// ---------- Customer: in-store tap completes the new challenge ----------
await q("update visits set visited_at = visited_at - interval '5 hours' where customer_id = $1", [cust.id]);
await q("update memberships set last_visit_at = last_visit_at - interval '5 hours' where customer_id = $1", [cust.id]);
await ctx.grantPermissions(["geolocation"], { origin: BASE });
await ctx.setGeolocation({ latitude: 51.51365, longitude: -0.13655 });
await page.goto(`${BASE}/t/DEMO01`);
await page.getByText("Checked in! 🎉").waitFor();
await page.getByText("+15 points").waitFor();
await page.getByText("Challenge complete: Four in a row (+40)").waitFor();
ok("4th visit: new points rule (+15) and the owner's new challenge (+40) in the celebration");
await points.getByText("280", { exact: true }).waitFor();
ok("balance 225 + 15 + 40 = 280");
await page.screenshot({ path: `${OUT}/p2-3-celebration.png` });

// ---------- API hardening: the customer's own token can't move value ----------
await fetch(`${SUPABASE}/auth/v1/otp`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ phone: "+447700900001" }) });
const session = await (await fetch(`${SUPABASE}/auth/v1/verify`, {
  method: "POST", headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ phone: "+447700900001", token: "123456", type: "sms" }),
})).json();
const rest = (path, body) => fetch(`${SUPABASE}/rest/v1/${path}`, {
  method: "PATCH",
  headers: { apikey: ANON, authorization: `Bearer ${session.access_token}`, "content-type": "application/json", prefer: "return=minimal" },
  body: JSON.stringify(body),
});
const hack = await rest(`memberships?customer_id=eq.${cust.id}`, { points_balance: 99999 });
expect(!hack.ok, `REST: customer can't set their own points (HTTP ${hack.status})`);
const pref = await rest(`memberships?customer_id=eq.${cust.id}`, { marketing_opt_in: true });
expect(pref.ok, "REST: customer can still change their marketing preference");
const [{ points_balance }] = await q("select points_balance from memberships where customer_id = $1", [cust.id]);
expect(points_balance === 280, "balance unchanged in the database");

// ---------- Push reminder ----------
const unauth = await fetch(`${BASE}/api/cron/streak-reminders`);
expect(unauth.status === 401, "cron endpoint refuses calls without the secret");
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const authSecret = randomBytes(16);
await q(`insert into push_subscriptions (customer_id, restaurant_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5)`,
  [cust.id, RID, "https://127.0.0.1:8443/push/ada", ecdh.getPublicKey("base64url"), authSecret.toString("base64url")]);
await q("update memberships set last_visit_at = now() - interval '13 days' where customer_id = $1", [cust.id]);
const cron = () => fetch(`${BASE}/api/cron/streak-reminders`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());
const first = await cron();
expect(first.sent === 1 && received.length === 1, `cron sends one reminder (${JSON.stringify(first)})`);
const push = received[0];
expect(push.headers.authorization?.startsWith("vapid t=") && push.headers["content-encoding"] === "aes128gcm", "push request is VAPID-signed and encrypted");
const message = JSON.parse(ece.decrypt(push.body, { version: "aes128gcm", privateKey: ecdh, authSecret: authSecret.toString("base64url") }).toString());
expect(message.title === "🔥 Keep your 4-visit streak" && message.url === "/r/demo-bistro", `decrypted payload: ${message.title}`);
const second = await cron();
expect(second.sent === 0 && received.length === 1, "the same streak is never reminded twice");
await q("delete from notification_log");
pushStatus = 410;
const third = await cron();
const [{ count: subs }] = await q("select count(*)::int from push_subscriptions where customer_id = $1", [cust.id]);
expect(third.removed === 1 && subs === 0, "an expired subscription (410) is deleted");

// ---------- PWA ----------
const manifest = await (await fetch(`${BASE}/r/demo-bistro/manifest.webmanifest`)).json();
expect(manifest.name === "Demo Bistro Rewards" && manifest.start_url.startsWith("/r/demo-bistro") && manifest.icons.length === 3,
  "restaurant manifest uses its name and start page");
await page.goto(`${BASE}/r/demo-bistro`);
expect((await page.locator('link[rel="manifest"]').getAttribute("href")) === "/r/demo-bistro/manifest.webmanifest", "page links its own manifest");
const sw = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
expect(sw?.endsWith("/sw.js"), "service worker is active");
// Headless Chromium reports notifications as "denied", where the opt-in correctly stays hidden.
await ctx.grantPermissions(["geolocation", "notifications"], { origin: BASE });
await page.reload();
await page.getByText("Get a reminder before your streak ends").waitFor();
ok("streak reminder opt-in is offered when notifications aren't blocked");
await ctx.setOffline(true);
await page.goto(`${BASE}/r/demo-bistro`).catch(() => {});
await page.getByText("You're offline").waitFor();
ok("offline navigation shows the offline page");
await ctx.setOffline(false);

await browser.close();
pushServer.close();
await db.end();
console.log(`\nAll ${step} checks passed.`);
