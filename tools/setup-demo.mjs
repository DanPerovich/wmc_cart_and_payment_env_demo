#!/usr/bin/env node
// Provision a fresh copy of the demo in WireMock Cloud, point the app at it, and start the app.
//
//   ./demo-setup.sh                       provision + configure + start (Ctrl+C stops the app)
//   ./demo-setup.sh --verify              ...and run the Arazzo journeys against the new mocks first
//   ./demo-setup.sh --no-start            provision + configure only
//   ./demo-setup.sh --teardown            delete the environment + data source created by the last run
//
// What it does (all via the WireMock Cloud REST API, authenticated with WMC_API_KEY):
//   1. creates an environment with two blank mock APIs (payments, shopping-cart) and fresh hostnames
//   2. sets their OpenAPI settings (hard validation, portal on, no auto-generation)
//   3. creates the "Test Cards" CSV data source from .wiremock/payments-api/data-sources/test-cards.csv
//   4. loads each mock's OpenAPI description and stubs from .wiremock/ (the payments stubs are
//      pointed at the new data source; nothing in the repository is modified)
//   5. rewrites PAYMENTS_URL / CART_URL / PAYMENTS_MOCK_API_ID / CART_MOCK_API_ID in app/.env
//      (every other line, including your keys, is left alone)
//   6. starts the app (app/server.js)
//
// Needs Node 18+. WMC_API_KEY comes from the environment or app/.env.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WM = path.join(ROOT, ".wiremock");
const STATE_FILE = path.join(WM, ".demo-environment.json");

// ------------------------------------------------------------------ args
const HELP = `Usage: ./demo-setup.sh [options]
  --name <name>         environment name (default: cart-pay-demo-<random>); also seeds the hostnames
  --verify              run the Arazzo journeys against the new mocks, then reset their state
  --no-start            do not start the app afterwards
  --restart             if the app is already running on the port, stop it first (only if it is our server.js)
  --port <n>            port for the app (default: PORT from app/.env, else 8787)
  --webhook-url <url>   webhook target baked into the payments stubs (default: WEBHOOK_URL, else the WireMock Cloud echo service)
  --env-file <path>     env file to read and update (default: app/.env)
  --keep-previous       proceed even if a previous run's environment is still recorded (it is archived, not deleted)
  --keep-on-failure     do not delete what this run created if a step fails
  --teardown            delete the environment and data source recorded by the last run, then exit
  -h, --help`;

const args = { name: null, verify: false, start: true, restart: false, port: null, webhookUrl: null,
  envFile: path.join(ROOT, "app", ".env"), keepPrevious: false, keepOnFailure: false, teardown: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const val = () => { const v = process.argv[++i]; if (v === undefined || v.startsWith("--")) die(`${a} needs a value`); return v; };
  if (a === "--name") args.name = val();
  else if (a === "--verify") args.verify = true;
  else if (a === "--no-start") args.start = false;
  else if (a === "--restart") args.restart = true;
  else if (a === "--port") args.port = Number(val());
  else if (a === "--webhook-url") args.webhookUrl = val();
  else if (a === "--env-file") args.envFile = path.resolve(val());
  else if (a === "--keep-previous") args.keepPrevious = true;
  else if (a === "--keep-on-failure") args.keepOnFailure = true;
  else if (a === "--teardown") args.teardown = true;
  else if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
  else die(`unknown option ${a}\n\n${HELP}`);
}

