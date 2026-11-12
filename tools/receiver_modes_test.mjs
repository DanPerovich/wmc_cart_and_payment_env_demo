// Server-level test of the webhook receiver modes (echo default / webhook.site with and without a key /
// other). Starts a fake webhook.site and one app server per mode on test ports, with every relevant
// variable set explicitly so a real app/.env cannot leak in. No real services are called.
// Usage: node receiver_modes_test.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
// Refuse to run if a test port is taken: otherwise the test would silently talk to a stale server.
const assertPortsFree = async (ports) => {
  for (const p of ports) {
    const free = await new Promise((r) => { const s = net.createServer().once("error", () => r(false)).once("listening", () => s.close(() => r(true))); s.listen(p, "0.0.0.0"); });
    if (!free) { console.error(`port ${p} is already in use (a leftover test process?). Stop it and re-run; otherwise this test would talk to a stale server.`); process.exit(2); }
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, "..", "app", "server.js");
const FAKE = path.join(here, "fake_webhook_site.mjs");
const FAKE_PORT = 8782, KEY = "testkey", UUID = "11111111-2222-4333-8444-555555555555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const start = (file, args, env) => { const p = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.out = () => out; procs.push(p); return p; };
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };
const base = { WMC_API_KEY: "", WEBHOOK_API_BASE: `http://localhost:${FAKE_PORT}`, PAYMENTS_MOCK_API_ID: "paymock1", CART_MOCK_API_ID: "cartmock1", WEBHOOK_TOKEN: "" };
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const H = (port) => ({ "X-Requested-With": "payments-demo", Origin: `http://localhost:${port}` });
const fakeLog = async () => (await fetch(`http://localhost:${FAKE_PORT}/__log`)).json();

try {
  await assertPortsFree([8782, 8771, 8772, 8773, 8774, 8775]);
  start(FAKE, [String(FAKE_PORT), KEY], {});
  await sleep(500);

  const modes = [
    { name: "echo (default: no WEBHOOK_URL), even with a webhook.site key set", port: 8771, env: { WEBHOOK_URL: "", WEBHOOK_API_KEY: KEY } },
    { name: "webhook.site alias + key", port: 8772, env: { WEBHOOK_URL: "https://webhook.site/demo-alias", WEBHOOK_API_KEY: KEY } },
    { name: "webhook.site token URL, no key", port: 8773, env: { WEBHOOK_URL: `https://webhook.site/${UUID}`, WEBHOOK_API_KEY: "" } },
    { name: "some other receiver", port: 8774, env: { WEBHOOK_URL: "https://hooks.example.test/in", WEBHOOK_API_KEY: KEY } },
  ];
  for (const m of modes) start(APP, [], { ...base, ...m.env, PORT: String(m.port) });
  await sleep(1200);
  const [echo, alias, nokey, other] = modes.map((m) => `http://localhost:${m.port}`);

  console.log("\n-- echo default");
  let c = (await json(`${echo}/api/config`)).body;
  check("mode is echo", c.webhookMode === "echo");
  check("default target is the WireMock Cloud echo service", c.webhookUrl === "https://wc-echo.wiremockapi.cloud/webhook/echo" && c.webhookHost === "wc-echo.wiremockapi.cloud");
  check("clearing is disabled even though a webhook.site key is set", c.canClearWebhooks === false);
  check("page link points at the Payments mock's request log in WireMock Cloud", c.webhookViewUrl === "https://app.wiremock.cloud/mock-apis/paymock1/requests");
  check("feed reports not-readable (nothing to poll)", (await json(`${echo}/api/webhooks`)).body.status === "not-readable");
  let r = await json(`${echo}/api/webhooks/clear`, { method: "POST", headers: H(8771) });
  check("clear endpoint refuses (400, not supported)", r.status === 400 && /not-supported/.test(r.body.error));

  console.log("\n-- webhook.site alias + key");
  c = (await json(`${alias}/api/config`)).body;
  check("mode is site, host webhook.site", c.webhookMode === "site" && c.webhookHost === "webhook.site");
  check("clearing is enabled", c.canClearWebhooks === true);
  check("page link uses the token resolved from the alias", c.webhookViewUrl === `https://webhook.site/#!/view/${UUID}`);
  let f = (await json(`${alias}/api/webhooks`)).body;
  check("feed is readable and returns the events", f.status === "ok" && f.events.length === 2);
  let log = await fakeLog();
  check("the alias was resolved once via GET /token/demo-alias with the Api-Key", log.some((e) => e.method === "GET" && e.path === "/token/demo-alias" && e.authed));
  check("the feed then used the resolved token UUID", log.some((e) => e.path === `/token/${UUID}/requests` && e.authed));
  check("the key is not exposed in the page config", !JSON.stringify(c).includes(KEY));
  r = await json(`${alias}/api/webhooks/clear`, { method: "POST", headers: H(8772) });
  check("clear succeeds", r.status === 200 && r.body.ok === true);
  log = await fakeLog();
  check("exactly one authenticated DELETE reached webhook.site, on the resolved token", log.filter((e) => e.method === "DELETE").length === 1 && log.some((e) => e.method === "DELETE" && e.path === `/token/${UUID}/request` && e.authed));
  f = (await json(`${alias}/api/webhooks`)).body;
  check("feed is empty after clearing", f.status === "ok" && f.events.length === 0);

  console.log("\n-- webhook.site token URL, no API key");
  await fetch(`http://localhost:${FAKE_PORT}/__seed`);
  c = (await json(`${nokey}/api/config`)).body;
  check("mode is site-no-key, clearing disabled", c.webhookMode === "site-no-key" && c.canClearWebhooks === false);
  check("page link uses the UUID from WEBHOOK_URL (no lookup needed)", c.webhookViewUrl === `https://webhook.site/#!/view/${UUID}`);
  check("feed asks for an API key", (await json(`${nokey}/api/webhooks`)).body.status === "needs-api-key");
  r = await json(`${nokey}/api/webhooks/clear`, { method: "POST", headers: H(8773) });
  check("clear endpoint refuses (400, needs-api-key)", r.status === 400 && r.body.error === "needs-api-key");
  check("nothing was sent to webhook.site", (await fakeLog()).length === 0);

  console.log("\n-- other receiver");
  c = (await json(`${other}/api/config`)).body;
  check("mode is other, clearing disabled even with a key", c.webhookMode === "other" && c.canClearWebhooks === false && c.webhookHost === "hooks.example.test");
  check("no page link", c.webhookViewUrl === null);
  check("feed not-readable", (await json(`${other}/api/webhooks`)).body.status === "not-readable");
  r = await json(`${other}/api/webhooks/clear`, { method: "POST", headers: H(8774) });
  check("clear endpoint refuses (400)", r.status === 400);
  check("nothing was sent to webhook.site", (await fakeLog()).length === 0);

  console.log("\n-- invalid WEBHOOK_URL");
  const bad = start(APP, [], { ...base, WEBHOOK_URL: "not a url", WEBHOOK_API_KEY: "", PORT: "8775" });
  await sleep(1000);
  check("the app refuses to start with a clear message", bad.exitCode === 1 && /WEBHOOK_URL is not a valid URL/.test(bad.out()));
} finally {
  procs.forEach((p) => p.kill());
}
console.log(failures ? `\n${failures} FAILED` : "\nALL RECEIVER-MODE CHECKS PASSED");
process.exit(failures ? 1 : 0);
