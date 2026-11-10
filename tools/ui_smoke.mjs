// Drives the demo web app in headless Chrome over CDP and clicks through the whole journey.
// Usage: node ui_smoke.mjs <app-url> <screenshot.png>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [appUrl, shot] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "uismoke-"))}`,
  "--window-size=1500,1250", "--no-first-run", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const r = await fetch(`http://localhost:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
    target = await r.json();
  } catch { await sleep(250); }
}
if (!target) { chrome.kill(); throw new Error("chrome did not start"); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result.result.value;
};
// wait until a JS predicate becomes truthy
const until = async (label, pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await run(pred)) return console.log("ok  ", label); await sleep(300); }
  throw new Error("timeout waiting for: " + label);
};
const text = (sel) => `((document.querySelector(${JSON.stringify(sel)})||{}).textContent||'')`;
// SKIP_WEBHOOKS=1 skips checks that need webhook.site to accept deliveries (e.g. when its quota is exhausted)
const hookUntil = (label, pred, ms) => process.env.SKIP_WEBHOOKS ? console.log("skip", label) : until(label, pred, ms);
const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);

try {
  await sleep(1500);
  await until("products loaded", `document.querySelectorAll('[data-add]').length === 10`);
  await hookUntil("existing webhook events are shown on load (nothing cleared yet)", `document.querySelectorAll('#events .ev').length > 0`, 20000);
  const eventsOnLoad = await run(`document.querySelectorAll('#events .ev').length`);
  await click('[data-add="prod-001"]');
  await until("headphones in cart", `${text("#cartBody")}.includes('Wireless Headphones')`);
  await click('[data-add="prod-001"]');
  await until("quantity 2 / total 159.98", `${text("#cartBody")}.includes('159.98 USD')`);
  await click("#btnCheckout");
  await until("checked out, pay unlocked", `!document.getElementById('paySec').classList.contains('locked') && ${text("#payAmount")}.includes('159.98')`);
  await click("#btnPay");
  await until("payment succeeded", `${text("#statusBody")}.includes('succeeded')`);
  await hookUntil("webhook payment.succeeded shown", `${text("#events")}.includes('payment.succeeded')`, 20000);
  await run(`document.getElementById('refundAmt').value='50.00'`);
  await click("#btnRefund");
  await until("partially_refunded", `${text("#statusBody")}.includes('partially_refunded') && ${text("#statusBody")}.includes('50.00 USD')`);
  await click("#btnOver");
  await until("over-refund failed note", `${text("#refundNote")}.includes('amount_exceeds_refundable')`);
  await click("#btnRefundAll");
  await until("fully refunded", `${text("#statusBody")}.includes('refunded') && ${text("#statusBody")}.includes('159.98 USD')`);
  await until("refund list has 3 rows", `document.querySelectorAll('#refundList .row').length === 3`);
  // this run fires 4 webhooks: payment.succeeded + refund.succeeded + refund.failed + refund.succeeded
  await hookUntil("all 4 webhooks of this journey arrived (nothing hidden)", `document.querySelectorAll('#events .ev').length >= ${eventsOnLoad} + 4`, 25000);
  // declined path via New demo
  const before = await run(`document.querySelectorAll('#events .ev').length`);
  await click("#btnReset");
  await until("New demo finished resetting", `!document.body.classList.contains('busy')`);
  await hookUntil("New demo clears the webhook feed", `document.querySelectorAll('#events .ev').length === 0`);
  console.log(`     (${before} events were visible before New demo)`);
  await click('[data-add="prod-004"]');
  await until("yoga mat in cart", `${text("#cartBody")}.includes('Yoga Mat')`);
  await click("#btnCheckout");
  await until("pay unlocked", `!document.getElementById('paySec').classList.contains('locked')`);
  await run(`(()=>{const s=document.getElementById('card');s.value='tok_insufficient_funds';})()`);
  await click("#btnPay");
  await until("declined", `${text("#payNote")}.includes('Insufficient funds')`);
  await click("#btnRefundAll");
  await until("409 refund note", `${text("#refundNote")}.includes('payment_not_refundable')`);
  await hookUntil("payment.failed webhook", `${text("#events")}.includes('payment.failed')`, 20000);
  // expand a logged API call and check the full request and response are visible
  await run(`[...document.querySelectorAll('.call-head')].find(h => h.querySelector('.m').textContent==='POST' && h.querySelector('.p').textContent==='/payments').click()`);
  await until("call detail shows request body + response", `(() => { const b=[...document.querySelectorAll('.call.open .call-body')][0]; return b && !b.hidden && b.textContent.includes('tok_insufficient_funds') && b.textContent.includes('"responseCode": "51"') && b.textContent.includes('HTTP 201'); })()`);
  // reload: cleared events stay hidden, this session's event stays visible
  await cdp("Page.reload");
  await sleep(1500);
  await hookUntil("after reload only post-New-demo events show", `document.querySelectorAll('#events .ev').length === 1 && ${text("#events")}.includes('payment.failed') && !${text("#events")}.includes('refund.')`, 20000);
  // ---- multiple active carts (fresh page after the reload above)
  const tabText = (n) => text(`[data-cart="${n}"]`);
  const body = () => text("#cartBody");
  await until("products loaded again", `document.querySelectorAll('[data-add]').length === 10`);
  await click('[data-add="prod-001"]');
  await until("cart 1 has headphones", `${body()}.includes('Wireless Headphones')`);
  await click("#btnNewCart");
  await until("cart 2 is active and empty", `document.querySelectorAll('.tab').length === 2 && document.querySelector('.tab.active').dataset.cart === '2' && ${body()}.includes('empty')`);
  await click('[data-add="prod-004"]');
  await until("cart 2 has yoga mat only", `${body()}.includes('Yoga Mat') && !${body()}.includes('Wireless')`);
  // race: an add that finishes after switching tabs must land in cart 2, not the cart on screen
  await run(`document.querySelector('[data-add="prod-005"]').click(); document.querySelector('[data-cart="1"]').click();`);
  await sleep(2500);
  await until("cart 1 unaffected by cart 2's late add", `${body()}.includes('Wireless Headphones') && !${body()}.includes('Desk Lamp') && !${body()}.includes('Yoga')`);
  await click('[data-cart="2"]');
  await until("cart 2 got the late add", `${body()}.includes('Desk Lamp') && ${body()}.includes('Yoga Mat') && ${body()}.includes('61.98')`);
  // cart 1: checkout and pay with an approved card
  await click('[data-cart="1"]');
  await click("#btnCheckout");
  await until("cart 1 checked out with its own total", `${text("#payAmount")}.includes('79.99')`);
  await click("#btnPay");
  await until("cart 1 paid", `${text("#statusBody")}.includes('succeeded')`);
  const pay1 = await run(`document.querySelector('#statusBody code').textContent`);
  // cart 2 must not inherit cart 1's order or payment
  await click('[data-cart="2"]');
  await until("cart 2 shows no payment and pay locked", `${text("#statusBody")}.includes('No payment yet') && document.getElementById('paySec').classList.contains('locked')`);
  await until("tab 1 shows paid", `${tabText(1)}.includes('paid')`);
  await click("#btnCheckout");
  await until("cart 2 checked out with its own total", `${text("#payAmount")}.includes('61.98')`);
  await run(`(()=>{const s=document.getElementById('card');s.value='tok_do_not_honor';s.dispatchEvent(new Event('change'));})()`);
  await click("#btnPay");
  await until("cart 2 declined", `${text("#payNote")}.includes('Do not honor')`);
  // back on cart 1: still its own succeeded payment, approved card remembered, refund area works
  await click('[data-cart="1"]');
  await until("cart 1 still paid with the same payment id", `${text("#statusBody")}.includes('succeeded') && document.querySelector('#statusBody code').textContent === ${JSON.stringify(pay1)}`);
  await until("tab 2 shows declined", `${tabText(2)}.includes('declined')`);
  await click("#btnRefundAll");
  await until("cart 1 fully refunded; cart 2 untouched", `${text("#statusBody")}.includes('refunded') && ${text("#refundList")}.includes('succeeded')`);
  await click('[data-cart="2"]');
  await until("cart 2 still declined, no refunds", `${text("#statusBody")}.includes('failed') && document.querySelectorAll('#refundList .row').length === 0`);
  { const s2 = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(shot.replace(".png", "-carts.png"), Buffer.from(s2.result.data, "base64")); }
  // New demo collapses back to one fresh cart
  await click("#btnReset");
  await until("New demo finished resetting", `!document.body.classList.contains('busy')`);
  await until("New demo resets to a single empty cart", `document.querySelectorAll('.tab').length === 1 && ${body()}.includes('empty')`);
  const shotData = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(shot, Buffer.from(shotData.result.data, "base64"));
  console.log("ALL UI STEPS PASSED; screenshot:", shot);
} catch (e) {
  console.error("FAILED:", e.message);
  try { const s = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(shot, Buffer.from(s.result.data, "base64")); } catch {}
  process.exitCode = 1;
} finally { ws.close(); chrome.kill(); }
