"use strict";

// Test cards mirror the "Test Cards" CSV data source behind the Payments API.
const CARDS = [
  ["tok_visa_approved", "Visa - approved"],
  ["tok_mastercard_approved", "Mastercard - approved"],
  ["tok_verve_approved", "Verve - approved"],
  ["tok_insufficient_funds", "Declined - insufficient funds (51)"],
  ["tok_do_not_honor", "Declined - do not honor (05)"],
  ["tok_expired_card", "Declined - expired card (54)"],
  ["tok_suspected_fraud", "Declined - suspected fraud (59)"],
];

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (minor, cur = "USD") => `${(minor / 100).toFixed(2)} ${cur}`;
const toMinor = (major) => Math.round(Number(major) * 100);

let cfg;
let products = [];
// Several shopping carts can be active at once; `session` is the one on screen.
const MAX_CARTS = 6;
let carts = [];
let session;
let resetting = false; // true while "New demo" is resetting the mock APIs
let nextCartNo = 1;
// Webhook events are only hidden when "New demo" is clicked. The hidden ids are kept in
// localStorage so a page reload does not bring cleared events back (or clear visible ones).
const CLEARED_KEY = "paymentsDemo.clearedEvents";
const cleared = new Set(JSON.parse(localStorage.getItem(CLEARED_KEY) || "[]"));
const shown = new Set();
// Payments made in sessions that "New demo" has since closed. A webhook for one of them can be delivered
// a moment after the click, so events are hidden by payment as well as by event id.
const CLEARED_PAY_KEY = "paymentsDemo.clearedPayments";
const clearedPayments = new Set(JSON.parse(localStorage.getItem(CLEARED_PAY_KEY) || "[]"));
let latestEvents = [];
let firstFeed = true;

function freshSession() {
  const n = nextCartNo++;
  return {
    no: n, label: `Cart ${n}`, cartId: null, items: [], checkedOut: false, orderId: null, amount: 0,
    currency: "USD", payment: null, refunds: [], notes: { order: "", pay: "", refund: "" },
    card: CARDS[0][0], refundAmt: "",
  };
}

// ---------------------------------------------------------------- HTTP
async function api(base, label, method, path, body) {
  const t0 = performance.now();
  const reqHeaders = body ? { "Content-Type": "application/json" } : {};
  const call = { label, method, path, url: base + path, reqHeaders, reqBody: body ? JSON.stringify(body) : null, when: new Date() };
  let data = null;
  try {
    const res = await fetch(call.url, { method, headers: body ? reqHeaders : undefined, body: call.reqBody });
    call.status = res.status;
    call.statusText = res.statusText;
    call.resHeaders = Object.fromEntries(res.headers.entries());
    call.resBody = await res.text();
    data = call.resBody ? JSON.parse(call.resBody) : null;
  } catch (e) {
    call.status = call.status || 0;
    call.error = String(e.message || e);
    data = { error: "network_error", message: call.error };
  }
  call.ms = Math.round(performance.now() - t0);
  logCall(call);
  return { status: call.status, data };
}
const cartApi = (c, m, p, b) => api(cfg.cartUrl, c && c.label, m, p, b);
const payApi = (c, m, p, b) => api(cfg.paymentsUrl, c && c.label, m, p, b);

const pretty = (text) => {
  if (!text) return "(empty)";
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
};
const headerLines = (h) => {
  const lines = Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join("\n") : "(none visible to the browser)";
};

