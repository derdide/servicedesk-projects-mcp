import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { fetchZohoIdentity, type UserIdentity } from "./auth.js";

/**
 * Multi-user HTTP front end.
 *
 *   /.well-known/oauth-protected-resource[/mcp]   RFC 9728 — points clients at this server as authorization server
 *   /.well-known/oauth-authorization-server        RFC 8414 — describes the facade below
 *   /.well-known/openid-configuration              same document, for clients that only read OIDC discovery
 *   /oauth/authorize                               redirect to Zoho, adding access_type=offline and normalising scopes
 *   /oauth/token                                   stateless pass-through to Zoho's token endpoint
 *   /mcp                                           MCP (Streamable HTTP, stateless), requires the user's Zoho token
 *   /healthz                                       liveness
 *
 * The server stores no tokens and no secrets. Each MCP request carries the user's Zoho access token;
 * the server checks it once (cached), then forwards it to ServiceDesk, so every change is made as that user.
 */

type MakeServer = (token: string, user: UserIdentity) => McpServer;

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpHandler(cfg: Config, makeServer: MakeServer) {
  const base = cfg.publicBaseUrl!;
  const resource = `${base}/mcp`;
  const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const zohoAuthorize = `${cfg.zohoAccountsUrl}/oauth/v2/auth`;
  const zohoToken = `${cfg.zohoAccountsUrl}/oauth/v2/token`;

  const prm = {
    resource,
    authorization_servers: [base],
    scopes_supported: cfg.zohoScopes,
    bearer_methods_supported: ["header"],
    resource_name: "ServiceDesk Plus projects",
  };
  const asMeta = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: cfg.zohoScopes,
  };

  // ---- token check cache and rate limit (in memory: fine for one instance; use a gateway for more) ----
  const identityCache = new Map<string, { user: UserIdentity; exp: number }>();
  const hits = new Map<string, { windowStart: number; count: number }>();

  async function identify(token: string): Promise<UserIdentity | null> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = identityCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.user;
    const user = await fetchZohoIdentity(cfg, token);
    if (user) {
      identityCache.set(key, { user, exp: Date.now() + cfg.tokenCacheSeconds * 1000 });
      if (identityCache.size > 5000) {
        for (const [k, v] of identityCache) if (v.exp <= Date.now()) identityCache.delete(k);
      }
    }
    return user;
  }

  function allowed(user: UserIdentity): boolean {
    if (cfg.allowedUsers.length && cfg.allowedUsers.includes(user.email)) return true;
    if (cfg.allowedEmailDomains.length) return cfg.allowedEmailDomains.includes(user.email.split("@")[1] ?? "");
    return cfg.allowedUsers.length === 0;
  }

  function rateLimited(email: string): boolean {
    const now = Date.now();
    const h = hits.get(email);
    if (!h || now - h.windowStart >= 60_000) {
      hits.set(email, { windowStart: now, count: 1 });
      return false;
    }
    h.count++;
    return h.count > cfg.rateLimitPerMinute;
  }

  function unauthorized(res: ServerResponse, error?: string) {
    const parts = [`Bearer resource_metadata="${prmUrl}"`, `scope="${cfg.zohoScopes.join(" ")}"`];
    if (error) parts.push(`error="${error}"`);
    send(res, 401, { error: error ?? "unauthorized" }, { "WWW-Authenticate": parts.join(", ") });
  }

  // ---- OAuth facade ----
  function authorize(url: URL, res: ServerResponse) {
    const out = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (k === "resource") continue; // RFC 8707 parameter, unknown to Zoho
      out.set(k, v);
    }
    // Zoho expects comma-separated scopes; MCP clients send space-separated ones (and may add offline_access).
    const requested = (url.searchParams.get("scope") ?? "")
      .split(/[ ,]+/)
      .filter((s) => s && cfg.zohoScopes.some((z) => z.toLowerCase() === s.toLowerCase()));
    out.set("scope", (requested.length ? requested : cfg.zohoScopes).join(","));
    out.set("access_type", "offline"); // without it Zoho issues no refresh token
    if (!out.has("prompt")) out.set("prompt", "consent");
    res.writeHead(302, { Location: `${zohoAuthorize}?${out.toString()}`, "Cache-Control": "no-store" });
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const body = new URLSearchParams(await readBody(req));
    body.delete("resource");
    // client_secret_basic → client_secret_post (Zoho reads credentials from the form)
    const auth = req.headers.authorization;
    if (auth?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
      if (id && !body.has("client_id")) body.set("client_id", decodeURIComponent(id));
      if (secret && !body.has("client_secret")) body.set("client_secret", decodeURIComponent(secret));
    }
    const upstream = await fetch(zohoToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!json.access_token) {
      // Zoho answers errors with HTTP 200; OAuth clients expect 400 and RFC 6749 codes.
      const map: Record<string, string> = { invalid_code: "invalid_grant", invalid_client_secret: "invalid_client" };
      const err = typeof json.error === "string" ? json.error : "invalid_request";
      send(res, upstream.ok ? 400 : upstream.status, { error: map[err] ?? err, error_description: `Zoho: ${err}` });
      return;
    }
    send(res, 200, json);
  }

  // ---- MCP ----
  async function mcp(req: IncomingMessage, res: ServerResponse) {
    const h = req.headers.authorization ?? "";
    const m = h.match(/^(?:Bearer|Zoho-oauthtoken)\s+(.+)$/i);
    if (!m) return unauthorized(res);
    const tok = m[1].trim();
    const user = await identify(tok);
    if (!user) return unauthorized(res, "invalid_token");
    if (!allowed(user)) return send(res, 403, { error: "forbidden", error_description: `${user.email} is not allowed to use this server` });
    if (rateLimited(user.email)) return send(res, 429, { error: "rate_limited" }, { "Retry-After": "60" });

    const server = makeServer(tok, user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", base);
      const p = url.pathname.replace(/\/+$/, "") || "/";
      if (p === "/healthz") return send(res, 200, "ok");
      if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp"))
        return send(res, 200, prm);
      if (
        req.method === "GET" &&
        (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration"))
      )
        return send(res, 200, asMeta);
      if (req.method === "GET" && p === "/oauth/authorize") return authorize(url, res);
      if (req.method === "POST" && p === "/oauth/token") return await token(req, res);
      if (p === "/mcp") return await mcp(req, res);
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      process.stderr.write(`[http] ${req.method} ${req.url} failed: ${(e as Error).message}\n`);
      if (!res.headersSent) send(res, status, { error: status === 413 ? "payload_too_large" : "server_error" });
    }
  };
}
