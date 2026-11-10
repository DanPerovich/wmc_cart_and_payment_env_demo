// Browser test for "New demo" resetting the mock APIs.
// Usage: node ui_reset_smoke.mjs <app-url> <mode> [fake-wmc-url]
//   mode: ok | nocreds | partial
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [appUrl, mode, fakeUrl] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9335;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "uireset-"))}`, "--window-size=1500,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://localhost:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json(); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const until = async (label, pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(pred)) return console.log("ok  ", label); await sleep(150); } throw new Error("timeout: " + label); };
const expect = (label, cond) => { if (!cond) throw new Error("FAILED: " + label); console.log("ok  ", label); };
const txt = (sel) => `((document.querySelector(${JSON.stringify(sel)})||{}).textContent||'')`;
const calls = async () => (await (await fetch(fakeUrl + "/__log")).json());

try {
  if (fakeUrl) await fetch(fakeUrl + "/__clear");
  await sleep(1200);
  await until("products loaded", `document.querySelectorAll('[data-add]').length === 10`);
  await run(`document.querySelector('[data-add="prod-001"]').click()`);
  await until("cart has an item", `${txt("#cartBody")}.includes('Wireless Headphones')`);
  await run(`document.querySelector('#btnNewCart').click()`);
  await until("two carts open", `document.querySelectorAll('.tab').length === 2`);

  await run(`document.getElementById('btnReset').click()`);
  if (mode === "ok") {
    expect("page is locked while the mocks reset", await run(`document.body.classList.contains('busy') && document.getElementById('btnReset').disabled`));
    await run(`document.querySelector('[data-add="prod-002"]').click()`); // must be ignored during the reset
  }
  await until("reset finished (page unlocked)", `!document.body.classList.contains('busy')`);
  expect("back to a single empty cart", await run(`document.querySelectorAll('.tab').length === 1 && ${txt("#cartBody")}.includes('empty')`));
  expect("API calls panel emptied (only reset-time calls, none shown)", await run(`document.querySelectorAll('#log .call').length === 0`));
  const status = await run(txt("#resetStatus"));
  const isBad = await run(`document.getElementById('resetStatus').classList.contains('bad')`);
  console.log("     status line:", JSON.stringify(status));

  if (mode === "ok") {
    expect("status says mock state and request logs were reset", status.includes("Mock state and request logs reset") && !isBad);
    const c = await calls();
    expect("fake WireMock Cloud API got exactly 4 reset calls", c.length === 4);
    expect("all calls were authenticated", c.every((e) => e.authed));
    const seen = c.map((e) => `${e.method} ${e.path.replace("/v1/mock-apis/", "")}`).sort();
    expect("state reset by POST and request log emptied by DELETE, for both mocks",
      JSON.stringify(seen) === JSON.stringify(["DELETE jg92wr/requests", "DELETE oz63vz/requests", "POST jg92wr/scenarios/reset", "POST oz63vz/scenarios/reset"]));
    expect("the shared original cart mock was never touched", !c.some((e) => e.path.includes("y09z4")));
  } else if (mode === "nocreds") {
    expect("status explains the mocks were not reset", status.includes("not reset") && status.includes("WMC_API_KEY") && !status.includes("WMC_USERNAME") && isBad);
  } else if (mode === "partial") {
    expect("status names the mock and what failed", status.includes("Shopping Cart API (demo copy): request log HTTP 500") && isBad);
  }
  expect("page was still reset locally", await run(`document.querySelectorAll('.tab').length === 1`));
  console.log(`RESET UI STEPS PASSED (${mode})`);
} catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
finally { ws.close(); chrome.kill(); }
