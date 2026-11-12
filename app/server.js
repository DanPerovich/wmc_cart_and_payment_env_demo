#!/usr/bin/env node
// Demo web app server: serves ./public and proxies the webhook.site feed
// (webhook.site's API sends no CORS headers, so the browser cannot call it directly).
// Usage: node server.js            (PORT, PAYMENTS_URL, CART_URL, WEBHOOK_TOKEN override defaults)
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load KEY=VALUE pairs from ./.env (next to this file). Variables already set in the real
// environment win over the file. Supports # comments, blank lines, `export KEY=...` and
// single or double quoted values. No dependencies, works on any Node version.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return 0; }
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith("#")) continue;
    let value = m[2];
    const quoted = value.match(/^(["'])(.*?)\1(?:\s+#.*)?$/); // "..." or '...' plus optional comment
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, ""); // else strip a trailing comment
    if (process.env[m[1]] === undefined) { process.env[m[1]] = value; loaded++; }
  }
  return loaded;
}
const dotEnvLoaded = loadDotEnv(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 8787;
const CONFIG = {
  // The demo mocks are provisioned per user (./demo-setup.sh writes these into app/.env). There are
  // deliberately no built-in defaults: a default would point at someone else's (or a deleted) mock.
  paymentsUrl: (process.env.PAYMENTS_URL || "").replace(/\/+$/, ""),
  cartUrl: (process.env.CART_URL || "").replace(/\/+$/, ""),
};
CONFIG.configured = Boolean(CONFIG.paymentsUrl && CONFIG.cartUrl);

// ---- Webhook receiver ----------------------------------------------------------------------
// The Payments API mock delivers its webhooks to WEBHOOK_URL (baked into its stubs when it is
// provisioned; see tools/setup-demo.mjs). The default is WireMock Cloud's free echo service, which
// replies with a copy of the request and stores nothing. What the app can do with the target:
//   webhook.site + WEBHOOK_API_KEY   list the events here, and "Clear webhook.site log" works
//   webhook.site, no API key         events are delivered but cannot be listed here
//   WireMock Cloud echo / anything   events are delivered but cannot be listed here; see the
//   else                             Payments mock's request log in WireMock Cloud
const ECHO_HOST = "wc-echo.wiremockapi.cloud";
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://${ECHO_HOST}/webhook/echo`;
let hookUrl;
try { hookUrl = new URL(WEBHOOK_URL); } catch (_) { console.error(`WEBHOOK_URL is not a valid URL: ${WEBHOOK_URL}`); process.exit(1); }
const isWebhookSite = hookUrl.hostname === "webhook.site";
// A webhook.site address is either a token UUID or a custom alias in the first path segment.
const siteRef = isWebhookSite ? hookUrl.pathname.split("/").filter(Boolean)[0] || "" : "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Account-owned webhook.site URLs need an API key (sent as `Api-Key`) to read or delete their
// requests. The key is read from the environment only; it is never sent to the browser.
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || "";
// Base URL of webhook.site's API (overridable so tests can use a local fake).
const WEBHOOK_API_BASE = (process.env.WEBHOOK_API_BASE || "https://webhook.site").replace(/\/+$/, "");
const WEBHOOK_MODE = isWebhookSite ? (WEBHOOK_API_KEY ? "site" : "site-no-key") : hookUrl.hostname === ECHO_HOST ? "echo" : "other";
CONFIG.webhookUrl = WEBHOOK_URL;
CONFIG.webhookHost = hookUrl.hostname;
CONFIG.webhookMode = WEBHOOK_MODE;
// Only a webhook.site target with an API key can have its log cleared (never the key itself).
CONFIG.canClearWebhooks = WEBHOOK_MODE === "site";

// The webhook.site token UUID: WEBHOOK_TOKEN, else the UUID in WEBHOOK_URL, else resolved once from
// the alias through webhook.site's API (needs the API key).
let webhookTokenCache = process.env.WEBHOOK_TOKEN || (UUID_RE.test(siteRef) ? siteRef : "");
async function webhookToken() {
  if (webhookTokenCache) return webhookTokenCache;
  if (!WEBHOOK_API_KEY || !siteRef) return null;
  const r = await fetch(`${WEBHOOK_API_BASE}/token/${encodeURIComponent(siteRef)}`, {
    headers: { Accept: "application/json", "Api-Key": WEBHOOK_API_KEY },
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(`webhook.site returned ${r.status}`);
  webhookTokenCache = (await r.json()).uuid || "";
  return webhookTokenCache || null;
}

// "New demo" also resets the mock APIs' dynamic state and request journals through the WireMock
// Cloud API, authenticated with `Authorization: Token <WMC_API_KEY>` (your API key, from your
// WireMock Cloud account security page).
const WMC_API_KEY = process.env.WMC_API_KEY || "";
const WMC_API_BASE = (process.env.WMC_API_BASE || "https://api.wiremock.cloud").replace(/\/+$/, "");
const MOCKS_TO_RESET = [
  { name: "Payments API", id: process.env.PAYMENTS_MOCK_API_ID || "" },
  { name: "Shopping Cart API (demo copy)", id: process.env.CART_MOCK_API_ID || "" },
];
// The original shared cart mock must never be reset by this demo, whatever the configuration says.
const PROTECTED_MOCK_IDS = new Set(["y09z4"]);
const MOCK_IDS_CONFIGURED = MOCKS_TO_RESET.every((m) => m.id);
CONFIG.canResetMocks = Boolean(WMC_API_KEY) && MOCK_IDS_CONFIGURED;
// Why "New demo" cannot reset the mocks (the page words it): no key, or no mocks configured.
CONFIG.resetBlocker = !WMC_API_KEY ? "no-key" : !MOCK_IDS_CONFIGURED ? "not-configured" : null;

const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// One shared poller with a short cache. webhook.site rate-limits anonymous callers (429,
// "try again in 15 seconds"), so on a 429 we back off and keep serving the last good result.
const cache = { events: [], at: 0 };
let backoffUntil = 0;

async function webhookFeed() {
  const now = Date.now();
  if (WEBHOOK_MODE === "site-no-key") return { status: "needs-api-key", events: [] };
  if (WEBHOOK_MODE !== "site") return { status: "not-readable", events: [] };
  const token = await webhookToken();
  if (!token) return { status: "needs-api-key", events: [] };
  if (now < backoffUntil) return { status: "rate-limited", events: cache.events };
  if (now - cache.at < 2000) return { status: "ok", events: cache.events };
  const r = await fetch(
    `${WEBHOOK_API_BASE}/token/${token}/requests?sorting=newest&per_page=50`,
    { headers: { Accept: "application/json", "Api-Key": WEBHOOK_API_KEY } }
  );
  if (r.status === 429) {
    backoffUntil = Date.now() + 15000;
    return { status: "rate-limited", events: cache.events };
  }
  if (r.status === 401 || r.status === 403) return { status: "needs-api-key", events: [] };
  if (!r.ok) throw new Error(`webhook.site returned ${r.status}`);
  const body = await r.json();
  cache.events = (body.data || []).map((e) => {
    let payload = null;
    try { payload = JSON.parse(e.content); } catch (_) { /* not JSON */ }
    return { uuid: e.uuid, createdAt: e.created_at, payload, raw: payload ? undefined : e.content };
  });
  cache.at = Date.now();
  return { status: "ok", events: cache.events };
}

// Destructive endpoints are only reachable from this page: POST, a custom header (which makes a
// cross-site request need a CORS preflight we never grant) and a same-origin Origin.
function guardMutation(req) {
  if (req.method !== "POST") return { code: 405, body: { error: "use POST" } };
  if (req.headers["x-requested-with"] !== "payments-demo") return { code: 403, body: { error: "forbidden" } };
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return { code: 403, body: { error: "cross-origin request refused" } };
  return null;
}

// Permanently deletes EVERY request stored on the webhook.site URL.
async function clearWebhookLog(req) {
  const denied = guardMutation(req);
  if (denied) return denied;
  if (WEBHOOK_MODE === "site-no-key") return { code: 400, body: { error: "needs-api-key" } };
  if (WEBHOOK_MODE !== "site") return { code: 400, body: { error: "not-supported: the webhook target is not webhook.site" } };
  const token = await webhookToken();
  if (!token) return { code: 400, body: { error: "needs-api-key" } };
  const r = await fetch(`${WEBHOOK_API_BASE}/token/${token}/request`, {
    method: "DELETE",
    headers: { Accept: "application/json", "Api-Key": WEBHOOK_API_KEY },
  });
  if (r.status === 429) return { code: 429, body: { error: "webhook.site is rate limiting, try again shortly" } };
  if (r.status === 401 || r.status === 403) return { code: 400, body: { error: "needs-api-key" } };
  if (!r.ok) return { code: 502, body: { error: `webhook.site returned ${r.status}` } };
  cache.events = [];
  cache.at = 0;
  backoffUntil = 0;
  return { code: 200, body: { ok: true } };
}

// Resets dynamic state (carts, orders, payments, refunds) and empties the request journal of each
// demo mock API. Stubs, specs and data sources are untouched.
async function resetMockApis(req) {
  const denied = guardMutation(req);
  if (denied) return denied;
  if (!WMC_API_KEY) return { code: 400, body: { error: "needs-wmc-api-key" } };
  if (!MOCK_IDS_CONFIGURED) return { code: 400, body: { error: "not-configured: set PAYMENTS_MOCK_API_ID and CART_MOCK_API_ID (./demo-setup.sh writes them)" } };
  const blocked = MOCKS_TO_RESET.find((m) => PROTECTED_MOCK_IDS.has(m.id));
  if (blocked) return { code: 400, body: { error: `refusing to reset protected mock API ${blocked.id}` } };
  const auth = `Token ${WMC_API_KEY}`;
  const call = async (id, method, tail) => {
    try {
      const r = await fetch(`${WMC_API_BASE}/v1/mock-apis/${id}${tail}`, {
        method,
        headers: { Authorization: auth, Accept: "application/json" },
      });
      return r.ok ? "ok" : r.status === 401 || r.status === 403 ? "API key rejected" : `HTTP ${r.status}`;
    } catch (e) {
      return `unreachable (${e.message})`;
    }
  };
  const results = await Promise.all(
    MOCKS_TO_RESET.map(async (m) => ({
      mock: m.name,
      id: m.id,
      // `POST .../requests/reset` is deprecated (and now 404s); DELETE .../requests replaces it.
      state: await call(m.id, "POST", "/scenarios/reset"),
      requestLog: await call(m.id, "DELETE", "/requests"),
    }))
  );
  const ok = results.every((r) => r.state === "ok" && r.requestLog === "ok");
  return { code: ok ? 200 : 502, body: { ok, results } };
}

// CONFIG plus the page link for the webhook log: webhook.site's page, or (for the echo service,
// which stores nothing) the Payments mock's request log in WireMock Cloud, where each webhook and
// its response are shown under the request that triggered it.
async function configForPage() {
  let webhookViewUrl = null;
  if (WEBHOOK_MODE === "site" || WEBHOOK_MODE === "site-no-key") {
    let token = null;
    try { token = await webhookToken(); } catch (_) { /* fall back to the site's home page */ }
    webhookViewUrl = token ? `https://webhook.site/#!/view/${token}` : "https://webhook.site/";
  } else if (WEBHOOK_MODE === "echo") {
    const payments = MOCKS_TO_RESET[0].id;
    webhookViewUrl = payments ? `https://app.wiremock.cloud/mock-apis/${payments}/requests` : null;
  }
  return { ...CONFIG, webhookViewUrl };
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/config") return send(res, 200, "application/json", JSON.stringify(await configForPage()));
      if (url.pathname === "/api/reset-mocks") {
        const r = await resetMockApis(req);
        return send(res, r.code, "application/json", JSON.stringify(r.body));
      }
      if (url.pathname === "/api/webhooks/clear") {
        const r = await clearWebhookLog(req);
        return send(res, r.code, "application/json", JSON.stringify(r.body));
      }
      if (url.pathname === "/api/webhooks") {
        return send(res, 200, "application/json", JSON.stringify(await webhookFeed()));
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "text/plain", "forbidden");
      fs.readFile(file, (err, data) =>
        err
          ? send(res, 404, "text/plain", "not found")
          : send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", data)
      );
    } catch (e) {
      send(res, 502, "application/json", JSON.stringify({ error: String(e.message || e) }));
    }
  })
  .listen(PORT, () => {
    console.log(`Demo app: http://localhost:${PORT}`);
    console.log(`.env: ${dotEnvLoaded} value(s) loaded | webhook feed API key: ${WEBHOOK_API_KEY ? "set" : "NOT set"}`);
    const modeText = { site: "readable and clearable (webhook.site API key set)", "site-no-key": "delivered, but not readable here (no WEBHOOK_API_KEY)",
      echo: "delivered to the WireMock Cloud echo service (not readable here; see the Payments mock's request log)", other: "delivered, but not readable here" }[WEBHOOK_MODE];
    console.log(`Webhook target: ${WEBHOOK_URL} -> ${modeText}`);
    console.log(CONFIG.configured
      ? `Mocks: payments ${CONFIG.paymentsUrl} | cart ${CONFIG.cartUrl}`
      : "Mocks: NOT configured. Run ./demo-setup.sh (it writes PAYMENTS_URL, CART_URL and the mock IDs into app/.env) or set them yourself.");
    console.log(`WireMock Cloud API key for "New demo" mock reset: ${WMC_API_KEY ? "set" : "NOT set (needs WMC_API_KEY)"}`);
  });
