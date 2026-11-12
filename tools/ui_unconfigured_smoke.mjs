// Browser test: with no demo mocks configured the app must say so and must not call any mock; with them
// configured the notice is gone. Uses throwaway app instances only; nothing real is called.
// Usage: node ui_unconfigured_smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePort = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const start = (env) => { const p = spawn(process.execPath, [APP], { env: { PATH: process.env.PATH, WEBHOOK_URL: "", WEBHOOK_API_KEY: "", WEBHOOK_TOKEN: "", ...env }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.out = () => out; procs.push(p); return p; };
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "uiuc-"))}`, "--window-size=1500,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
let ws;
try {
  await assertPortsFree([8771, 8772]);
  const none = { PAYMENTS_URL: "", CART_URL: "", PAYMENTS_MOCK_API_ID: "", CART_MOCK_API_ID: "", WMC_API_KEY: "somekey" };
  const unconfigured = start({ ...none, PORT: "8771" });
  const configured = start({ PAYMENTS_URL: "https://pay.invalid/", CART_URL: "https://cart.invalid", PAYMENTS_MOCK_API_ID: "pm1", CART_MOCK_API_ID: "cm1", WMC_API_KEY: "", PORT: "8772" });
  await sleep(1500);

  console.log("-- server, nothing configured");
  const cfg = await (await fetch("http://localhost:8771/api/config")).json();
  check("config: configured=false, no mock URLs, reset blocked as 'not-configured'", cfg.configured === false && cfg.paymentsUrl === "" && cfg.cartUrl === "" && cfg.canResetMocks === false && cfg.resetBlocker === "not-configured");
  const r = await fetch("http://localhost:8771/api/reset-mocks", { method: "POST", headers: { "X-Requested-With": "payments-demo", Origin: "http://localhost:8771" } });
  const rb = await r.json();
  check("reset endpoint refuses (400 not-configured) even with a WireMock Cloud key", r.status === 400 && /not-configured/.test(rb.error));
  check("startup log tells you to run ./demo-setup.sh", /Mocks: NOT configured.*demo-setup\.sh/.test(unconfigured.out()));
  const cfg2 = await (await fetch("http://localhost:8772/api/config")).json();
  check("config with URLs set: configured=true, trailing slash trimmed", cfg2.configured === true && cfg2.paymentsUrl === "https://pay.invalid" && cfg2.cartUrl === "https://cart.invalid");

  let target;
  for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://localhost:${chromePort}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(250); } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const open = async (port) => { await cdp("Page.navigate", { url: `http://localhost:${port}/` }); await sleep(2500); };

  console.log("-- browser, nothing configured");
  await open(8771);
  const s = await run(`(() => ({ banner: !document.getElementById('setupBanner').hidden, bannerText: document.getElementById('setupBanner').innerText, products: document.getElementById('products').innerText, cartLinkHidden: document.getElementById('lnkCart').hidden,
    hosts: [...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).host))] }))()`);
  check("the setup notice is shown and says what to run and which variables", s.banner && /\.\/demo-setup\.sh/.test(s.bannerText) && /PAYMENTS_URL/.test(s.bannerText) && /PAYMENT.*MOCK_API_ID|PAYMENTS_MOCK_API_ID/.test(s.bannerText));
  check("the product list explains it is unavailable", /Not available until the demo mocks are configured/.test(s.products));
  check("the Cart API header link is hidden", s.cartLinkHidden);
  check("the page called no mock host (only this app)", s.hosts.every((h) => h.startsWith("localhost")));
  await run(`document.getElementById('btnReset').click()`);
  await sleep(1500);
  const after = await run(`({ status: document.getElementById('resetStatus').textContent, bad: document.getElementById('resetStatus').classList.contains('bad'), tabs: document.querySelectorAll('.tab').length })`);
  check("New demo says no mocks are configured (and still resets the page)", /no demo mocks are configured/.test(after.status) && after.bad && after.tabs === 1);

  console.log("-- browser, configured");
  await open(8772);
  const c = await run(`({ banner: !document.getElementById('setupBanner').hidden, cartLinkHidden: document.getElementById('lnkCart').hidden, cartHref: document.getElementById('lnkCart').getAttribute('href') })`);
  check("no setup notice, the Cart API link points at the configured cart mock", !c.banner && !c.cartLinkHidden && c.cartHref === "https://cart.invalid/products");
} catch (e) { console.error(String(e.stack || e)); failures++; }
finally { try { ws.close(); } catch {} chrome.kill(); procs.forEach((p) => p.kill()); }
console.log(failures ? `\n${failures} FAILED` : "\nALL UNCONFIGURED-STATE CHECKS PASSED");
process.exit(failures ? 1 : 0);
