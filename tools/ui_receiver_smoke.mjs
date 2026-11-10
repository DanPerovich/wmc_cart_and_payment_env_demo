// Browser test of how the page presents each webhook receiver mode (echo default / webhook.site with
// and without a key / other). Starts a fake webhook.site and one app per mode; nothing real is called.
// Usage: node ui_receiver_smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, "..", "app", "server.js"), FAKE = path.join(here, "fake_webhook_site.mjs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAKE_PORT = 8782, KEY = "testkey", UUID = "11111111-2222-4333-8444-555555555555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const start = (file, args, env) => { const p = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" }); procs.push(p); return p; };
const base = { WMC_API_KEY: "", WEBHOOK_API_BASE: `http://localhost:${FAKE_PORT}`, PAYMENTS_MOCK_API_ID: "paymock1", CART_MOCK_API_ID: "cartmock1", WEBHOOK_TOKEN: "" };
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

const modes = [
  { name: "echo (default)", port: 8771, env: { WEBHOOK_URL: "", WEBHOOK_API_KEY: KEY } },
  { name: "webhook.site + key", port: 8772, env: { WEBHOOK_URL: "https://webhook.site/demo-alias", WEBHOOK_API_KEY: KEY } },
  { name: "webhook.site, no key", port: 8773, env: { WEBHOOK_URL: `https://webhook.site/${UUID}`, WEBHOOK_API_KEY: "" } },
  { name: "other receiver", port: 8774, env: { WEBHOOK_URL: "https://hooks.example.test/in", WEBHOOK_API_KEY: KEY } },
];
const chromePort = 9336;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "uirecv-"))}`, "--window-size=1500,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
let ws;
try {
  start(FAKE, [String(FAKE_PORT), KEY], {});
  for (const m of modes) start(APP, [], { ...base, ...m.env, PORT: String(m.port) });
  await sleep(1500);

  let target;
  for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://localhost:${chromePort}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(250); } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const open = async (port) => { await cdp("Page.navigate", { url: `http://localhost:${port}/` }); await sleep(2500); };
  const snap = () => run(`(() => { const q = (s) => document.querySelector(s); const vis = (e) => !!e && !e.hidden;
    return { linkVisible: vis(q('#lnkWebhook')), linkText: q('#lnkWebhook').textContent, linkHref: q('#lnkWebhook').getAttribute('href'),
      clearVisible: vis(q('#btnClearHooks')), clearDisabled: q('#btnClearHooks').disabled, clearTitle: q('#btnClearHooks').title,
      target: q('#feedTarget').textContent, events: q('#events').innerText, dot: q('#feedDot').className, status: q('#feedStatus').textContent,
      feedRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/webhooks')).length }; })()`);

  console.log("-- echo (default)");
  await open(8771); let s = await snap();
  check("panel names the echo host", s.target === "wc-echo.wiremockapi.cloud");
  check("header link is 'Request log' pointing at the Payments mock's request log", s.linkVisible && s.linkText.startsWith("Request log") && s.linkHref === "https://app.wiremock.cloud/mock-apis/paymock1/requests");
  check("Clear webhook.site log button is hidden (even though a key is set)", !s.clearVisible);
  check("panel explains the echo service stores nothing and how to see webhooks", /WireMock Cloud echo service/.test(s.events) && /stores nothing/.test(s.events) && /request log/i.test(s.events));
  check("panel says how to get a listed feed (webhook.site + API key)", /WEBHOOK_API_KEY/.test(s.events));
  check("no 'Waiting for events' placeholder", !/Waiting for events/.test(s.events));
  check("neutral (grey) status dot, no error text", s.dot.includes("idle") && s.status === "");
  await sleep(4000); s = await snap();
  check("the page does not poll /api/webhooks at all", s.feedRequests === 0);

  console.log("-- webhook.site + key");
  await open(8772); s = await snap();
  check("panel names webhook.site", s.target === "webhook.site");
  check("header link is 'webhook.site' with the resolved view URL", s.linkVisible && s.linkText.startsWith("webhook.site") && s.linkHref === `https://webhook.site/#!/view/${UUID}`);
  check("Clear webhook.site log button is visible and enabled", s.clearVisible && !s.clearDisabled);
  check("events from webhook.site are listed", /payment\.succeeded/.test(s.events) && !/stores nothing/.test(s.events));
  check("green status dot", !s.dot.includes("idle") && !s.dot.includes("off") && !s.dot.includes("warn"));

  console.log("-- webhook.site, no key");
  await open(8773); s = await snap();
  check("Clear button is visible but disabled, with the reason", s.clearVisible && s.clearDisabled && /WEBHOOK_API_KEY/.test(s.clearTitle));
  check("panel explains an API key is needed to list events", /API key/.test(s.events) && /WEBHOOK_API_KEY/.test(s.events));
  check("header link goes to the webhook.site page", s.linkVisible && s.linkHref === `https://webhook.site/#!/view/${UUID}`);

  console.log("-- other receiver");
  await open(8774); s = await snap();
  check("panel names the host", s.target === "hooks.example.test");
  check("Clear button hidden, header link hidden", !s.clearVisible && !s.linkVisible);
  check("panel says events cannot be read back from that receiver", /cannot read events back/.test(s.events));
} catch (e) { console.error(String(e.stack || e)); failures++; }
finally { try { ws.close(); } catch {} chrome.kill(); procs.forEach((p) => p.kill()); }
console.log(failures ? `\n${failures} FAILED` : "\nALL RECEIVER UI CHECKS PASSED");
process.exit(failures ? 1 : 0);
