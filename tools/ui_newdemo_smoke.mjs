// Browser test: "New demo" hides the webhook list immediately, keeps late webhooks for the closed session's
// payments hidden, and still shows webhooks for new payments. Uses a fake webhook.site; nothing real is touched.
// Usage: node ui_newdemo_smoke.mjs
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
const APP = path.join(here, "..", "app", "server.js"), FAKE = path.join(here, "fake_webhook_site.mjs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAKE_PORT = 8782, APP_PORT = 8771, KEY = "testkey", chromePort = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const start = (file, args, env) => { const p = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" }); procs.push(p); return p; };
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };
const add = (type, id, paymentId) => fetch(`http://localhost:${FAKE_PORT}/__add?type=${type}&id=${id}${paymentId ? `&paymentId=${paymentId}` : ""}`);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "uind-"))}`, "--window-size=1500,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
let ws;
try {
  await assertPortsFree([8782, 8771]);
  start(FAKE, [String(FAKE_PORT), KEY], {});
  start(APP, [], { WMC_API_KEY: "", WEBHOOK_URL: "https://webhook.site/demo-alias", WEBHOOK_API_KEY: KEY, WEBHOOK_API_BASE: `http://localhost:${FAKE_PORT}`, WEBHOOK_TOKEN: "", PAYMENTS_MOCK_API_ID: "paymock1", CART_MOCK_API_ID: "cartmock1", PORT: String(APP_PORT) });
  await sleep(1500);
  let target;
  for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://localhost:${chromePort}/json/new?http://localhost:${APP_PORT}/`, { method: "PUT" })).json(); } catch { await sleep(250); } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const until = async (label, pred, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(pred)) return true; await sleep(200); } return false; };
  const evText = `document.getElementById('events').innerText`;
  const evCount = `document.querySelectorAll('#events .ev').length`;

  await fetch(`http://localhost:${FAKE_PORT}/__seed`);
  check("the two seeded events show on load", await until("seeded", `${evCount} === 2`));

  // pretend this browser session made payment pay_old (the real page records it when you pay)
  await run(`carts[0].payment = { id: 'pay_old', status: 'succeeded', amount: 500, amountRefunded: 0, responseCode: '00', responseMessage: 'ok' }`);
  await add("payment.succeeded", "pay_old");                       // its webhook arrives and is listed
  check("the session's own payment webhook is listed", await until("pay_old", `${evText}.includes('pay_old')`));

  // 1) click New demo and look at the panel in the SAME tick: it must already be cleared (no waiting for a poll)
  const sync = await run(`(() => { document.getElementById('btnReset').click(); return { text: ${evText}, count: ${evCount} }; })()`);
  check("the panel is cleared synchronously by the click", sync.count === 0 && /No events yet/.test(sync.text));

  // 2) a webhook for the closed session's payment arrives late (refund fired just before the click)
  await add("refund.succeeded", "ref_late", "pay_old");
  await sleep(4500);                                                // > one poll interval
  check("a late webhook for the closed session's payment stays hidden", (await run(evCount)) === 0);

  // 3) but a webhook for a new payment is shown
  await add("payment.succeeded", "pay_new");
  check("a webhook for a new payment appears", await until("pay_new", `${evText}.includes('pay_new')`, 8000));
  check("and only that one is listed", (await run(evCount)) === 1);

  // 4) all of that survives a reload
  await cdp("Page.reload"); await sleep(2500);
  check("after reload: still only the new payment's webhook", (await run(evCount)) === 1 && (await run(evText)).includes('pay_new') && !(await run(evText)).includes('pay_old'));
} catch (e) { console.error(String(e.stack || e)); failures++; }
finally { try { ws.close(); } catch {} chrome.kill(); procs.forEach((p) => p.kill()); }
console.log(failures ? `\n${failures} FAILED` : "\nALL NEW-DEMO FEED CHECKS PASSED");
process.exit(failures ? 1 : 0);