// One row per API call; click it to see the full request and response.
function logCall(c) {
  const cls = c.status >= 500 || c.status === 0 ? "st5" : c.status >= 400 ? "st4" : "st2";
  const el = document.createElement("div");
  el.className = "call";
  el.innerHTML = `<div class="call-head" title="Click to see the full request and response">
      ${c.label ? `<span class="chip">${esc(c.label.replace("Cart ", "C"))}</span>` : "<span></span>"}<span class="m">${esc(c.method)}</span><span class="p">${esc(c.path)}</span>
      <span class="${cls}">${c.status || "ERR"}</span><span class="muted">${c.ms}ms</span></div>
    <div class="call-body" hidden>
      <div class="lbl">Request</div>
      <pre>${esc(`${c.method} ${c.url}\n${headerLines(c.reqHeaders)}\n\n${c.reqBody ? pretty(c.reqBody) : "(no body)"}`)}</pre>
      <div class="lbl">Response</div>
      <pre>${esc(c.error
        ? `Network error: ${c.error}`
        : `HTTP ${c.status} ${c.statusText || ""}\n${headerLines(c.resHeaders)}\n\n${pretty(c.resBody)}`)}</pre>
      <div class="muted">${c.when.toLocaleTimeString()} &middot; ${c.ms}ms</div>
    </div>`;
  const head = el.querySelector(".call-head");
  const body = el.querySelector(".call-body");
  head.onclick = () => {
    body.hidden = !body.hidden;
    el.classList.toggle("open", !body.hidden);
  };
  $("log").prepend(el);
}

// Notes belong to a cart: store them on it, then redraw if that cart is the one on screen.
function setNote(c, key, kind, html) {
  c.notes[key] = html ? `<div class="note b-${kind}">${html}</div>` : "";
  if (c === session) render();
}
const badge = (text, kind) => `<span class="badge b-${kind}">${esc(text)}</span>`;
const statusKind = (s) => ({ succeeded: "ok", refunded: "info", partially_refunded: "warn", failed: "bad" }[s] || "info");

// ---------------------------------------------------------------- shop & cart
async function loadProducts() {
  const r = await cartApi(null, "GET", "/products");
  if (r.status !== 200) {
    $("products").textContent = "Could not load products from the Shopping Cart API.";
    return;
  }
  products = r.data;
  render();
}

// Cart mutations run one at a time so rapid clicks cannot create two carts or lose an item.
let cartQueue = Promise.resolve();
const queued = (fn) => (cartQueue = cartQueue.then(fn, fn));
const addToCart = (productId) => { if (resetting) return; const c = session; return queued(() => addToCartNow(c, productId)); };
const removeItem = (itemId) => { if (resetting) return; const c = session; return queued(() => removeItemNow(c, itemId)); };

async function addToCartNow(c, productId) {
  const p = products.find((x) => x.id === productId);
  if (c.checkedOut) return;
  if (!c.cartId) {
    const r = await cartApi(c, "POST", "/carts", { customerId: `cust-${String(c.no).padStart(3, "0")}` });
    if (r.status !== 201) return setNote(c, "order", "bad", "Could not create cart");
    c.cartId = r.data.id;
  }
  const existing = c.items.find((i) => i.productId === productId);
  if (existing) {
    await cartApi(c, "PUT", `/carts/${c.cartId}/items/${existing.id}`, { quantity: existing.quantity + 1 });
  } else {
    await cartApi(c, "POST", `/carts/${c.cartId}/items`, { productId, quantity: 1, unitPrice: p.price });
  }
  await refreshCart(c);
}

async function removeItemNow(c, itemId) {
  await cartApi(c, "DELETE", `/carts/${c.cartId}/items/${itemId}`);
  await refreshCart(c);
}

async function refreshCart(c) {
  const r = await cartApi(c, "GET", `/carts/${c.cartId}/items`);
  c.items = r.status === 200 ? r.data : [];
  if (c === session) render();
}

const cartTotal = (c) => c.items.reduce((sum, i) => sum + toMinor(i.totalPrice), 0);

async function checkout() {
  const c = session;
  if (resetting || !c.cartId || c.checkedOut) return;
  c.checking = true;
  render();
  const r = await cartApi(c, "POST", `/carts/${c.cartId}/checkout`);
  c.checking = false;
  if (r.status !== 200) return setNote(c, "order", "bad", "Checkout failed");
  c.checkedOut = true;
  c.orderId = r.data.orderId;
  // The cart API returns the order total (major units); the Payments API wants minor units.
  c.currency = r.data.currency;
  c.amount = toMinor(r.data.total);
  c.notes.order = `<span>${badge(r.data.status, "ok")} order <code>${esc(r.data.orderId.slice(0, 8))}&hellip;</code> total <strong>${money(c.amount, c.currency)}</strong></span>`;
  if (c === session) render();
}

