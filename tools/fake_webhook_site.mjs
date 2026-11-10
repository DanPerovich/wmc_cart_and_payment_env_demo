// A tiny stand-in for webhook.site's API, for testing the demo app without touching a real log.
// Usage: node fake_webhook_site.mjs <port> <api-key>
//   GET    /token/:ref          (needs Api-Key)  -> { uuid } (resolves an alias to its token)
//   GET    /token/:t/requests   (needs Api-Key)  -> seeded events, newest first
//   DELETE /token/:t/request    (needs Api-Key)  -> deletes all events
//   GET    /__log                                -> every call received (method, path, whether the key matched)
//   GET    /__seed                               -> restore the seeded events and empty the log
import http from "node:http";
const [port, key] = [process.argv[2], process.argv[3]];
const seed = () => [1, 2].map((n) => ({
  uuid: `00000000-0000-0000-0000-00000000000${n}`,
  created_at: "2026-11-10 14:00:0" + n,
  content: JSON.stringify({ id: `evt_${n}`, type: "payment.succeeded", data: { id: `pay_${n}`, amount: 1000 * n, status: "succeeded" } }),
}));
let events = seed();
const TOKEN_UUID = "11111111-2222-4333-8444-555555555555"; // what any alias resolves to
const log = [];
http.createServer((req, res) => {
  const authed = req.headers["api-key"] === key;
  const path = req.url.split("?")[0];
  if (path === "/__log") return res.end(JSON.stringify(log));
  if (path === "/__seed") { events = seed(); log.length = 0; return res.end("{}"); } // test helper: restore events, empty the log
  log.push({ method: req.method, path, authed });
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!authed) return json(401, { success: false, error: { message: "Authentication error" } });
  // alias or uuid -> token details (the real API answers this for account-owned URLs)
  if (req.method === "GET" && /^\/token\/[^/]+$/.test(path)) return json(200, { uuid: TOKEN_UUID, alias: path.split("/")[2] });
  if (req.method === "GET" && /^\/token\/[^/]+\/requests$/.test(path)) return json(200, { data: events });
  if (req.method === "DELETE" && /^\/token\/[^/]+\/request$/.test(path)) { events = []; return json(200, { success: true }); }
  json(404, { success: false });
}).listen(port, () => console.log("fake webhook.site on", port));
