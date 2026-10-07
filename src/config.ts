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
  clientId: string;
  clientSecret: string;
  refreshToken?: string; // local single-user mode
  writeProjectIds: Set<string> | "*"; // projects where create/update is allowed
  auditLogPath?: string;
  timezone: string;
  transport: "stdio" | "http";
  httpPort: number;
  defaultTaskTemplate: string;
  streamField?: string; // udf_* field exposed as "stream" (optional)
}

export function loadConfig(): Config {
  const writeRaw = (process.env.SDP_WRITE_PROJECT_IDS ?? "").trim();
  return {
    sdpBaseUrl: req("SDP_BASE_URL").replace(/\/+$/, ""),
    portal: req("SDP_PORTAL"),
    zohoAccountsUrl: (process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/+$/, ""),
    clientId: req("ZOHO_CLIENT_ID"),
    clientSecret: req("ZOHO_CLIENT_SECRET"),
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
    transport: (process.env.MCP_TRANSPORT as "stdio" | "http") ?? "stdio",
    httpPort: Number(process.env.PORT ?? 8080),
    defaultTaskTemplate: process.env.SDP_DEFAULT_TASK_TEMPLATE ?? "Default Task",
    streamField: process.env.SDP_STREAM_FIELD || undefined,
  };
}