// ---------------------------------------------------------------- pay
async function doPay() {
  const c = session;
  if (resetting) return;
  c.paying = true;
  c.card = $("card").value;
  render();
  const r = await payApi(c, "POST", "/payments", {
    orderId: c.orderId,
    amount: c.amount,
    currency: c.currency,
    cardToken: c.card,
  });
  c.paying = false;
  if (r.status !== 201) {
    return setNote(c, "pay", "bad", `${esc(r.data?.error || "error")}: ${esc(r.data?.message || r.status)}`);
  }
  c.payment = r.data;
  c.refunds = [];
  const ok = r.data.status === "succeeded";
  c.refundAmt = ok ? (c.payment.amount / 200).toFixed(2) : "";
  setNote(c, "pay", ok ? "ok" : "bad",
    `${badge(r.data.status, ok ? "ok" : "bad")} code ${esc(r.data.responseCode)}: ${esc(r.data.responseMessage)}`);
}

// ---------------------------------------------------------------- status
async function refreshStatus() {
  const c = session;
  if (!c.payment) return;
  const r = await payApi(c, "GET", `/payments/${c.payment.id}`);
  if (r.status === 200) {
    c.payment = r.data;
    if (c === session) render();
  }
}

// ---------------------------------------------------------------- refund
async function doRefund(c, amountMinor) {
  if (resetting || !c.payment) return;
  if (!(amountMinor > 0)) return setNote(c, "refund", "warn", "Enter an amount greater than zero.");
  const r = await payApi(c, "POST", `/payments/${c.payment.id}/refunds`, { amount: amountMinor, reason: "requested_by_customer" });
  if (r.status === 201) {
    const ok = r.data.status === "succeeded";
    c.notes.refund = `<div class="note b-${ok ? "ok" : "bad"}">${
      ok ? `${badge("succeeded", "ok")} refunded ${money(r.data.amount, c.currency)}`
         : `${badge("failed", "bad")} ${money(r.data.amount, c.currency)}: ${esc(r.data.failureReason)}`}</div>`;
  } else {
    c.notes.refund = `<div class="note b-bad">${r.status} ${esc(r.data?.error)}: ${esc(r.data?.message)}</div>`;
  }
  const st = await payApi(c, "GET", `/payments/${c.payment.id}`);
  if (st.status === 200) c.payment = st.data;
  const rl = await payApi(c, "GET", `/payments/${c.payment.id}/refunds`);
  c.refunds = rl.status === 200 ? rl.data : [];
  if (c.payment.status !== "failed") c.refundAmt = ((c.payment.amount - c.payment.amountRefunded) / 100).toFixed(2);
  if (c === session) render();
}
const refundRemaining = (p) => (p.status === "failed" ? p.amount : p.amount - p.amountRefunded);

