// Phase 3 end-to-end checks: Clover connect (OAuth), webhooks → orders → visits, dish challenges,
// customer segments and AI offers with guardrails. Runs against local fakes of Clover and the
// Anthropic API (e2e/fakes.mjs). Needs a freshly reset database and the app started with:
//   CLOVER_APP_ID=APPTEST12345 CLOVER_APP_SECRET=test-secret CLOVER_ENVIRONMENT=sandbox
//   CLOVER_WEBHOOK_AUTH_CODE=test-clover-auth TOKEN_ENCRYPTION_KEY=<32 bytes base64>
//   CLOVER_API_BASE_URL=http://127.0.0.1:8555 CLOVER_OAUTH_BASE_URL=http://127.0.0.1:8555
//   ANTHROPIC_API_KEY=test-key ANTHROPIC_BASE_URL=http://127.0.0.1:8556
// Usage: pnpm test:e2e:intelligence [screenshot-dir]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";
import { startFakeAnthropic, startFakeClover } from "./fakes.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RID = "11111111-1111-1111-1111-111111111111";
const APP_ID = "APPTEST12345";
const MERCHANT = "MERCHTEST0001";
const AUTH = "test-clover-auth";
const OUT = process.argv[2] ?? "e2e/screenshots";
mkdirSync(OUT, { recursive: true });
const db = new pg.Client(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
await db.connect();
const q = async (sql, args) => (await db.query(sql, args)).rows;

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const expect = (cond, msg) => { if (!cond) throw new Error(`✘ ${msg}`); ok(msg); };
const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`✘ timed out waiting for: ${label}`);
};

// ---------- Fakes ----------
const { server: cloverServer, state: clover } = await startFakeClover({ port: 8555, appId: APP_ID, appSecret: "test-secret", merchantId: MERCHANT });
clover.items = [
  { id: "ITEMFLAT", name: "Flat white", price: 350, hidden: false },
  { id: "ITEMCAKE", name: "Carrot cake", price: 450, hidden: false },
  { id: "ITEMSOUP", name: "Soup of the day", price: 650, hidden: false },
];
let aiReply = null; // set per scenario
const { server: aiServer, requests: aiRequests } = await startFakeAnthropic({ port: 8556, reply: (body) => aiReply(body) });

