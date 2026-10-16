import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration is read from environment variables. For local use, a `.env`
 * file next to the bundled server (or at SDP_ENV_FILE) is loaded first, so
 * secrets do not have to live in claude_desktop_config.json.
 * In Azure, the same variables come from App Settings / Key Vault references.
 */
function loadDotEnv(): void {
  const explicit = process.env.SDP_ENV_FILE;
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const candidates = explicit ? [explicit] : [join(here, ".env"), join(here, "..", ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

loadDotEnv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required configuration: ${name}`);
  return v;
}

export interface Config {
  sdpBaseUrl: string; // e.g. https://sdpondemand.manageengine.eu or your custom domain
  portal: string; // e.g. servicedesk
  zohoAccountsUrl: string; // e.g. https://accounts.zoho.eu
  // Single-user (stdio) mode: the server's own Zoho Self Client credentials
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  writeProjectIds: Set<string> | "*"; // projects where create/update is allowed
  auditLogPath?: string;
  timezone: string;
  transport: "stdio" | "http";
  httpPort: number;
  defaultTaskTemplate: string;
  taskTemplates: Record<string, string>; // per-project task template overrides
  streamField?: string; // udf_* field exposed as "stream" (optional)
  // Multi-user (http) mode
  publicBaseUrl?: string; // e.g. https://mcp.example.com (no trailing slash)
  zohoScopes: string[];
  allowedEmailDomains: string[]; // e.g. ["example.com"]; empty = any signed-in Zoho user of the portal
  allowedUsers: string[]; // explicit e-mail allow-list; empty = no restriction beyond domains
  allowAnyZohoUser: boolean;
  rateLimitPerMinute: number; // per signed-in user
  ipRateLimitPerMinute: number; // per client IP, before authentication
  tokenCacheSeconds: number;
  trustProxyHops: number; // reverse proxies in front (Azure Container Apps ingress = 1)
  allowedOrigins: string[]; // browser Origins accepted on /mcp (besides PUBLIC_BASE_URL's)
  sdpTimeoutMs: number;
}

function num(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`Invalid configuration: ${name}=${JSON.stringify(raw)} (expected an integer between ${min} and ${max})`);
  }
  return v;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function jsonMap(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    /* fall through */
  }
  throw new Error(`${name} must be a JSON object, e.g. {"123456":"My template"}`);
}

export function loadConfig(): Config {
  const cfg = buildConfig();
  if (cfg.transport === "http" && !cfg.allowAnyZohoUser && !cfg.allowedEmailDomains.length && !cfg.allowedUsers.length) {
    throw new Error(
      "Refusing to start: in HTTP mode set ALLOWED_EMAIL_DOMAINS and/or ALLOWED_USERS " +
        "(or ALLOW_ANY_ZOHO_USER=true to accept any Zoho account — not recommended).",
    );
  }
  if (cfg.transport === "http" && !/^https?:\/\/[^/]+$/.test(cfg.publicBaseUrl ?? "")) {
    throw new Error("Invalid configuration: PUBLIC_BASE_URL must be scheme://host[:port] without a path");
  }
  return cfg;
}

function buildConfig(): Config {
  const writeRaw = (process.env.SDP_WRITE_PROJECT_IDS ?? "").trim();
  const transport = (process.env.MCP_TRANSPORT as "stdio" | "http") ?? "stdio";
  const single = transport !== "http";
  return {
    sdpBaseUrl: req("SDP_BASE_URL").replace(/\/+$/, ""),
    portal: req("SDP_PORTAL"),
    zohoAccountsUrl: (process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/+$/, ""),
    clientId: req("ZOHO_CLIENT_ID"), // HTTP mode: the only Zoho client the OAuth facade accepts
    clientSecret: single ? req("ZOHO_CLIENT_SECRET") : process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    writeProjectIds:
      writeRaw === "*"
        ? "*"
        : new Set(
            writeRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
    auditLogPath: process.env.SDP_AUDIT_LOG || undefined,
    timezone: process.env.SDP_TIMEZONE ?? "UTC",
    transport,
    httpPort: Number(process.env.PORT ?? 8080),
    defaultTaskTemplate: process.env.SDP_DEFAULT_TASK_TEMPLATE ?? "Default Task",
    taskTemplates: jsonMap("SDP_TASK_TEMPLATES"),
    streamField: process.env.SDP_STREAM_FIELD || undefined,
    publicBaseUrl: single ? process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") : req("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    zohoScopes: (process.env.ZOHO_SCOPES ?? "SDPOnDemand.projects.READ,SDPOnDemand.projects.CREATE,SDPOnDemand.projects.UPDATE,AaaServer.profile.READ")
      .split(/[ ,]+/)
      .filter(Boolean),
    allowedEmailDomains: list("ALLOWED_EMAIL_DOMAINS").map((d) => d.replace(/^@/, "")),
    allowedUsers: list("ALLOWED_USERS"),
    allowAnyZohoUser: process.env.ALLOW_ANY_ZOHO_USER === "true",
    rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120, 1, 100_000),
    ipRateLimitPerMinute: num("IP_RATE_LIMIT_PER_MINUTE", 300, 1, 100_000),
    tokenCacheSeconds: num("TOKEN_CACHE_SECONDS", 60, 0, 3600),
    trustProxyHops: num("TRUST_PROXY_HOPS", 0, 0, 5),
    allowedOrigins: list("ALLOWED_ORIGINS"),
    sdpTimeoutMs: num("SDP_TIMEOUT_SECONDS", 45, 5, 300) * 1000,
  };
}