// ---------------------------------------------------------------- render (draws the active cart)
function render() {
  const c = session;
  const cur = c.currency;

  // products: "Add" is disabled once this cart has been checked out
  if (!cfg.configured) {
    $("products").className = "muted";
    $("products").textContent = "Not available until the demo mocks are configured (see the notice above).";
  } else {
    $("products").className = "";
    $("products").innerHTML = products
      .map((p) => `<div class="row"><div><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.category)} &middot; ${p.price.toFixed(2)} USD</span></div>
        <button data-add="${esc(p.id)}" ${c.checkedOut ? "disabled" : ""}>Add</button></div>`)
      .join("");
  }
  document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => addToCart(b.dataset.add)));

  // cart
  if (!c.items.length) {
    $("cartBody").className = "muted";
    $("cartBody").textContent = "This cart is empty.";
  } else {
    const name = (id) => (products.find((p) => p.id === id) || {}).name || id;
    $("cartBody").className = "";
    $("cartBody").innerHTML =
      c.items
        .map((i) => `<div class="row"><div>${esc(name(i.productId))} <span class="muted">&times; ${i.quantity}</span></div>
          <div>${i.totalPrice.toFixed(2)} ${c.checkedOut ? "" : `<button data-rm="${esc(i.id)}" title="Remove">&times;</button>`}</div></div>`)
        .join("") +
      `<div class="row"><strong>Total</strong><strong>${money(cartTotal(c), cur)}</strong></div>`;
    document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => removeItem(b.dataset.rm)));
  }
  $("btnCheckout").disabled = !c.items.length || c.checkedOut || !!c.checking;
  $("orderInfo").innerHTML = c.notes.order || "";

  // pay
  $("paySec").classList.toggle("locked", !c.checkedOut);
  $("payOrder").textContent = c.orderId || "-";
  $("payAmount").textContent = c.checkedOut ? money(c.amount, cur) : "-";
  $("card").value = c.card;
  const paid = c.payment && c.payment.status !== "failed";
  $("btnPay").disabled = !!paid || !!c.paying; // avoid double-charging; a declined card can be retried
  $("payNote").innerHTML = c.notes.pay;

  // status
  $("statusSec").classList.toggle("locked", !c.payment);
  const p = c.payment;
  if (!p) {
    $("statusBody").className = "muted";
    $("statusBody").textContent = "No payment yet.";
  } else {
    $("statusBody").className = "";
    $("statusBody").innerHTML = `<div class="kv">
      <div>Payment</div><div><code>${esc(p.id)}</code></div>
      <div>Status</div><div>${badge(p.status, statusKind(p.status))}</div>
      <div>Amount</div><div>${money(p.amount, cur)}</div>
      <div>Refunded</div><div>${money(p.amountRefunded, cur)}</div>
      <div>Refundable</div><div>${money(p.status === "failed" ? 0 : p.amount - p.amountRefunded, cur)}</div>
      <div>Response</div><div>${esc(p.responseCode)} - ${esc(p.responseMessage)}</div></div>`;
  }

  // refund
  $("refundSec").classList.toggle("locked", !c.payment);
  $("refundAmt").value = c.refundAmt;
  $("refundNote").innerHTML = c.notes.refund;
  $("refundList").innerHTML = c.refunds.length
    ? `<div class="muted">Refunds on this payment</div>` +
      c.refunds
        .map((f) => `<div class="row"><div><code>${esc(f.id)}</code></div>
          <div>${money(f.amount, cur)} ${badge(f.status, f.status === "succeeded" ? "ok" : "bad")}</div></div>`)
        .join("")
    : "";

  renderTabs();
}

// ---------------------------------------------------------------- cart tabs
function cartStage(c) {
  if (c.payment) {
    return c.payment.status === "failed" ? ["declined", "bad"]
      : c.payment.status === "succeeded" ? ["paid", "ok"]
      : [c.payment.status.replace("_", " "), c.payment.status === "refunded" ? "info" : "warn"];
  }
  if (c.checkedOut) return ["ordered", "info"];
  return c.items.length ? [`${c.items.reduce((n, i) => n + i.quantity, 0)} item(s)`, "warn"] : ["empty", "info"];
}

function renderTabs() {
  $("tabs").innerHTML =
    `<span class="muted" style="margin-right:4px">Active carts</span>` +
    carts
      .map((c) => {
        const [stage, kind] = cartStage(c);
        return `<button class="tab ${c === session ? "active" : ""}" data-cart="${c.no}">${esc(c.label)} ${badge(stage, kind)}</button>`;
      })
      .join("") +
    `<button id="btnNewCart" ${carts.length >= MAX_CARTS ? "disabled" : ""} title="Start another shopping cart">+ New cart</button>`;
  document.querySelectorAll("[data-cart]").forEach((b) => (b.onclick = () => switchCart(Number(b.dataset.cart))));
  $("btnNewCart").onclick = newCart;
}

// Save what's typed into the visible form, then show another cart.
function saveInputs() {
  session.card = $("card").value;
  session.refundAmt = $("refundAmt").value;
}
function switchCart(no) {
  const target = carts.find((c) => c.no === no);
  if (!target || target === session) return;
  saveInputs();
  session = target;
  render();
}
function newCart() {
  if (carts.length >= MAX_CARTS) return;
  saveInputs();
  session = freshSession();
  carts.push(session);
  render();
}

// ---------------------------------------------------------------- webhook feed
function eventKind(type) {
  return type.endsWith(".succeeded") ? "ok" : "bad";
}