// ------------------------------------------------------------------ helpers
function die(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }
const log = (m = "") => console.log(m);
let stepNo = 0;
const step = (m) => log(`\n[${++stepNo}] ${m}`);
const ok = (m) => log(`    ok  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith("#")) continue;
    const q = m[2].match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
    out[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, "");
  }
  return out;
}

// Set KEY=VALUE lines in an env file: replace an existing active line, otherwise append.
// Everything else (comments, other keys, secrets) is preserved byte for byte.
function updateEnvFile(file, updates) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text === "" ? [] : text.split("\n");
  const changed = [];
  const pending = { ...updates };
  const next = lines.map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (m && !line.trim().startsWith("#") && m[2] in pending) {
      const v = pending[m[2]];
      delete pending[m[2]];
      changed.push([m[2], m[4].trim(), v]);
      return `${m[1]}${m[2]}${m[3]}${v}`;
    }
    return line;
  });
  const added = Object.entries(pending);
  if (added.length) {
    while (next.length && next[next.length - 1] === "") next.pop();
    if (next.length) next.push("");
    if (!text.includes("written by tools/setup-demo.mjs")) next.push("# --- written by tools/setup-demo.mjs ---");
    for (const [k, v] of added) { next.push(`${k}=${v}`); changed.push([k, null, v]); }
    next.push("");
  }
  fs.writeFileSync(file, next.join("\n"));
  return changed;
}

const cfgEnv = { ...(fs.existsSync(args.envFile) ? parseEnv(fs.readFileSync(args.envFile, "utf8")) : {}), ...process.env };
const API_KEY = cfgEnv.WMC_API_KEY || "";
const API_BASE = (cfgEnv.WMC_API_BASE || "https://api.wiremock.cloud").replace(/\/+$/, "");

async function api(method, p, body, okStatuses = [200, 201, 202, 204]) {
  const res = await fetch(API_BASE + p, {
    method,
    headers: { Authorization: `Token ${API_KEY}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!okStatuses.includes(res.status)) {
    const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || text.slice(0, 300);
    throw new Error(`${method} ${p} -> HTTP ${res.status}${res.status === 401 ? " (is WMC_API_KEY valid?)" : ""}: ${detail}`);
  }
  return json;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const friendlyUrl = (mockApi) => {
  const d = (mockApi.domainNames || []).find((x) => x.editableSubdomainPart);
  return d ? `https://${d.domainName}` : mockApi.baseUrl;
};

