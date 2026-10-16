// Multi-user HTTP mode: OAuth facade, token check, per-user forwarding, guard-rails.
// Runs dist/server.mjs with MCP_TRANSPORT=http against a local mock of Zoho accounts + ServiceDesk.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const P = "100000000000001";
const USERS = { "tok-jane": "jane.doe@example.com", "tok-eve": "eve@other.org" };
const seen = [];

const mock = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  seen.push({ m: req.method, p: url.pathname, auth: req.headers.authorization, body, q: url.search });
  if (url.pathname === "/oauth/user/info") {
    const t = (req.headers.authorization ?? "").replace("Zoho-oauthtoken ", "");
    return USERS[t] ? send({ Email: USERS[t], Display_Name: "Test" }) : send({ error: "invalid" }, 401);
  }
  if (url.pathname === "/oauth/v2/token") {
    const f = new URLSearchParams(body);
    if (f.get("code") === "bad") return send({ error: "invalid_code" }); // Zoho style: HTTP 200 + error
    return send({ access_token: "tok-jane", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
  }
  const p = url.pathname.replace("/app/servicedesk/api/v3", "");
  if (p === "/projects") return send({ projects: [{ id: P, title: "Demo" }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/comments` && req.method === "POST") return send({ project_comment: { id: "C1", comment: "x" } });
  send({ error: "not mocked " + p }, 404);
});
await new Promise((r) => mock.listen(0, r));
const zoho = `http://127.0.0.1:${mock.address().port}`;

const port = 18000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
let stderr = "";
const srv = spawn("node", ["dist/server.mjs"], {
  env: { ...process.env, MCP_TRANSPORT: "http", PORT: String(port), PUBLIC_BASE_URL: base,
    SDP_BASE_URL: zoho, SDP_PORTAL: "servicedesk", ZOHO_ACCOUNTS_URL: zoho,
    SDP_WRITE_PROJECT_IDS: P, ALLOWED_EMAIL_DOMAINS: "example.com", RATE_LIMIT_PER_MINUTE: "40" },
});
srv.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));

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
  check(!cm.isError && /\[audit\].*"user":"jane\.doe@example\.com".*"op":"add_comment"/.test(stderr), "audit line carries the user's e-mail");
  const userinfoCalls = seen.filter((s) => s.p === "/oauth/user/info" && s.auth === "Zoho-oauthtoken tok-jane").length;
  check(userinfoCalls === 1, `token check cached (${userinfoCalls} identity call for several requests)`);
  await client.close();

  // 10. Rate limit per user
  let got429 = false;
  for (let i = 0; i < 60 && !got429; i++) {
    const rr = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer tok-jane", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) });
    got429 = rr.status === 429;
    await rr.text();
  }
  check(got429, "rate limit per user → 429");

  // 11. Unknown paths
  check((await fetch(`${base}/admin`)).status === 404, "unknown path → 404");

  console.log(`\n${passed} checks passed`);
} finally {
  srv.kill();
  mock.close();
}
