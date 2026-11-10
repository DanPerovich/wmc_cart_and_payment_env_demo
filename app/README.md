# Payments demo web app

A single-page app that walks the journey **cart -> checkout -> pay -> status -> refund**
against two WireMock Cloud mock APIs, and shows the webhooks the Payments mock fires.

```
node server.js          # then open http://localhost:8787   (Node 18+, no dependencies)
```
Easiest: `../demo-setup.sh` provisions fresh mocks, writes the settings below into `.env`, and starts the app.

## Configuration (`app/.env`)
Put settings in `app/.env` (copy `.env.example`); `server.js` loads it on startup. Real environment
variables take precedence, so `PORT=9000 node server.js` still works. `.env` is git-ignored, and the
server prints on startup whether the keys were found (never the keys themselves).

| Variable | Needed for | Default |
|---|---|---|
| `WMC_API_KEY` | **New demo** resetting the mocks' state and request logs (and `demo-setup.sh`) | none: New demo then only resets the page |
| `WEBHOOK_URL` | where the Payments mock delivers webhooks | WireMock Cloud echo service |
| `WEBHOOK_API_KEY` | only with a **webhook.site** `WEBHOOK_URL`: listing events in the app and the *Clear webhook.site log* button | none |
| `PAYMENTS_URL`, `CART_URL`, `PAYMENTS_MOCK_API_ID`, `CART_MOCK_API_ID` | which mocks the app talks to / resets (`demo-setup.sh` writes these) | the original demo mocks |
| `PORT`, `WEBHOOK_TOKEN`, `WEBHOOK_API_BASE`, `WMC_API_BASE` | rarely needed | see `.env.example` |

## Webhook receiver
The Payments mock sends a webhook for every payment and refund (`payment.succeeded`, `payment.failed`,
`refund.succeeded`, `refund.failed`). Where they go is `WEBHOOK_URL`, which is **baked into the mock's
stubs** when it is provisioned: after changing it, re-run `../demo-setup.sh` (or regenerate the stubs
with `tools/gen_stubs.py`). What the app can do depends on the receiver:

| `WEBHOOK_URL` | Webhooks delivered | Events listed in the app | *Clear webhook.site log* button |
|---|---|---|---|
| *(unset)* = WireMock Cloud echo, `https://wc-echo.wiremockapi.cloud/webhook/echo` | yes | no | hidden |
| a webhook.site address, no `WEBHOOK_API_KEY` | yes | no | visible but disabled |
| a webhook.site address **and** `WEBHOOK_API_KEY` | yes | **yes** | **works** |
| any other URL | yes | no | hidden |

- **Why "no" for the echo service:** it replies with a copy of the request and stores nothing, and the
  WireMock Cloud API does not expose webhook deliveries. Instead, WireMock Cloud's request log for the
  Payments mock shows each webhook and the echoed response under the request that triggered it; the
  app's header links to it and the webhook panel explains this. (The link is
  `https://app.wiremock.cloud/mock-apis/<payments mock id>/requests`.)
- **Why a key for webhook.site:** reading or deleting a webhook.site log through its API needs an
  API key, which is a webhook.site **paid-account** feature. The webhooks still arrive without it and
  can be read on webhook.site itself. `WEBHOOK_URL` may be a token URL or a custom alias; the app
  resolves an alias to its token through webhook.site's API using the key.

## New demo, and clearing the webhook.site log
- **New demo** starts over: it resets the **state and request log of both mock APIs** (carts, orders,
  payments and refunds are forgotten; stubs, specs and data sources are untouched), goes back to one
  fresh cart, empties the API-calls panel, and, when events are listed, *hides* the webhook events
  currently on webhook.site (nothing is deleted there; the hidden list is kept in `localStorage`, so it
  is per browser). The page is locked for the second or so the reset takes. It needs `WMC_API_KEY`
  (sent as `Authorization: Token <key>`); without it, it still resets the page and says the mocks were
  not reset. The mocks are `PAYMENTS_MOCK_API_ID` and `CART_MOCK_API_ID`. The original shared cart mock
  `y09z4` is always refused. Under the hood: `POST /v1/mock-apis/{id}/scenarios/reset` (state) and
  `DELETE /v1/mock-apis/{id}/requests` (request log) on the WireMock Cloud API.
- **Clear webhook.site log** *permanently deletes* every request stored on the webhook.site URL
  (`DELETE /token/<token>/request`, sent with the `Api-Key` header), for everyone. It asks for
  confirmation first, and only exists for a webhook.site target with `WEBHOOK_API_KEY` (see the table).
- Both are `POST`-only endpoints on this server and require a same-origin request with an
  `X-Requested-With: payments-demo` header, so other websites cannot trigger them through localhost.

## Demo script
1. Add a couple of products, check out. The cart API returns an `orderId` and the order total.
2. Pick a test card and pay. The card token drives the outcome via the CSV data source.
3. See the `payment.succeeded` / `payment.failed` webhook: in the right-hand panel when the receiver is
   a webhook.site address with an API key, otherwise in the Payments mock's request log in WireMock Cloud.
4. Refund part of the payment, then try **Over-refund** (fails with `amount_exceeds_refundable`),
   then **Refund remaining**. The status moves `succeeded -> partially_refunded -> refunded`.
5. **New demo**, pay with a declined card, and try to refund it (`409 payment_not_refundable`).

## Notes
- The browser calls both mock APIs directly (they allow CORS). `server.js` serves the page and proxies
  the webhook.site feed, because webhook.site's API sends no CORS headers.
- With a readable webhook.site feed, every event on that URL is shown, including ones from earlier
  sessions, until you click **New demo** (which hides them in this browser).
- Tests (all use local fakes; no real service is touched unless stated):
  `node ../tools/receiver_modes_test.mjs` (server, each receiver mode),
  `node ../tools/ui_receiver_smoke.mjs` (browser, each receiver mode),
  `node ../tools/ui_clear_smoke.mjs`, `node ../tools/ui_reset_smoke.mjs`, and
  `SKIP_WEBHOOKS=1 node ../tools/ui_smoke.mjs <app url> <screenshot.png>` (whole journey against the
  mocks the app points at; skip the webhook checks unless the feed is readable).