async function waitForEnvironment(id, wantGone = false) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${API_BASE}/v1/environments/${id}`, { headers: { Authorization: `Token ${API_KEY}`, Accept: "application/json" } });
    if (res.status === 404) { if (wantGone) return null; throw new Error(`environment ${id} disappeared`); }
    const env = (await res.json()).environment;
    if (!wantGone && env.status === "READY") return env;
    if (env.status === "FAILED" || env.status === "DELETE_FAILED") throw new Error(`environment ${id} ${env.status}: ${env.statusReason || "no reason given"}`);
    await sleep(1500);
  }
  throw new Error(`timed out waiting for environment ${id}`);
}

async function deleteCreated(state) {
  if (state.environmentId) {
    try { await api("DELETE", `/v1/environments/${state.environmentId}`); await waitForEnvironment(state.environmentId, true); ok(`deleted environment ${state.environmentName} (${state.environmentId}) and its mock APIs`); }
    catch (e) { log(`    !!  could not delete environment ${state.environmentId}: ${e.message}`); }
  }
  if (state.dataSourceId) {
    try { await api("DELETE", `/v1/data-sources/${state.dataSourceId}`); ok(`deleted data source ${state.dataSourceId}`); }
    catch (e) { log(`    !!  could not delete data source ${state.dataSourceId}: ${e.message}`); }
  }
}

// New hostnames take a while to resolve after creation (about a minute or more in practice), so every
// call to a fresh mock has to wait until it answers. Any HTTP status counts as "reachable".
async function waitReachable(label, url, timeoutMs = 300000) {
  const t0 = Date.now();
  let last = "";
  for (let n = 0; Date.now() - t0 < timeoutMs; n++) {
    try { await fetch(`${url}/__reachability_check`); return; }
    catch (e) { last = e.cause?.code || e.message; }
    if (n % 5 === 4) log(`    ... still waiting for ${label} to resolve (${Math.round((Date.now() - t0) / 1000)}s, ${last})`);
    await sleep(3000);
  }
  throw new Error(`${url} did not become reachable within ${Math.round(timeoutMs / 1000)}s (${last}). The mocks exist; re-run later or check your DNS.`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}
function listenerPid(port) {
  const r = spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
}

// ------------------------------------------------------------------ teardown
if (args.teardown) {
  if (!API_KEY) die("WMC_API_KEY is not set (environment or app/.env)");
  if (!fs.existsSync(STATE_FILE)) die(`nothing to tear down: ${path.relative(ROOT, STATE_FILE)} does not exist`);
  const state = readJson(STATE_FILE);
  log(`Tearing down the environment recorded by the last setup run:\n  environment ${state.environmentName} (${state.environmentId})\n  data source ${state.dataSourceId}`);
  await deleteCreated(state);
  fs.rmSync(STATE_FILE);
  log("\nDone. Note: app/.env still points at the deleted mocks; run ./demo-setup.sh again to provision a new set.");
  process.exit(0);
}

// ------------------------------------------------------------------ setup
const created = { environmentId: null, environmentName: null, dataSourceId: null };
async function main() {
  step("Preflight");
  if (!API_KEY) die("WMC_API_KEY is not set. Put it in app/.env (see app/.env.example) or the environment.");
  const files = {
    payOpenApi: path.join(WM, "payments-api", "openapi.yaml"),
    payStubs: path.join(WM, "payments-api", "stub-mappings.json"),
    cartOpenApi: path.join(WM, "shopping-cart-demo", "openapi.yaml"),
    cartStubs: path.join(WM, "shopping-cart-demo", "stub-mappings.json"),
    cards: path.join(WM, "payments-api", "data-sources", "test-cards.csv"),
    arazzo: path.join(WM, "payments-api", "arazzo.yaml"),
  };
  for (const [k, f] of Object.entries(files)) if (!fs.existsSync(f)) die(`missing ${path.relative(ROOT, f)} (${k})`);
  const self = (await api("GET", "/v1/users/self")).user;
  ok(`WireMock Cloud user ${self.username}`);

  if (fs.existsSync(STATE_FILE)) {
    const prev = readJson(STATE_FILE);
    if (!args.keepPrevious) die(`a previous run's environment is still recorded: ${prev.environmentName} (${prev.environmentId}).\n  Delete it first with: ./demo-setup.sh --teardown\n  or keep it and continue with: ./demo-setup.sh --keep-previous`);
    const archive = path.join(WM, `.demo-environment.${prev.environmentId}.json`);
    fs.renameSync(STATE_FILE, archive);
    ok(`previous environment ${prev.environmentId} kept; its record was archived to ${path.relative(ROOT, archive)}`);
  }

  const port = args.port || Number(cfgEnv.PORT) || 8787;
  if (args.start && !(await isPortFree(port))) {
    const pid = listenerPid(port);
    const cmd = pid ? spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout.trim() : "";
    if (args.restart && pid && /server\.js/.test(cmd)) {
      process.kill(Number(pid), "SIGTERM");
      for (let i = 0; i < 20 && !(await isPortFree(port)); i++) await sleep(250);
      if (!(await isPortFree(port))) die(`could not stop the app on port ${port}`);
      ok(`stopped the app that was running on port ${port} (pid ${pid})`);
    } else {
      die(`port ${port} is already in use${cmd ? ` by: ${cmd.slice(0, 80)}` : ""}.\n  Stop it, choose another port with --port, or (if it is this app) pass --restart.`);
    }
  }

  const rand = Math.random().toString(36).slice(2, 6);
  const envName = args.name || `cart-pay-demo-${rand}`;
  const base = slug(envName);
  if (!base) die("--name must contain letters or digits");
  const hostPay = `${base}-payments`.slice(0, 63).replace(/-+$/, "");
  const hostCart = `${base}-cart`.slice(0, 63).replace(/-+$/, "");
  const existing = (await api("GET", "/v1/environments?limit=100")).environments || [];
  if (existing.some((e) => e.name === envName)) die(`an environment named "${envName}" already exists; choose another with --name`);
  ok(`environment name "${envName}", hostnames ${hostPay} / ${hostCart}`);

  step("Creating the environment with two blank mock APIs");
  const createdEnv = (await api("POST", "/v1/environments", {
    environment: {
      name: envName,
      description: "Cart -> pay -> status -> refund demo: Payments Demo API plus a private copy of the Shopping Cart API",
      members: [
        { name: "payments", type: "openapi", hostname: hostPay },
        { name: "shopping-cart", type: "openapi", hostname: hostCart },
      ],
    },
  })).environment;
  created.environmentId = createdEnv.id;
  created.environmentName = envName;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...created, createdAt: new Date().toISOString() }, null, 2) + "\n");
  const env = await waitForEnvironment(createdEnv.id);
  const member = (n) => env.members.find((m) => m.name === n).mockApi;
  const pay = member("payments"), cart = member("shopping-cart");
  const payUrl = friendlyUrl(pay), cartUrl = friendlyUrl(cart);
  ok(`environment ${env.id} READY`);
  ok(`payments      ${pay.id}  ${payUrl}`);
  ok(`shopping-cart ${cart.id}  ${cartUrl}`);

  step("Configuring the mock APIs (OpenAPI settings)");
  for (const m of [pay, cart]) {
    await api("PUT", `/v1/mock-apis/${m.id}/settings/openapi`, {
      openapi: { validationMode: "hard", portalEnabled: true, generateStubsFromOpenApi: false, generateOpenApiFromStubs: false, generateDefaultStubs: false },
    });
  }
  ok("hard validation, portal enabled, auto-generation off");

  step("Creating the Test Cards data source");
  const [header, ...rows] = fs.readFileSync(files.cards, "utf8").trim().split(/\r?\n/).map((l) => l.split(","));
  const ds = (await api("POST", `/v1/users/${self.id}/data-sources`, {
    dataSource: { name: `Test Cards [${envName}]`, type: "CSV", columnsMetadata: header.map((name) => ({ name, type: { name: "STRING" } })), rows },
  })).dataSource;
  created.dataSourceId = ds.id;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...created, createdAt: new Date().toISOString() }, null, 2) + "\n");
  ok(`data source ${ds.id} (${rows.length} cards)`);

  step("Loading OpenAPI descriptions and stubs");
  const withServers = (yaml, url) => yaml.replace(/^servers:\n(?:- url: .*\n)+/m, `servers:\n- url: ${url}\n`);
  const webhookUrl = args.webhookUrl || cfgEnv.WEBHOOK_URL || null;
  const payStubs = readJson(files.payStubs);
  let dsRefs = 0, hookRefs = 0;
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      if (o.name === "data-exists" && o.parameters && o.parameters.id) { o.parameters.id = ds.id; dsRefs++; }
      if (o.name === "webhook" && o.parameters && o.parameters.url && webhookUrl) { o.parameters.url = webhookUrl; hookRefs++; }
      Object.values(o).forEach(walk);
    }
  })(payStubs);
  if (dsRefs === 0) throw new Error("no data-exists matcher found in the payments stubs; cannot point them at the new data source");
  const loads = [
    [pay, "payments", withServers(fs.readFileSync(files.payOpenApi, "utf8"), payUrl), payStubs],
    [cart, "shopping-cart", withServers(fs.readFileSync(files.cartOpenApi, "utf8"), cartUrl), readJson(files.cartStubs)],
  ];
  for (const [m, label, openapi, stubs] of loads) {
    await api("PUT", `/v1/mock-apis/${m.id}/open-api`, { openApi: { doc: openapi } });
    await api("POST", `/v1/mock-apis/${m.id}/mappings/import`, { ...stubs, importOptions: { duplicatePolicy: "OVERWRITE", deleteAllNotInImport: false } });
    ok(`${label}: OpenAPI + ${stubs.mappings.length} stubs`);
  }
  ok(`payments stubs point at data source ${ds.id}${hookRefs ? `, webhook target ${webhookUrl}` : ""}`);

  step("Waiting for the new hostnames to become reachable (DNS for new names takes a minute or two)");
  const tWait = Date.now();
  await waitReachable("the payments mock", payUrl);
  await waitReachable("the shopping-cart mock", cartUrl);
  ok(`both reachable after ${Math.round((Date.now() - tWait) / 1000)}s`);

  step("Smoke test");
  const get = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.text() }; };
  let r = await get(`${cartUrl}/products`);
  if (r.status !== 200) throw new Error(`GET ${cartUrl}/products -> ${r.status}`);
  ok(`cart API serves ${JSON.parse(r.body).length} products`);
  r = await get(`${payUrl}/payments/pay_does_not_exist`);
  if (r.status !== 404) throw new Error(`GET /payments/pay_does_not_exist -> ${r.status}, expected 404`);
  ok("payments API answers 404 for an unknown payment (stubs loaded)");
  r = await get(`${payUrl}/payments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: "smoke", amount: 1, currency: "USD", cardToken: "tok_not_in_the_csv" }) });
  if (r.status !== 422) throw new Error(`POST /payments with an unknown card -> ${r.status}, expected 422`);
  ok("payments API rejects an unknown card token with 422");

  if (args.verify) {
    step("Verifying with the Arazzo journeys (this sends a few webhooks to the webhook target)");
    const run = spawnSync("npx", ["--yes", "@wiremock/arazzo-runner@1.4.0", "run", files.arazzo, "-b", `shopping-cart=${cartUrl}`, "-b", `payments=${payUrl}`,
      "-r", path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "arazzo-")), "report.yaml"), "--no-interactive"], { encoding: "utf8" });
    const lines = (run.stdout || "").split("\n").filter((l) => /^[✓✗]/.test(l));
    lines.forEach((l) => log(`    ${l}`));
    if (!lines.length || lines.some((l) => l.startsWith("✗"))) throw new Error(`Arazzo journeys failed:\n${(run.stdout || "") + (run.stderr || "")}`);
    for (const m of [pay, cart]) {
      await api("POST", `/v1/mock-apis/${m.id}/scenarios/reset`);
      await api("DELETE", `/v1/mock-apis/${m.id}/requests`);
    }
    ok("state and request logs reset, so the demo starts clean");
  }

  step(`Configuring the app (${args.envFile.startsWith(ROOT + path.sep) ? path.relative(ROOT, args.envFile) : args.envFile})`);
  fs.mkdirSync(path.dirname(args.envFile), { recursive: true });
  const updates = { PAYMENTS_URL: payUrl, CART_URL: cartUrl, PAYMENTS_MOCK_API_ID: pay.id, CART_MOCK_API_ID: cart.id };
  if (args.webhookUrl) updates.WEBHOOK_URL = args.webhookUrl;
  for (const [k, from, to] of updateEnvFile(args.envFile, updates)) ok(`${k}: ${from === null ? "(added)" : from || "(empty)"} -> ${to}`);

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    environmentId: env.id, environmentName: envName, dataSourceId: ds.id, paymentsMockApiId: pay.id, cartMockApiId: cart.id,
    paymentsUrl: payUrl, cartUrl, createdAt: new Date().toISOString(),
  }, null, 2) + "\n");
  return { port, payUrl, cartUrl, payId: pay.id, cartId: cart.id, envId: env.id, envName };
}

let result;
try {
  result = await main();
} catch (e) {
  console.error(`\nSETUP FAILED: ${e.message}`);
  if (created.environmentId || created.dataSourceId) {
    if (args.keepOnFailure) log(`\nKept what was created (environment ${created.environmentId}, data source ${created.dataSourceId}). Remove it with: ./demo-setup.sh --teardown`);
    else { log("\nCleaning up what this run created:"); await deleteCreated(created); try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ } }
  }
  process.exit(1);
}

log(`\nEnvironment "${result.envName}" (${result.envId}) is ready:\n  payments       ${result.payUrl}\n  shopping-cart  ${result.cartUrl}\n  remove later:  ./demo-setup.sh --teardown`);

if (!args.start) {
  log(`\nNot starting the app (--no-start). Start it with: cd app && node server.js`);
  process.exit(0);
}
step(`Starting the app on port ${result.port}`);
const child = spawn(process.execPath, [path.join(ROOT, "app", "server.js")], {
  cwd: path.join(ROOT, "app"), stdio: "inherit",
  env: {
    ...process.env,
    // values from a custom --env-file (the app only reads app/.env on its own)
    ...Object.fromEntries(["WMC_API_KEY", "WEBHOOK_API_KEY", "WEBHOOK_URL", "WEBHOOK_TOKEN"].filter((k) => cfgEnv[k]).map((k) => [k, cfgEnv[k]])),
    ...(args.webhookUrl ? { WEBHOOK_URL: args.webhookUrl } : {}),
    PORT: String(result.port),
    PAYMENTS_URL: result.payUrl, CART_URL: result.cartUrl,
    PAYMENTS_MOCK_API_ID: result.payId, CART_MOCK_API_ID: result.cartId,
  },
});
log(`    Open http://localhost:${result.port}   (Ctrl+C to stop)\n`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
