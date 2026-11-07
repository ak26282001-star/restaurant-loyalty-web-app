// Local stand-ins for Clover and the Anthropic API, used by e2e/intelligence.mjs.
// They follow the documented request/response shapes closely enough to exercise the real code paths.
import http from "node:http";

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

/**
 * Fake Clover: OAuth v2 (authorize redirect, token, single-use refresh), inventory, orders, customers.
 * `state` is mutable by the test (orders, customers, how many 429s to return, ...).
 */
export function startFakeClover({ port, appId, appSecret, merchantId }) {
  const state = {
    calls: { token: 0, refresh: 0, rateLimited: 0 },
    accessToken: null,
    refreshToken: null,
    usedRefreshTokens: new Set(),
    rateLimitNext: 0,
    items: [],
    orders: {},
    customers: {},
  };
  const issue = (accessTtlSec) => {
    state.accessToken = `at_${Math.random().toString(36).slice(2)}`;
    state.refreshToken = `rt_${Math.random().toString(36).slice(2)}`;
    const now = Math.floor(Date.now() / 1000);
    return { access_token: state.accessToken, access_token_expiration: now + accessTtlSec, refresh_token: state.refreshToken, refresh_token_expiration: now + 365 * 86400 };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/oauth/v2/authorize") {
      // The merchant approves instantly; Clover redirects back with merchant_id, client_id and code.
      if (url.searchParams.get("client_id") !== appId) return json(res, 400, { message: "bad client_id" });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("merchant_id", merchantId);
      back.searchParams.set("client_id", appId);
      back.searchParams.set("code", "AUTHCODE1");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/oauth/v2/token") {
      state.calls.token++;
      const b = JSON.parse(await readBody(req));
      if (b.client_id !== appId || b.client_secret !== appSecret || b.code !== "AUTHCODE1") return json(res, 401, { message: "bad code" });
      return json(res, 200, issue(120)); // expires inside the app's 5-minute refresh margin
    }
    if (req.method === "POST" && url.pathname === "/oauth/v2/refresh") {
      state.calls.refresh++;
      const b = JSON.parse(await readBody(req));
      if (b.client_id !== appId || b.refresh_token !== state.refreshToken || state.usedRefreshTokens.has(b.refresh_token)) {
        return json(res, 401, { message: "refresh token invalid or already used" });
      }
      state.usedRefreshTokens.add(b.refresh_token);
      return json(res, 200, issue(3600));
    }

    const m = url.pathname.match(/^\/v3\/merchants\/([^/]+)\/(items|orders|customers)(?:\/([^/]+))?$/);
    if (!m) return json(res, 404, { message: "not found" });
    if (req.headers.authorization !== `Bearer ${state.accessToken}`) return json(res, 401, { message: "unauthorized" });
    if (m[1] !== merchantId) return json(res, 403, { message: "wrong merchant" });
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--;
      state.calls.rateLimited++;
      return json(res, 429, { message: "Too Many Requests" }, { "retry-after": "0" });
    }
    if (m[2] === "items" && !m[3]) {
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { elements: state.items.slice(offset, offset + limit) });
    }
    if (m[2] === "orders" && m[3]) {
      const o = state.orders[m[3]];
      if (!o) return json(res, 404, { message: "no order" });
      if (url.searchParams.get("expand") !== "lineItems,customers") return json(res, 400, { message: "expected expand" });
      return json(res, 200, { ...o, lineItems: { elements: o.lineItems }, customers: { elements: o.customers.map((id) => ({ id })) } });
    }
    if (m[2] === "customers" && m[3]) {
      const c = state.customers[m[3]];
      if (!c) return json(res, 404, { message: "no customer" });
      return json(res, 200, {
        id: m[3],
        firstName: c.firstName,
        phoneNumbers: { elements: (c.phones ?? []).map((p) => ({ phoneNumber: p })) },
        emailAddresses: { elements: (c.emails ?? []).map((e) => ({ emailAddress: e })) },
      });
    }
    return json(res, 404, { message: "not found" });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, state })));
}

/**
 * Fake Anthropic Messages API. `reply(requestBody)` returns the object the model "writes";
 * every request is recorded with its headers for assertions.
 */
export function startFakeAnthropic({ port, reply }) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "nope" } });
    const body = JSON.parse(await readBody(req));
    requests.push({ url: req.url, headers: req.headers, body });
    if (process.env.FAKE_DEBUG) console.log(`[fake-anthropic] request ${requests.length} ${req.method} ${req.url}`);
    const out = reply(body, requests.length);
    return json(res, 200, {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(out) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, requests })));
}
