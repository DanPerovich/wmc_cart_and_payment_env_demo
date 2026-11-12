# Cart -> pay -> status -> refund demo (WireMock Cloud)

A stateful payments simulation plus a private copy of the Shopping Cart API, a web app to drive them,
and everything needed to rebuild the mocks in WireMock Cloud (WMC).

## Quick start: provision a fresh demo and run it
```
./demo-setup.sh              # creates a new WMC environment, points the app at it, starts the app
./demo-setup.sh --verify     # same, but first runs the 5 Arazzo journeys against the new mocks
./demo-setup.sh --teardown   # later: delete the environment + data source the last run created
```
Needs Node 18+ and `WMC_API_KEY` in `app/.env` (copy `app/.env.example`). The script:
1. creates an environment with two blank mock APIs (`payments`, `shopping-cart`) on fresh hostnames,
2. sets their OpenAPI settings and creates the `Test Cards` data source from the CSV,
3. loads the OpenAPI descriptions and stubs from `.wiremock/` (payments stubs are pointed at the new
   data source; nothing in the repository is modified),
4. waits for the new hostnames to resolve (**anywhere from a few seconds to several minutes**: new names have
   no DNS record until WireMock Cloud creates one, and your resolver may cache the miss), smoke-tests both
   mocks (retrying briefly, since a brand-new mock can answer oddly for a few seconds), then resets their
   state and request logs so the demo starts clean,
5. rewrites `PAYMENTS_URL`, `CART_URL`, `PAYMENTS_MOCK_API_ID` and `CART_MOCK_API_ID` in `app/.env`
   (every other line, including your keys, is left alone; what it changed is recorded so `--teardown` can
   undo it), then
6. starts the app (Ctrl+C stops it).

Options: `--name <env name>`, `--no-start`, `--port <n>`, `--restart` (stop an app already running on the
port, only if it is this repo's `server.js`), `--webhook-url <url>` (target baked into the payments
stubs), `--keep-previous`, `--keep-on-failure`, `--env-file <path>`; see `./demo-setup.sh --help`.
It records what it created in `.wiremock/.demo-environment.json` (git-ignored) so `--teardown` removes
exactly that, **and restores `app/.env`**: each of the lines setup wrote goes back to its previous value (or is
removed if setup added it), unless you have edited it since, in which case it is left alone and reported; it refuses to run again until you tear down (or pass `--keep-previous`), and if a step
fails it deletes what that run created. Each run adds a **new** environment: your existing mocks are
never modified.

```
.wiremock/
  environment.yaml            # WMC-side settings, hostnames, environment, data source (no secrets)
  wiremock.yaml               # WireMock Runner config (cloud ids)
  payments-api/               # Payments Demo API: openapi.yaml, stub-mappings.json, arazzo.yaml,
    data-sources/test-cards.csv                                  # + the CSV behind card outcomes
  shopping-cart-demo/         # copy of the shared cart mock: openapi.yaml, stub-mappings.json
app/                          # demo web app (see app/README.md)
tools/                        # setup-demo.mjs (provisioning), gen_stubs.py, Arazzo/browser test helpers, fakes
demo-setup.sh                 # one-command provision + configure + start
```

## What is where
| Asset | Stored in | Generated from |
|---|---|---|
| Payments OpenAPI | `.wiremock/payments-api/openapi.yaml` | hand-written |
| Payments stubs (11) | `.wiremock/payments-api/stub-mappings.json` | `tools/gen_stubs.py` (edit the generator, not the JSON) |
| Test Cards data source | `.wiremock/payments-api/data-sources/test-cards.csv` | - |
| Cart copy OpenAPI + stubs | `.wiremock/shopping-cart-demo/` | pulled from the shared cart mock (`y09z4`), then edited (checkout total) |
| Settings, hostnames, environment | `.wiremock/environment.yaml` | - |
| Journey tests | `.wiremock/payments-api/arazzo.yaml` | - |

## Recreating the mocks in WMC by hand
(`./demo-setup.sh` does all of this; the steps are listed for reference.)
1. **Environment + blank mocks**: create the environment from `environment.yaml` with two blank `openapi`
   members (hostnames `payments-demo-api`, `shopping-cart-demo`). Note the two new mock API IDs.
2. **Settings** for both: `validationMode: hard`, `portalEnabled: true`, all `generate*` flags `false`
   (set these *before* loading files).
3. **Data source**: create a CSV data source named `Test Cards` from `data-sources/test-cards.csv`
   (all columns STRING). Note its new ID.
4. **Generate the payments stubs** with the new data source ID:
   `TEST_CARDS_DATA_SOURCE_ID=<new id> python3 tools/gen_stubs.py .wiremock/payments-api/stub-mappings.json`
   (the webhook target is `WEBHOOK_URL`, default the WireMock Cloud echo service).
5. **Load files** into each mock (OpenAPI first, then stubs): `push` with `openapi_description` and
   `stub_mappings`. `push` *merges by stub ID*, it does not replace, so load into a blank mock.
6. **Point the app at them**: `app/.env` (`PAYMENTS_MOCK_API_ID`, `CART_MOCK_API_ID`, `PAYMENTS_URL`,
   `CART_URL`; see `app/.env.example`).
7. **Verify**: run the Arazzo journeys (below); all 5 workflows / 26 steps should pass.

## Verifying
```
npx @wiremock/arazzo-runner@1.4.0 run .wiremock/payments-api/arazzo.yaml \
  -b shopping-cart=https://shopping-cart-demo.wiremockapi.cloud \
  -b payments=https://payments-demo-api.wiremockapi.cloud \
  -r .wiremock/payments-api/arazzo-report.yaml --no-interactive
```
(Arazzo steps use `<source>.<operationId>`, which this runner needs with two sources.)

## Not in the repository (by design)
- **Secrets**: `app/.env` (`WMC_API_KEY`, and optionally `WEBHOOK_API_KEY`). `.gitignore` excludes it; `app/.env.example` is the template.
- **The webhook receiver**: webhooks go to `WEBHOOK_URL`, by default WireMock Cloud's free echo service (`https://wc-echo.wiremockapi.cloud/webhook/echo`), which stores nothing. To list events in the app and use *Clear webhook.site log*, point `WEBHOOK_URL` at a webhook.site address and set `WEBHOOK_API_KEY`: reading a webhook.site log through its API needs that key, a webhook.site **paid-account** feature. See `app/README.md`.
- **WMC state**: payments/carts/orders exist only at runtime and are reset by the app's *New demo* button (which also clears the webhook.site log when that is the webhook target and `WEBHOOK_API_KEY` is set).