function eventHtml(e, isNew) {
  const d = e.payload.data || {};
  const pid = d.paymentId || d.id;
  const current = carts.some((c) => c.payment && c.payment.id === pid);
  const time = new Date(e.createdAt.replace(" ", "T") + "Z");
  const summary = `${esc(d.id)} &middot; ${money(d.amount)} &middot; ${esc(d.status)}${d.failureReason ? " (" + esc(d.failureReason) + ")" : ""}`;
  return `<div class="ev ${current ? "current" : ""} ${isNew ? "new" : ""}">
    ${badge(e.payload.type, eventKind(e.payload.type))} <span class="muted">${isNaN(time) ? "" : time.toLocaleTimeString()}</span>
    <div>${summary}</div>
    <details><summary class="muted">payload</summary><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></details></div>`;
}

function feedState(state) {
  $("feedDot").className = "dot" + (state === "ok" ? "" : state === "rate-limited" || state === "needs-api-key" ? " warn" : " off");
  $("feedStatus").textContent =
    state === "rate-limited" ? "webhook.site is rate limiting, retrying..."
    : state === "needs-api-key" ? "webhook.site rejected the API key: check WEBHOOK_API_KEY"
    : state === "down" ? "feed unavailable, retrying..."
    : "";
}

// When the webhook target can't be read back (the echo service stores nothing; webhook.site needs an
// API key to list), say so plainly instead of showing an empty list.
function showReceiverNote() {
  const mode = cfg.webhookMode;
  const link = cfg.webhookViewUrl ? `<p><a href="${esc(cfg.webhookViewUrl)}" target="_blank" rel="noopener">${mode === "echo" ? "Open the Payments mock's request log" : "Open the webhook.site page"} &#8599;</a></p>` : "";
  const text = {
    echo: `<p>Webhooks are delivered to the <strong>WireMock Cloud echo service</strong>. It replies with a copy of each request and stores nothing, so they cannot be listed here.</p>
      <p>In WireMock Cloud, the Payments mock's request log shows each webhook and the echoed response under the request that triggered it.</p>${link}
      <p class="muted">To list events in this panel instead, set <code>WEBHOOK_URL</code> to a webhook.site address and <code>WEBHOOK_API_KEY</code> in <code>app/.env</code> (reading a webhook.site log needs its API key, a paid-account feature).</p>`,
    "site-no-key": `<p>Webhooks are delivered to <strong>webhook.site</strong>, but listing them here needs a webhook.site API key (a paid-account feature).</p>${link}
      <p class="muted">Set <code>WEBHOOK_API_KEY</code> in <code>app/.env</code> to show them here, or leave the default echo service (remove <code>WEBHOOK_URL</code>).</p>`,
    other: `<p>Webhooks are delivered to <strong>${esc(cfg.webhookHost)}</strong>. This app cannot read events back from that receiver; check it directly.</p>`,
  }[mode];
  $("events").innerHTML = `<div class="receiver-note">${text}</div>`;
  $("feedDot").className = "dot idle";
  $("feedStatus").textContent = "";
}

// The payment an event belongs to: the payment itself for payment.*, `paymentId` for refund.*.
const eventPaymentId = (e) => { const d = (e.payload && e.payload.data) || {}; return d.paymentId || d.id; };
const isHidden = (e) => cleared.has(e.uuid) || clearedPayments.has(eventPaymentId(e));

function renderEvents(newOnes = new Set()) {
  const visible = latestEvents.filter((e) => e.payload && e.payload.type && !isHidden(e));
  $("events").innerHTML = visible.length
    ? visible.map((e) => eventHtml(e, newOnes.has(e.uuid))).join("")
    : `<div class="muted">No events yet. Pay or refund to trigger one.</div>`;
  return visible;
}

async function pollFeed() {
  if (cfg.webhookMode !== "site") return; // nothing to read back (see showReceiverNote)
  let feed;
  try {
    const res = await fetch("/api/webhooks");
    if (!res.ok) throw new Error(res.status);
    feed = await res.json();
  } catch (_) {
    return feedState("down");
  }
  feedState(feed.status);
  latestEvents = feed.events;
  const fresh = latestEvents.filter((e) => e.payload && e.payload.type && !isHidden(e));
  // Flash only events that arrive while the page is open, not the ones already there on load.
  const newOnes = firstFeed ? new Set() : new Set(fresh.filter((e) => !shown.has(e.uuid)).map((e) => e.uuid));
  fresh.forEach((e) => shown.add(e.uuid));
  if (feed.status === "ok") firstFeed = false;
  renderEvents(newOnes);
}

