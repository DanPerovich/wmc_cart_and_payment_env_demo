// Browser test for the two ways of clearing the webhook feed, against a fake webhook.site.
// Usage: node ui_clear_smoke.mjs <app-url> <fake-url>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [appUrl, fakeUrl] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9334;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "uiclear-"))}`, "--window-size=1500,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://localhost:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json(); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const until = async (label, pred, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(pred)) return console.log("ok  ", label); await sleep(250); } throw new Error("timeout: " + label); };
const evCount = `document.querySelectorAll('#events .ev').length`;
const deletes = async () => (await (await fetch(fakeUrl + "/__log")).json()).filter((e) => e.method === "DELETE").length;
const expect = (label, cond) => { if (!cond) throw new Error("FAILED: " + label); console.log("ok  ", label); };

try {
  await fetch(fakeUrl + "/__seed");   // also empties the fake's call log
  await sleep(1500);
  await until("both seeded events are shown", `${evCount} === 2`);
  await run(`window.alertMsg = null; window.alert = (m) => { window.alertMsg = m; }`);
  const feedEvents = async () => (await (await fetch(appUrl + "api/webhooks")).json()).events.length;

  // 1) New demo is a full reset: it also deletes the webhook.site log (one authenticated DELETE)
  const sync = await run(`(() => { document.getElementById('btnReset').click(); return ${evCount}; })()`);
  expect("the panel is empty in the same tick as the click", sync === 0);
  for (let i = 0; i < 20 && (await deletes()) === 0; i++) await sleep(250);
  expect("New demo deleted the webhook.site log: exactly one DELETE", (await deletes()) === 1);
  await until("New demo finished", `!document.body.classList.contains('busy')`);
  expect("status line reports the webhook.site log was cleared", (await run(`document.getElementById('resetStatus').textContent`)).includes("webhook.site log cleared"));
  expect("nothing is left upstream", (await feedEvents()) === 0);
  await cdp("Page.reload"); await sleep(1500);
  await until("still empty after reload", `${evCount} === 0`);
  expect("the local hidden list was reset (it is meaningless once the log is gone)", await run(`JSON.parse(localStorage.getItem('paymentsDemo.clearedEvents') || '[]').length === 0`));
  await fetch(fakeUrl + "/__seed");
  await until("events that arrive afterwards show normally", `${evCount} === 2`);

  // 2) the separate Clear button: cancelling the confirm does nothing
  await run(`window.alertMsg = null; window.alert = (m) => { window.alertMsg = m; }`); // reload dropped the override
  await run(`window.confirm = () => false; document.getElementById('btnClearHooks').click()`);
  await sleep(800);
  expect("cancelled confirm sent no DELETE", (await deletes()) === 0);

  // 3) confirming deletes upstream and resets the local hidden list
  await run(`window.confirm = (m) => { window.confirmMsg = m; return true; }; document.getElementById('btnClearHooks').click()`);
  for (let i = 0; i < 20 && (await deletes()) === 0; i++) await sleep(250);
  expect("exactly one DELETE reached webhook.site", (await deletes()) === 1);
  expect("confirm text warns it is permanent", (await run(`window.confirmMsg`)).includes("Permanently delete ALL"));
  await until("the list is empty", `${evCount} === 0`);
  expect("no error alert was shown", (await run(`window.alertMsg`)) === null);

  // 4) a New demo whose webhook.site deletion fails: reported, events stay hidden, the page still resets
  await fetch(fakeUrl + "/__seed");
  await until("events are shown again", `${evCount} === 2`);
  await fetch(fakeUrl + "/__fail?on=1");
  await run(`document.getElementById('btnReset').click()`);
  await until("New demo finished", `!document.body.classList.contains('busy')`, 15000);
  const st = await run(`({ text: document.getElementById('resetStatus').textContent, bad: document.getElementById('resetStatus').classList.contains('bad'), tabs: document.querySelectorAll('.tab').length })`);
  expect("a failed deletion is reported in the status line", /webhook\.site log not cleared/.test(st.text) && st.bad);
  expect("the page was still reset", st.tabs === 1);
  await sleep(4000);
  expect("the events stay hidden even though upstream still has them", (await run(evCount)) === 0 && (await feedEvents()) === 2);
  await fetch(fakeUrl + "/__fail?on=0");
  console.log("ALL CLEAR-LOG UI STEPS PASSED");
} catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
finally { ws.close(); chrome.kill(); }
