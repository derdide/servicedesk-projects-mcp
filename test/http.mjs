// Multi-user HTTP mode: OAuth facade, token check, per-user forwarding, guard-rails.
// Runs dist/server.mjs with MCP_TRANSPORT=http against a local mock of Zoho accounts + ServiceDesk.
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const P = "100000000000001";
const USERS = { "tok-jane": "jane.doe@example.com", "tok-eve": "eve@other.org", "tok-stale": "jane.doe@example.com" };
let creates = 0;
const seen = [];

const mock = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  seen.push({ m: req.method, p: url.pathname, auth: req.headers.authorization, body, q: url.search });
  if (url.pathname === "/oauth/user/info") {
    const t = (req.headers.authorization ?? "").replace("Zoho-oauthtoken ", "");
    if (t === "tok-zoho-down") return send({ error: "internal" }, 503);
    return USERS[t] ? send({ Email: USERS[t], Display_Name: "Test" }) : send({ error: "invalid" }, 401);
  }
  if (url.pathname === "/oauth/v2/token") {
    const f = new URLSearchParams(body);
    if (f.get("code") === "bad") return send({ error: "invalid_code" }); // Zoho style: HTTP 200 + error
    return send({ access_token: "tok-jane", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
  }
  const p = url.pathname.replace("/app/servicedesk/api/v3", "");
  if (req.headers.authorization === "Zoho-oauthtoken tok-stale") return send({ error: "expired" }, 401);
  if (p === `/projects/${P}/milestones` && req.method === "GET") return send({ milestones: [], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/tasks` && req.method === "POST") {
    await new Promise((r) => setTimeout(r, 150));
    creates++;
    return send({ task: { id: String(700000 + creates), title: "t", project: { id: P } } });
  }
  if (p === "/projects") return send({ projects: [{ id: P, title: "Demo" }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/comments` && req.method === "POST") return send({ project_comment: { id: "C1", comment: "x" } });
  send({ error: "not mocked " + p }, 404);
});
await new Promise((r) => mock.listen(0, r));
const zoho = `http://127.0.0.1:${mock.address().port}`;

const port = 18000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const baseEnv = { ...process.env, MCP_TRANSPORT: "http", SDP_BASE_URL: zoho, SDP_PORTAL: "servicedesk", ZOHO_ACCOUNTS_URL: zoho,
  ZOHO_CLIENT_ID: "cid", SDP_WRITE_PROJECT_IDS: P, ALLOWED_EMAIL_DOMAINS: "example.com" };
async function start(p, env) {
  const proc = spawn("node", ["dist/server.mjs"], { env: { ...baseEnv, PORT: String(p), PUBLIC_BASE_URL: `http://127.0.0.1:${p}`, ...env } });
  const out = { text: "", proc, exited: null };
  proc.stderr.on("data", (d) => (out.text += d));
  proc.on("exit", (c) => (out.exited = c));
  for (let i = 0; i < 50 && !out.text.includes("listening") && out.exited === null; i++) await new Promise((r) => setTimeout(r, 100));
  return out;
}
const main = await start(port, { RATE_LIMIT_PER_MINUTE: "60" });
const srv = main.proc;


let passed = 0;
const check = (cond, label) => { assert.ok(cond, label); passed++; console.log("ok -", label); };

try {
  // 1. Unauthenticated MCP call → 401 with discovery pointer
  let r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const www = r.headers.get("www-authenticate") ?? "";
  check(r.status === 401 && www.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`), "401 + resource_metadata pointer without token");

  // 2. Protected resource metadata
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check(prm.resource === `${base}/mcp` && prm.authorization_servers[0] === base, "protected resource metadata");

  // 3. Authorization server metadata (RFC 8414 and OIDC paths)
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const oidc = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
  check(as.authorization_endpoint === `${base}/oauth/authorize` && as.code_challenge_methods_supported.includes("S256") && oidc.issuer === base, "authorization server metadata");

  // 4. Authorize facade → Zoho with access_type=offline, comma scopes, no resource
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=cid&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=s1&code_challenge=abc&code_challenge_method=S256&resource=${encodeURIComponent(base + "/mcp")}&scope=SDPOnDemand.projects.READ%20offline_access%20SDPOnDemand.projects.UPDATE`, { redirect: "manual" });
  const loc = new URL(r.headers.get("location"));
  check(r.status === 302 && loc.origin + loc.pathname === `${zoho}/oauth/v2/auth`, "authorize redirects to Zoho");
  check(loc.searchParams.get("access_type") === "offline" && loc.searchParams.get("prompt") === "consent", "access_type=offline and prompt=consent added");
  check(loc.searchParams.get("scope") === "SDPOnDemand.projects.READ,SDPOnDemand.projects.UPDATE", "scopes filtered and comma-separated (offline_access dropped)");
  check(!loc.searchParams.has("resource") && loc.searchParams.get("code_challenge") === "abc" && loc.searchParams.get("state") === "s1", "resource stripped; PKCE and state passed through");

  // 5. Token pass-through: Basic auth → form, resource stripped
  r = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from("cid:sec").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "good", code_verifier: "v", redirect_uri: "x", resource: base + "/mcp" }) });
  const tok = await r.json();
  const up = new URLSearchParams(seen.filter((s) => s.p === "/oauth/v2/token").at(-1).body);
  check(r.status === 200 && tok.access_token === "tok-jane", "token exchange passed through");
  check(up.get("client_id") === "cid" && up.get("client_secret") === "sec" && !up.has("resource") && up.get("code_verifier") === "v", "client credentials moved to form; resource stripped; verifier kept");

  // 6. Zoho error (HTTP 200 + error) → 400 invalid_grant
  r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "bad", client_id: "cid", client_secret: "sec" }) });
  check(r.status === 400 && (await r.json()).error === "invalid_grant", "Zoho errors mapped to 400 invalid_grant");

  // 7. Invalid token → 401 invalid_token
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  check(r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'), "unknown token → 401 invalid_token");

  // 8. User outside ALLOWED_EMAIL_DOMAINS → 403
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer tok-eve", "content-type": "application/json" }, body: "{}" });
  check(r.status === 403, "user outside allowed domains → 403");

  // 9. Real MCP session as Jane: token forwarded to ServiceDesk, audit carries her e-mail
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok-jane" } } }));
  const list = await client.callTool({ name: "sdp_list_projects", arguments: {} });
  check(!list.isError && JSON.parse(list.content[0].text)[0].id === P, "MCP tool call works with the user's token");
  check(seen.some((s) => s.p.endsWith("/projects") && s.auth === "Zoho-oauthtoken tok-jane"), "user's token forwarded to ServiceDesk");
  const cm = await client.callTool({ name: "sdp_add_comment", arguments: { project_id: P, comment: "hello" } });
  await new Promise((r) => setTimeout(r, 200));
  check(!cm.isError && /\[audit\].*"user":"jane\.doe@example\.com".*"op":"add_comment"/.test(main.text), "audit line carries the user's e-mail");
  const userinfoCalls = seen.filter((s) => s.p === "/oauth/user/info" && s.auth === "Zoho-oauthtoken tok-jane").length;
  check(userinfoCalls === 1, `token check cached (${userinfoCalls} identity call for several requests)`);
  await client.close();

  // ---- regression tests for the security review (v0.5.1) ----
  const rpc = (body, headers = {}) => fetch(`${base}/mcp`, { method: "POST",
    headers: { authorization: "Bearer tok-jane", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) });

  r = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
  check(r.status === 400 && /Batch/.test(await r.text()), "F3: JSON-RPC batches refused");
  r = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(300 * 1024) }));
  check(r.status === 413, "F3: /mcp body limited to 256 KB");

  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=attacker&redirect_uri=https%3A%2F%2Fevil`, { redirect: "manual" });
  check(r.status === 400, "F15: authorize refuses foreign client_id");
  r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "good", client_id: "attacker", client_secret: "x" }) });
  check(r.status === 401, "F15: token endpoint refuses foreign client_id");

  r = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from("cid:se:cret").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "good" }) });
  const fwd = new URLSearchParams(seen.filter((x) => x.p === "/oauth/v2/token").at(-1).body);
  check(r.status === 200 && fwd.get("client_secret") === "se:cret", "F6: secret containing ':' forwarded intact");
  r = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from("cid:%E0%A4%A").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "good" }) });
  check(r.status === 401, "F6: malformed Basic credentials → 401, not 500");
  r = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from("cid:sec").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "good", client_secret: "sec" }) });
  check(r.status === 400, "F6: Basic + form credentials together refused");

  const junkBefore = seen.filter((x) => x.p === "/oauth/user/info").length;
  for (let i = 0; i < 5; i++) await (await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer junk-token" })).text();
  check(seen.filter((x) => x.p === "/oauth/user/info").length - junkBefore === 1, "F2: rejected tokens cached (1 Zoho call for 5 requests)");

  r = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
  check(r.status === 403, "F9: foreign Origin refused");
  const hostStatus = await new Promise((resolve) => {
    const rq = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { host: "evil.example", authorization: "Bearer tok-jane", "content-type": "application/json" } }, (rs) => { rs.resume(); resolve(rs.statusCode); });
    rq.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
  check(hostStatus === 403, "F9: foreign Host refused");

  // F5: ServiceDesk says 401 → tool error, cache evicted, next request re-validated
  const stale = new Client({ name: "stale", version: "0" });
  await stale.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok-stale" } } }));
  const sr = await stale.callTool({ name: "sdp_list_projects", arguments: {} });
  const infoBefore = seen.filter((x) => x.p === "/oauth/user/info" && x.auth === "Zoho-oauthtoken tok-stale").length;
  await stale.callTool({ name: "sdp_list_projects", arguments: {} }).catch(() => {});
  const infoAfter = seen.filter((x) => x.p === "/oauth/user/info" && x.auth === "Zoho-oauthtoken tok-stale").length;
  check(sr.isError && /rejected your access token/.test(sr.content[0].text) && infoAfter > infoBefore, "F5: ServiceDesk 401 evicts the cached token check");
  await stale.close().catch(() => {});

  // F7: client disconnects during a bulk create → the server stops
  const ac = new AbortController();
  const tasks = Array.from({ length: 20 }, (_, i) => ({ title: "t" + i }));
  creates = 0;
  setTimeout(() => ac.abort(), 600);
  await fetch(`${base}/mcp`, { method: "POST", signal: ac.signal,
    headers: { authorization: "Bearer tok-jane", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "sdp_bulk_create_tasks", arguments: { project_id: P, dry_run: false, tasks } } }) })
    .then((x) => x.text()).catch(() => null);
  await new Promise((r) => setTimeout(r, 2000));
  check(creates > 0 && creates < 10, `F7: bulk create stops when the client disconnects (${creates} of 20 created)`);
  check(/"outcome":"stopped"/.test(main.text), "F7: stop is audited");

  // 10. Rate limit per user
  let got429 = false;
  for (let i = 0; i < 60 && !got429; i++) {
    const rr = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer tok-jane", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) });
    got429 = rr.status === 429;
    await rr.text();
  }
  check(got429, "rate limit per user → 429");

  // R1: OAuth facade forwards only allow-listed, non-repeated parameters
  const cb = "redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback";
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=cid&client_id=attacker&${cb}`, { redirect: "manual" });
  check(r.status === 400 && !r.headers.get("location"), "R1: repeated client_id refused");
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=cid&${cb}&${cb}`, { redirect: "manual" });
  check(r.status === 400, "R1: any repeated parameter refused");
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=cid&${cb}&code_challenge=abc&code_challenge_method=plain`, { redirect: "manual" });
  check(r.status === 400, "R1: PKCE plain refused");
  r = await fetch(`${base}/oauth/authorize?response_type=token&client_id=cid&${cb}`, { redirect: "manual" });
  check(r.status === 400, "R1: only response_type=code");
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=cid&${cb}&prompt=none&login_hint=x&foo=1`, { redirect: "manual" });
  const loc2 = new URL(r.headers.get("location") ?? "http://x");
  check(r.status === 302 && loc2.searchParams.get("prompt") === "consent" && !loc2.searchParams.has("foo") && !loc2.searchParams.has("login_hint"), "R1: unknown parameters dropped, prompt=consent forced");

  // R8: no SSE stream, no sessions
  for (const method of ["GET", "DELETE"]) {
    r = await fetch(`${base}/mcp`, { method, headers: { authorization: "Bearer tok-jane", accept: "text/event-stream" } });
    check(r.status === 405 && r.headers.get("allow") === "POST", `R8: ${method} /mcp → 405 Allow: POST`);
    await r.text();
  }

  // R7: Zoho outage is not cached as a bad token
  const downBefore = seen.filter((x) => x.auth === "Zoho-oauthtoken tok-zoho-down").length;
  r = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer tok-zoho-down" });
  const r2 = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer tok-zoho-down" });
  const downCalls = seen.filter((x) => x.auth === "Zoho-oauthtoken tok-zoho-down").length - downBefore;
  check(r.status === 503 && r2.status === 503 && r.headers.get("retry-after") && downCalls === 2, "R7: Zoho 5xx → 503, not cached");

  // 11. Unknown paths
  check((await fetch(`${base}/admin`)).status === 404, "unknown path → 404");

  // F4 / F18: fail closed on unsafe configuration
  const noAllow = await start(port + 1, { ALLOWED_EMAIL_DOMAINS: "" });
  await new Promise((r) => setTimeout(r, 300));
  check(noAllow.exited !== null && /Refusing to start/.test(noAllow.text), "F4: refuses to start without an allow-list");
  const badNum = await start(port + 2, { RATE_LIMIT_PER_MINUTE: "12O" });
  await new Promise((r) => setTimeout(r, 300));
  check(badNum.exited !== null && /Invalid configuration: RATE_LIMIT_PER_MINUTE/.test(badNum.text), "F18: invalid numbers refused at startup");

  // F2: per-IP limit before authentication
  const ipSrv = await start(port + 3, { IP_RATE_LIMIT_PER_MINUTE: "5" });
  let ip429 = false;
  for (let i = 0; i < 10 && !ip429; i++) ip429 = (await fetch(`http://127.0.0.1:${port + 3}/.well-known/oauth-protected-resource`)).status === 429;
  check(ip429, "F2: per-IP rate limit before authentication");
  ipSrv.proc.kill();

  // R10: signed-in users are not counted against the shared per-IP limit
  const ipSrv2 = await start(port + 4, { IP_RATE_LIMIT_PER_MINUTE: "3" });
  let authed429 = false;
  for (let i = 0; i < 8; i++) {
    const rr = await fetch(`http://127.0.0.1:${port + 4}/mcp`, { method: "POST", headers: { authorization: "Bearer tok-jane", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) });
    authed429 ||= rr.status === 429;
    await rr.text();
  }
  let anon429 = false;
  for (let i = 0; i < 6 && !anon429; i++) anon429 = (await fetch(`http://127.0.0.1:${port + 4}/.well-known/oauth-protected-resource`)).status === 429;
  check(!authed429 && anon429, "R10: per-IP limit applies to anonymous traffic only");
  ipSrv2.proc.kill();

  // O2: misspelt time zone refused at startup
  const badTz = await start(port + 5, { SDP_TIMEZONE: "Europe/Zurch" });
  await new Promise((r) => setTimeout(r, 300));
  check(badTz.exited !== null && /SDP_TIMEZONE/.test(badTz.text), "O2: invalid SDP_TIMEZONE refused at startup");

  console.log(`\n${passed} checks passed`);
} finally {
  srv.kill();
  mock.close();
}