// ---------------------------------------------------------------- clear the webhook.site log
// Unlike "New demo" (which only hides events in this browser), this deletes every request stored
// on the webhook.site URL, for everyone. Needs WEBHOOK_API_KEY on the server.
// Ask the server to delete every request stored on the webhook.site URL. Resolves to null on success,
// otherwise to a short error text. Used by the "Clear webhook.site log" button and by "New demo".
async function clearWebhookSiteLog() {
  try {
    const res = await fetch("/api/webhooks/clear", { method: "POST", headers: { "X-Requested-With": "payments-demo" } });
    const body = await res.json().catch(() => ({}));
    return res.ok ? null : String(body.error || res.status);
  } catch (e) {
    return e.message;
  }
}

// Hide the events currently on screen (by event id), right away.
function hideShownEvents() {
  latestEvents.forEach((e) => cleared.add(e.uuid));
  shown.forEach((u) => cleared.add(u));
  localStorage.setItem(CLEARED_KEY, JSON.stringify([...cleared].slice(-500)));
  if (cfg.webhookMode === "site") renderEvents();
}

// After the webhook.site log has been deleted upstream there is nothing left to hide, so the local
// "hidden" bookkeeping no longer means anything.
function forgetHiddenEvents() {
  cleared.clear();
  shown.clear();
  latestEvents = [];
  firstFeed = true;
  localStorage.removeItem(CLEARED_KEY);
}

