// A tiny stand-in for the WireMock Cloud API's reset endpoints, to test the demo app without
// resetting real mock APIs.
// Usage: node fake_wmc_api.mjs <port> <api-key> [failId] [delayMs]
//   POST   /v1/mock-apis/:id/scenarios/reset   reset state          (needs `Authorization: Token <api-key>`)
//   DELETE /v1/mock-apis/:id/requests          empty request log
//   POST   /v1/mock-apis/:id/requests/reset    deprecated: answers 404, like the real API now does
//   a request-log delete for mock API <failId> answers 500
//   GET /__log -> every call received; GET /__clear -> empty the log
import http from "node:http";
const [port, key, failId, delayMs] = process.argv.slice(2);
const expected = `Token ${key}`;
const log = [];
http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/__log") return res.end(JSON.stringify(log));
  if (path === "/__clear") { log.length = 0; return res.end("{}"); }
  const authed = req.headers.authorization === expected;
  log.push({ method: req.method, path, authed });
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (delayMs) await new Promise((r) => setTimeout(r, Number(delayMs)));
  if (!authed) return json(401, { errors: [{ title: "Unauthorized" }] });
  const state = path.match(/^\/v1\/mock-apis\/([^/]+)\/scenarios\/reset$/);
  const journal = path.match(/^\/v1\/mock-apis\/([^/]+)\/requests$/);
  if (req.method === "POST" && state) return json(200, {});
  if (req.method === "DELETE" && journal) return failId && journal[1] === failId ? json(500, {}) : json(200, {});
  json(404, {}); // anything else, including the deprecated POST .../requests/reset
}).listen(port, () => console.log("fake WireMock Cloud API on", port));