const webhook = (body, auth = AUTH) =>
  fetch(`${BASE}/api/webhooks/clover`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-clover-auth": auth } : {}) }, body: JSON.stringify(body) });
let ts = Date.now();
const orderEvent = (orderId, type = "UPDATE") => ({ appId: APP_ID, merchants: { [MERCHANT]: [{ objectId: `O:${orderId}`, type, ts: ++ts }] } });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function phoneLogin(page, number) {
  await page.getByLabel("Mobile number").fill(number);
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
}

// ---------- Owner connects Clover ----------
const owner = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
await owner.goto(`${BASE}/login`);
await owner.getByRole("button", { name: "Use my phone number instead" }).click();
await phoneLogin(owner, "+447700900002");
await owner.waitForURL(`${BASE}/admin`);
const [ownerUser] = await q("select id from auth.users where phone = '447700900002'");
await q("insert into staff_members (restaurant_id, user_id, role) values ($1, $2, 'owner')", [RID, ownerUser.id]);

await owner.goto(`${BASE}/admin/${RID}/settings`);
await owner.getByLabel("Country calling code").fill("44");
await owner.getByRole("button", { name: "Save settings" }).click();
await owner.getByText("Settings saved").waitFor();
ok("owner sets the country calling code");

await owner.goto(`${BASE}/admin/${RID}/pos`);
await owner.getByRole("link", { name: "Connect Clover" }).click();
await owner.getByText("Clover connected").waitFor();
expect((await owner.locator("dd").filter({ hasText: MERCHANT }).count()) === 1 && clover.calls.token === 1,
  "Connect Clover → Clover approval → back on the POS page, code exchanged once");
const [cred] = await q("select access_token, refresh_token from pos_credentials");
expect(cred.access_token.startsWith("v1.") && !cred.access_token.includes(clover.accessToken) && !cred.refresh_token.includes(clover.refreshToken),
  "tokens are stored encrypted");
await until(async () => (await q("select count(*)::int n from menu_items where restaurant_id = $1 and pos_item_id like 'ITEM%'", [RID]))[0].n === 3, "menu sync");
expect(clover.calls.refresh === 1, "short-lived access token was refreshed before use (single-use refresh token)");
ok("menu synced from Clover (3 dishes)");

// ---------- Webhook security ----------
expect((await webhook(orderEvent("NOPE"), "wrong")).status === 401, "webhook with a wrong X-Clover-Auth is refused");
expect((await webhook(orderEvent("NOPE"), null)).status === 401, "webhook without X-Clover-Auth is refused");
const verify = await webhook({ verificationCode: "11111111-2222-3333-4444-555555555555" }, null);
const [{ code }] = await q("select code from pos_webhook_verifications order by id desc limit 1");
expect(verify.ok && code === "11111111-2222-3333-4444-555555555555", "Clover's verification code is accepted and stored for setup");

// ---------- Customer taps, then pays on Clover ----------
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const page = await ctx.newPage();
await page.goto(`${BASE}/t/DEMO01`);
await page.getByRole("link", { name: "Join & check in" }).click();
await phoneLogin(page, "+447700900001");
await page.getByText("Almost there").waitFor();
await page.waitForFunction(() => document.documentElement.dataset.live === "on", null, { timeout: 15000 });

clover.customers.CUSTA = { firstName: "Ada", phones: ["07700 900001"] }; // national format on the till
clover.orders.ORDA1 = { id: "ORDA1", total: 2350, currency: "GBP", paymentState: "OPEN", createdTime: Date.now(),
  lineItems: [{ id: "L1", name: "Flat white", price: 350, item: { id: "ITEMFLAT" } }, { id: "L2", name: "Carrot cake", price: 450, item: { id: "ITEMCAKE" } },
    { id: "L3", name: "Carrot cake", price: 450, item: { id: "ITEMCAKE" } }, { id: "L4", name: "Brunch plate", price: 1100, item: { id: "ITEMBRUNCH" } }],
  customers: ["CUSTA"] };
await webhook(orderEvent("ORDA1", "CREATE"));
await until(async () => (await q("select status from pos_webhook_log where object_id = 'O:ORDA1'"))[0]?.status === "ignored", "open order ignored");
ok("an unpaid (OPEN) order is not credited yet");

clover.orders.ORDA1.paymentState = "PAID";
clover.rateLimitNext = 1; // Clover rate-limits the first fetch
const paidEvent = orderEvent("ORDA1");
await webhook(paidEvent);
const points = page.locator("section").filter({ hasText: "Points" }).first();
await points.getByText("33", { exact: true }).waitFor({ timeout: 15000 });
ok("paid order confirms the pending tap with the real bill: 10 + 23 points, live on the guest's phone");
expect(clover.calls.rateLimited === 1, "a 429 from Clover was retried");
await page.getByText("Visit confirmed! 🎉").waitFor();
const [items] = await q(`select count(*)::int n, sum(quantity)::int qty from order_items oi join orders o on o.id = oi.order_id where o.pos_order_id = 'ORDA1'`);
expect(items.n === 3 && items.qty === 4, "line items grouped per dish (2× carrot cake) and an unknown dish added to the menu");

await webhook(paidEvent); // Clover retries the same delivery
await new Promise((r) => setTimeout(r, 1500));
const [{ points_balance: afterDup }] = await q("select points_balance from memberships m join customers c on c.id = m.customer_id where c.phone = '447700900001'");
expect(afterDup === 33, "a repeated webhook delivery doesn't pay twice");

// ---------- Owner creates a "try these dishes" challenge ----------
await owner.goto(`${BASE}/admin/${RID}/challenges`);
await owner.getByLabel("Title").fill("Try the classics");
await owner.getByLabel("Goal").selectOption("try_items");
await owner.getByLabel("Flat white").check();
await owner.getByLabel("Soup of the day").check();
await owner.getByLabel("Bonus points").fill("30");
await owner.getByRole("button", { name: "Launch challenge" }).click();
await owner.getByText("Challenge “Try the classics” is live").waitFor();
expect((await owner.locator("li").filter({ hasText: "Try the classics" }).innerText()).includes("Try 2 dishes"), "owner launches a dish challenge from the synced menu");

clover.orders.ORDA2 = { id: "ORDA2", total: 1000, paymentState: "PAID", createdTime: Date.now() + 60_000,
  lineItems: [{ id: "L5", name: "Flat white", price: 350, item: { id: "ITEMFLAT" } }, { id: "L6", name: "Soup of the day", price: 650, item: { id: "ITEMSOUP" } }],
  customers: ["CUSTA"] };
await webhook(orderEvent("ORDA2", "CREATE"));
// Same sitting: spend added to the visit (+10), and both dishes tried (+30).
await points.getByText("73", { exact: true }).waitFor({ timeout: 15000 });
ok("second bill in the same sitting adds spend (+10) and completes the dish challenge (+30) = 73");
await page.locator("li").filter({ hasText: "Try the classics" }).getByText("Done").waitFor();
await page.screenshot({ path: `${OUT}/p3-1-customer.png`, fullPage: true });

// Unmatched order (phone of someone who never joined).
clover.customers.CUSTX = { phones: ["+44 7700 900777"] };
clover.orders.ORDX = { id: "ORDX", total: 900, paymentState: "PAID", createdTime: Date.now(), lineItems: [], customers: ["CUSTX"] };
await webhook(orderEvent("ORDX", "CREATE"));
await until(async () => (await q("select detail from pos_webhook_log where object_id = 'O:ORDX'"))[0]?.detail === "unmatched", "unmatched order");
await owner.goto(`${BASE}/admin/${RID}/pos`);
await owner.getByText("Not a member (no matching phone/email)").waitFor();
await owner.getByText("✅ Member credited").first().waitFor();
ok("POS page lists credited and unmatched orders");
await owner.screenshot({ path: `${OUT}/p3-2-pos.png`, fullPage: true });

// ---------- AI offers ----------
// A lapsed regular: weekly visits for a month, last one 40 days ago, always the carrot cake.
await q(`insert into auth.users (id, phone) values ('ffffffff-0000-0000-0000-000000000001', '447700900031')`);
await q(`update customers set first_name = 'Grace' where id = 'ffffffff-0000-0000-0000-000000000001'`);
for (const d of [61, 54, 47, 40]) {
  await q(`select record_pos_order($1, null, 'clover', $2, 1500, now() - make_interval(days => $3), array['+447700900031'], null,
           '[{"pos_item_id":"ITEMCAKE","name":"Carrot cake","price_cents":450,"quantity":1}]')`, [RID, `HIST${d}`, d]);
}
aiReply = (body) => {
  const guest = JSON.parse(body.messages[0].content);
  return { templateId: guest.eligibleTemplates[0].id, title: "Your carrot cake misses you",
    message: `${guest.firstName}, come back this week and ${guest.eligibleTemplates[0].name.toLowerCase()} is on us.`,
    rationale: "Weekly regular, 40 days away; favourite is carrot cake.", confidence: 0.72 };
};
await owner.goto(`${BASE}/admin/${RID}/ai`);
await owner.getByRole("button", { name: "Generate offers now" }).click();
await owner.getByText(/1 new offer for you to review/).waitFor();
const offer = owner.getByTestId("offer").filter({ hasText: "Grace" });
await offer.getByText("Your carrot cake misses you").waitFor();
const offerText = await offer.innerText(); // innerText applies CSS uppercase, so compare case-insensitively
expect(/written by AI/i.test(offerText) && /win-back/i.test(offerText), "lapsed guest gets an AI-written win-back offer in the inbox");
const lapsedCard = owner.locator("div").filter({ hasText: /^\d+LapsedMuch later/ }).first();
expect((await lapsedCard.innerText()).startsWith("1"), "segments: 1 lapsed guest");

const req = aiRequests[0];
const sent = JSON.parse(req.body.messages[0].content);
expect(req.body.model === "claude-opus-5-5" && req.body.fallbacks === "default" && (req.headers["anthropic-beta"] ?? "").includes("server-side-fallback-2026-07-01"),
  "Claude request: model, server-side refusal fallback");
expect(req.body.output_config?.effort === "low" && req.body.output_config?.format?.type === "json_schema" && req.body.system[0].cache_control?.type === "ephemeral",
  "Claude request: low effort, JSON schema output, cached system prompt");
expect(sent.favouriteItems[0] === "Carrot cake" && !("phone" in sent) && sent.eligibleTemplates.every((t) => t.id && t.name),
  "Claude sees favourites and eligible rewards only, no phone number");
expect(aiRequests.length === 1, "only guests who need an offer are sent to the model");

// Owner rejects with feedback; the next run passes the feedback on, and a bad draft falls back to safe copy.
await offer.getByLabel("Rejection feedback").fill("No discounts on cake please");
await offer.getByRole("button", { name: "Reject" }).click();
await owner.getByText("No offers waiting.").waitFor();
aiReply = (body) => ({ templateId: JSON.parse(body.messages[0].content).eligibleTemplates[0].id, title: "Mega deal", message: "50% off everything this week!", rationale: "x", confidence: 0.9 });
await owner.getByRole("button", { name: "Generate offers now" }).click();
// The form still shows the previous run's message, so wait for the new model call and inbox entry instead.
await until(() => aiRequests.length === 2, "second model request");
const fallback = owner.getByTestId("offer").filter({ hasText: "Grace" });
await fallback.waitFor();
expect(aiRequests.at(-1).body.system[0].text.includes("No discounts on cake please"), "owner's rejection feedback is included in the next prompt");
const fallbackText = await fallback.innerText();
expect(/standard wording/i.test(fallbackText) && !/50% off/i.test(fallbackText), // the card also shows "NN% confidence"
  "a draft promising an unapproved 50% discount is blocked; standard wording is used");

await fallback.getByRole("button", { name: "Approve & send" }).click();
// The approved card leaves "to review" and shows under "Recent decisions".
await owner.locator("li").filter({ hasText: "Grace: We've missed you" }).getByText(/Sent, not used yet/).waitFor();
expect((await owner.getByTestId("offer").count()) === 0, "approving moves the offer out of the review list");
const [reward] = await q(`select r.origin, r.title, r.status from rewards r join memberships m on m.id = r.membership_id
                          where m.customer_id = 'ffffffff-0000-0000-0000-000000000001'`);
expect(reward?.origin === "winback" && reward.status === "active", `approved offer lands in Grace's wallet (${reward?.title})`);
await owner.screenshot({ path: `${OUT}/p3-3-ai.png`, fullPage: true });

// One open offer at a time.
await owner.getByRole("button", { name: "Generate offers now" }).click();
await owner.getByText(/nobody needs an offer right now/).waitFor();
ok("a guest with an unused offer isn't offered another");

// ---------- Cron and disconnect ----------
expect((await fetch(`${BASE}/api/cron/nightly-offers`)).status === 401, "nightly offers cron refuses calls without the secret");
await owner.goto(`${BASE}/admin/${RID}/pos`);
await owner.getByRole("button", { name: "Disconnect" }).click();
await owner.getByRole("link", { name: "Connect Clover" }).waitFor(); // the panel goes back to "not connected"
const [{ n: creds }] = await q("select count(*)::int n from pos_credentials");
expect(creds === 0, "disconnecting deletes the Clover tokens");
clover.orders.ORDA3 = { ...clover.orders.ORDA2, id: "ORDA3" };
await webhook(orderEvent("ORDA3", "CREATE"));
await new Promise((r) => setTimeout(r, 1500));
expect((await q("select 1 from orders where pos_order_id = 'ORDA3'")).length === 0, "webhooks are ignored after disconnecting");

await browser.close();
cloverServer.close();
aiServer.close();
await db.end();
console.log(`\nAll ${step} checks passed.`);
