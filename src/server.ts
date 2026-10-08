import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { RefreshTokenProvider } from "./auth.js";
import { SdpClient } from "./sdp.js";
import { registerTools } from "./tools.js";

const VERSION = "0.4.1";

const INSTRUCTIONS = `ServiceDesk Plus Cloud projects: read projects, milestones, tasks, members and comments; create and update milestones, tasks and comments (no deletes).
- Writes are only allowed on projects configured in SDP_WRITE_PROJECT_IDS; changes are attributed to the account whose token the server uses.
- Dates are YYYY-MM-DD in the configured timezone (SDP_TIMEZONE, default UTC).
- Before bulk changes, run sdp_bulk_create_tasks with dry_run=true and show the plan to the user.
- Task and milestone owners must be project members.`;

function buildServer(): McpServer {
  const cfg = loadConfig();
  const sdp = new SdpClient(cfg, new RefreshTokenProvider(cfg));
  const server = new McpServer({ name: "servicedesk-projects", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, sdp, cfg);
  return server;
}

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "http") {
    // Streamable HTTP, stateless. Intended for container hosting (e.g. Azure Container Apps).
    // NOTE: this mode still uses the single refresh token from configuration. Do not expose it
    // to other users until per-user authentication is added (see README, "Hosting on Azure").
    const httpServer = createServer(async (req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServer.listen(cfg.httpPort, () => process.stderr.write(`servicedesk-projects MCP listening on :${cfg.httpPort}/mcp\n`));
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`servicedesk-projects MCP ${VERSION} running on stdio\n`);
  }
}

// ---- lifecycle diagnostics: make every exit visible in the Claude MCP log ----
const t0 = Date.now();
const up = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const log = (m: string) => process.stderr.write(`[lifecycle] ${new Date().toISOString()} ${m} (uptime ${up()})\n`);
process.on("uncaughtException", (e) => {
  log(`uncaughtException: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => log(`unhandledRejection (ignored): ${(e as Error)?.stack ?? e}`));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
  try {
    process.on(sig, () => {
      log(`received ${sig}`);
      process.exit(0);
    });
  } catch {
    /* signal not supported on this platform */
  }
}
process.stdin.on("end", () => log("stdin ended (client closed the connection)"));
process.stdin.on("close", () => log("stdin closed"));
process.on("exit", (code) => log(`process exit, code ${code}`));
log(`started, pid ${process.pid}, node ${process.version}`);

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
