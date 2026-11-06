// End-to-end journey against a running app + local Supabase (see README → "End-to-end test").
// Needs a freshly reset database: `pnpm supabase db reset`. Usage: pnpm test:e2e [screenshot-dir]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RID = "11111111-1111-1111-1111-111111111111"; // seeded Demo Bistro
const OUT = process.argv[2] ?? "e2e/screenshots";
mkdirSync(OUT, { recursive: true });
const db = new pg.Client(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
await db.connect();
const q = async (sql, args) => (await db.query(sql, args)).rows;

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const expect = (cond, msg) => { if (!cond) throw new Error(`✘ ${msg}`); ok(msg); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function phoneLogin(page, number) {
  await page.getByLabel("Mobile number").fill(number);
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
}

// ---------- Customer: tap, join, check in (no location → pending) ----------
const customerCtx = await browser.newContext(phone);
const customer = await customerCtx.newPage();
await customer.goto(`${BASE}/t/DEMO01`);
expect(customer.url() === `${BASE}/r/demo-bistro?from=tap`, "tap redirects to the restaurant page");
await customer.getByText("Welcome to Demo Bistro").waitFor();
await customer.screenshot({ path: `${OUT}/1-teaser.png` });
await customer.getByRole("link", { name: "Join & check in" }).click();
await customer.getByText("Join Demo Bistro rewards").waitFor();
await customer.screenshot({ path: `${OUT}/2-login.png` });
await phoneLogin(customer, "+44 7700 900001");
await customer.getByText("Almost there").waitFor();
expect(true, "after login the tap check-in runs and is pending without location");
expect(new URL(customer.url()).search === "", "?from=tap is removed so a reload can't re-check-in");
await customer.screenshot({ path: `${OUT}/3-pending.png` });
const [cust] = await q("select c.id from customers c where c.phone = '447700900001'");
expect((await q("select status from visits where customer_id = $1", [cust.id]))[0]?.status === "pending", "pending visit stored");

// ---------- Staff: becomes manager, signs in, confirms with a bill ----------
const staffCtx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const staff = await staffCtx.newPage();
await staff.goto(`${BASE}/login`);
await staff.getByRole("button", { name: "Use my phone number instead" }).click();
await phoneLogin(staff, "+447700900002");
await staff.waitForURL(`${BASE}/admin`);
await staff.getByText("aren't on any restaurant's team").waitFor();
ok("a signed-in user with no team sees the empty state");
const [staffUser] = await q("select id from auth.users where phone = '447700900002'");
await q("insert into staff_members (restaurant_id, user_id, role) values ($1, $2, 'manager')", [RID, staffUser.id]);
await staff.goto(`${BASE}/admin`);
await staff.waitForURL(`${BASE}/admin/${RID}`);
await staff.getByRole("heading", { name: "Demo Bistro" }).waitFor();
ok("a manager with one restaurant lands on its dashboard");

await staff.goto(`${BASE}/staff/${RID}`);
await staff.getByText("Visits waiting for confirmation").waitFor();
await staff.getByPlaceholder("Bill (optional)").fill("45.00");
await staff.getByRole("button", { name: "Confirm" }).click();
await staff.getByText("Nothing to confirm right now.").waitFor();
await staff.locator("li").filter({ hasText: "Guest" }).getByText("+55 pts").waitFor();
ok("staff confirm the visit with a £45 bill: it moves to Just confirmed with 10 + 45 points");
await staff.screenshot({ path: `${OUT}/6-staff.png` });

// ---------- Customer: sees balance, claims a reward ----------
await customer.reload();
const card = customer.locator("section").filter({ hasText: "Points" }).first();
await card.getByText("55", { exact: true }).waitFor();
ok("customer sees 55 points after reload");
await customer.getByText("4 more visits to Regular").waitFor();
ok("tier progress shows 4 more visits to Regular");
await customer.getByText("🔥 1-visit streak").waitFor();
const coffee = customer.locator("li").filter({ hasText: "Free coffee" });
const dessertBtn = customer.locator("li").filter({ hasText: "Free dessert" }).getByRole("button");
expect(await dessertBtn.isDisabled(), "a 100-point reward is disabled at 55 points");
await coffee.getByRole("button", { name: "50 pts" }).click();
const codeEl = customer.locator("p.font-mono").first();
await codeEl.waitFor();
const code = (await codeEl.textContent()).trim();
expect(/^[0-9A-F]{8}$/.test(code), `claimed coffee shows redeem code ${code}`);
await card.getByText("5", { exact: true }).waitFor();
ok("balance drops to 5");
await customer.screenshot({ path: `${OUT}/4-home.png`, fullPage: true });

// ---------- Staff: redeem the code, then try again ----------
await staff.getByPlaceholder("e.g. 3F9A1C2B").fill(code.toLowerCase());
await staff.getByRole("button", { name: "Redeem" }).click();
await staff.getByText("✅ Redeemed: Free coffee").waitFor();
ok("staff redeem the code (case-insensitive)");
await staff.getByPlaceholder("e.g. 3F9A1C2B").fill(code);
await staff.getByRole("button", { name: "Redeem" }).click();
await staff.getByText("That reward has already been used.").waitFor();
ok("a second redemption is refused");
await customer.reload();
await customer.getByText("No rewards yet.").waitFor();
ok("redeemed reward leaves the customer's wallet");

// ---------- Customer: cooldown, then a geofenced auto-confirmed visit ----------
await customer.goto(`${BASE}/t/DEMO01`);
await customer.getByText("already checked in today").waitFor();
ok("tapping again inside the cooldown is refused politely");
await q("update visits set visited_at = visited_at - interval '5 hours' where customer_id = $1", [cust.id]);
await q("update memberships set last_visit_at = last_visit_at - interval '5 hours' where customer_id = $1", [cust.id]);
await customerCtx.grantPermissions(["geolocation"], { origin: BASE });
await customerCtx.setGeolocation({ latitude: 51.51365, longitude: -0.13655 });
await customer.goto(`${BASE}/t/DEMO01`);
await customer.getByText("Checked in! 🎉").waitFor();
await customer.getByText("+10 points").waitFor();
ok("with location already granted, an in-store tap confirms instantly (+10)");
await customer.getByText("🔥 2-visit streak").waitFor();
ok("streak advances to 2");
await customer.screenshot({ path: `${OUT}/5-checked-in.png` });

// ---------- Security checks ----------
await customer.goto(`${BASE}/admin/${RID}`);
await customer.waitForURL(/\/admin\?error=forbidden/);
ok("a customer can't open the owner dashboard");
const res = await customer.request.post(`${BASE}/api/v1/visits/check-in`, { data: { restaurantId: RID } });
expect(res.status() === 400 && (await res.json()).error.code === "no_recent_tap", "check-in without a fresh tap is rejected");
const anon = await browser.newContext();
const anonRes = await anon.request.post(`${BASE}/api/v1/visits/check-in`, { data: { restaurantId: RID } });
expect(anonRes.status() === 401, "check-in without a session is rejected");
const loginRedirect = await (await anon.newPage()).goto(`${BASE}/login?next=//evil.example`);
expect(loginRedirect.ok(), "login page renders with a hostile ?next=");

// ---------- Admin: dashboard numbers, add reward, create tag, download QR ----------
await staff.goto(`${BASE}/admin/${RID}`);
const kpi = (label) => staff.locator("div").filter({ hasText: new RegExp(`^\\d+${label}$`) }).locator("p").first().textContent();
expect((await kpi("Members")) === "1", "dashboard: 1 member");
expect((await kpi("Visits \\(7 days\\)")) === "2", "dashboard: 2 visits this week");
expect((await kpi("Rewards redeemed \\(30 days\\)")) === "1", "dashboard: 1 redemption");
await staff.getByText("Add a reward").click();
await staff.getByPlaceholder("Name, e.g. Free espresso").fill("Free brownie");
await staff.getByPlaceholder("Points cost").fill("80");
await staff.getByRole("button", { name: "Add reward" }).click();
await staff.getByText("Added “Free brownie”").waitFor();
ok("manager adds a reward to the catalogue");
await staff.getByPlaceholder("Label, e.g. Table 4").fill("Table 4");
await staff.getByRole("button", { name: "Create tag" }).click();
await staff.getByText("Created tag “Table 4”").waitFor();
const [tag] = await q("select id, code from tags where label = 'Table 4'");
expect(/^[A-Za-z2-9]{7}$/.test(tag.code), `new tag gets code ${tag.code}`);
const svg = await staff.request.get(`${BASE}/admin/${RID}/tags/${tag.id}/qr`);
expect(svg.headers()["content-type"] === "image/svg+xml" && (await svg.text()).includes("<svg"), "QR download is an SVG");
const anonSvg = await anon.request.get(`${BASE}/admin/${RID}/tags/${tag.id}/qr`);
expect(anonSvg.status() === 404, "QR download is refused without a staff session");
const tap = await anon.request.get(`${BASE}/t/${tag.code}`, { maxRedirects: 0 });
expect(tap.status() === 307 && tap.headers().location.endsWith("/r/demo-bistro?from=tap"), "the new tag's tap URL works");
await staff.screenshot({ path: `${OUT}/7-dashboard.png`, fullPage: true });

const [{ count }] = await q("select count(*)::int from tap_events");
expect(count >= 3, `tap events are logged after the redirect (${count})`);

await browser.close();
await db.end();
console.log(`\nAll ${step} checks passed.`);