// The "Clear webhook.site log" button: only the log, nothing else (use "New demo" for a full reset).
async function clearWebhookLog() {
  if (!cfg.canClearWebhooks) {
    return alert("Clearing the webhook.site log needs WEBHOOK_API_KEY set on the server (see app/.env.example).");
  }
  const ok = confirm(
    "Permanently delete ALL requests stored on webhook.site for this URL?\n\n" +
    "This cannot be undone and affects everyone looking at that page.\n" +
    "(\"New demo\" also clears it, as part of starting over.)"
  );
  if (!ok) return;
  const btn = $("btnClearHooks");
  btn.disabled = true;
  const err = await clearWebhookSiteLog();
  if (err) alert(`Could not clear the webhook.site log: ${err}`);
  else {
    forgetHiddenEvents();
    clearedPayments.clear();
    localStorage.removeItem(CLEARED_PAY_KEY);
    await pollFeed();
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------- lifecycle
// Local reset: one fresh cart, empty call log, webhook feed hidden (events stay on webhook.site).
function resetLocal() {
  const oldCarts = carts;
  nextCartNo = 1;
  session = freshSession();
  carts = [session];
  // Capture the payments of the session being closed BEFORE it is replaced below.
  oldCarts.forEach((c) => { if (c.payment && c.payment.id) clearedPayments.add(c.payment.id); });
  latestEvents.forEach((e) => cleared.add(e.uuid));
  shown.forEach((u) => cleared.add(u));
  localStorage.setItem(CLEARED_KEY, JSON.stringify([...cleared].slice(-500)));
  localStorage.setItem(CLEARED_PAY_KEY, JSON.stringify([...clearedPayments].slice(-200)));
  $("log").innerHTML = "";
  render();
  // Redraw the webhook panel right now: do not wait for (or depend on) the next poll to show it cleared.
  if (cfg.webhookMode === "site") renderEvents();
  pollFeed();
}

function resetStatus(text, bad) {
  const el = $("resetStatus");
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
}

// "New demo": reset the mock APIs' state and request logs (WireMock Cloud API, via the server),
// then start over locally. The page is locked meanwhile so nothing is added to a cart that is
// about to be wiped.
async function newDemo() {
  if (resetting) return;
  resetting = true;
  document.body.classList.add("busy");
  $("btnReset").disabled = true;
  hideShownEvents(); // the webhook list empties the moment you click, not when the slow steps finish
  resetStatus("Resetting...", false);

  const resetMocksPart = async () => {
    if (!cfg.canResetMocks) {
      return { bad: true, text: cfg.resetBlocker === "not-configured"
        ? "Mock APIs not reset: no demo mocks are configured (run ./demo-setup.sh)"
        : "Mock APIs not reset: set WMC_API_KEY in app/.env" };
    }
    try {
      const res = await fetch("/api/reset-mocks", { method: "POST", headers: { "X-Requested-With": "payments-demo" } });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { bad: false, text: "Mock state and request logs reset" };
      const failed = (body.results || []).filter((r) => r.state !== "ok" || r.requestLog !== "ok")
        .map((r) => `${r.mock}: ${r.state !== "ok" ? "state " + r.state : "request log " + r.requestLog}`);
      return { bad: true, text: `Mock reset failed: ${failed.join("; ") || body.error || res.status}` };
    } catch (e) {
      return { bad: true, text: `Mock reset failed: ${e.message}` };
    }
  };
  // A webhook.site target with an API key is cleared too; with any other receiver there is nothing to clear.
  const clearHooksPart = async () => {
    if (!cfg.canClearWebhooks) return null;
    const err = await clearWebhookSiteLog();
    return err ? { bad: true, text: `webhook.site log not cleared: ${err}` } : { bad: false, text: "webhook.site log cleared" };
  };

  const [mocks, hooks] = await Promise.all([resetMocksPart(), clearHooksPart()]);
  if (hooks && !hooks.bad) forgetHiddenEvents(); // deleted upstream: nothing left to hide
  resetLocal();
  const parts = [mocks, hooks].filter(Boolean);
  resetStatus(parts.map((p) => p.text).join("; "), parts.some((p) => p.bad));
  resetting = false;
  document.body.classList.remove("busy");
  $("btnReset").disabled = false;
}

async function init() {
  cfg = await (await fetch("/api/config")).json();
  // Webhook receiver: link, panel title and the clear button depend on where webhooks are delivered.
  $("feedTarget").textContent = cfg.webhookHost;
  const hookLink = $("lnkWebhook");
  if (cfg.webhookViewUrl) {
    hookLink.href = cfg.webhookViewUrl;
    hookLink.textContent = cfg.webhookMode === "echo" ? "Request log \u2197" : "webhook.site \u2197";
    hookLink.hidden = false;
  }
  if (cfg.webhookMode !== "site") showReceiverNote();
  $("setupBanner").hidden = cfg.configured;
  if (cfg.configured) $("lnkCart").href = `${cfg.cartUrl}/products`;
  else $("lnkCart").hidden = true;
  $("card").innerHTML = CARDS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  session = freshSession();
  carts = [session];

  $("btnCheckout").onclick = checkout;
  $("btnPay").onclick = doPay;
  $("btnStatus").onclick = refreshStatus;
  $("btnRefund").onclick = () => doRefund(session, toMinor($("refundAmt").value));
  $("btnRefundAll").onclick = () => doRefund(session, refundRemaining(session.payment));
  $("btnOver").onclick = () => doRefund(session, session.payment.amount - session.payment.amountRefunded + 100);
  $("btnReset").onclick = newDemo;
  $("btnReset").title = "Start over: resets the mock APIs' state and request logs" +
    (cfg.canClearWebhooks ? ", clears the webhook.site log" : "") + ", and resets the page";
  $("btnClearHooks").onclick = clearWebhookLog;
  // "Clear webhook.site log" only makes sense for a webhook.site target; it needs the API key.
  const clearBtn = $("btnClearHooks");
  clearBtn.hidden = !(cfg.webhookMode === "site" || cfg.webhookMode === "site-no-key");
  if (cfg.webhookMode === "site-no-key") { clearBtn.disabled = true; clearBtn.title = "Needs WEBHOOK_API_KEY on the server"; }
  // Keep what's typed on the active cart so redraws and tab switches never lose it.
  $("card").onchange = () => (session.card = $("card").value);
  $("refundAmt").oninput = () => (session.refundAmt = $("refundAmt").value);

  render();
  await Promise.all([cfg.configured ? loadProducts() : Promise.resolve(), pollFeed()]);
  setInterval(pollFeed, 3000);
}

init();
