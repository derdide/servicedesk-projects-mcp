import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { BearerTokenProvider, RefreshTokenProvider, type TokenProvider } from "./auth.js";
import { createHttpHandler } from "./http.js";
import { SdpClient } from "./sdp.js";
import { registerTools } from "./tools.js";

const VERSION = "0.5.3";

const INSTRUCTIONS = `ServiceDesk Plus Cloud projects: read projects, milestones, tasks, members, comments and worklogs; update the project; create and update milestones, tasks, comments, worklogs and project members; attach and detach requests and changes (no deletes of records).
- Changes are made as the signed-in user and limited by that user's ServiceDesk permissions; the server may further restrict writes to configured projects.
- Dates are YYYY-MM-DD in the configured timezone (SDP_TIMEZONE, default UTC); worklog start/end take YYYY-MM-DDTHH:mm.
- Before bulk changes, run sdp_bulk_create_tasks with dry_run=true and show the plan to the user.
- Task, milestone and worklog owners must be project members (sdp_add_project_member adds them).
- ServiceDesk requires worklogs on a task before it can be closed: log time with sdp_add_worklog first.`;

function buildServer(cfg: Config, tokens: TokenProvider, user?: string, onTokenRejected?: () => void): McpServer {
  const sdp = new SdpClient(cfg, tokens, user, onTokenRejected);
  const server = new McpServer({ name: "servicedesk-projects", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, sdp, cfg);
  return server;
}

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "http") {
    // Multi-user: each request carries the user's own Zoho token (see src/http.ts).
    const handler = createHttpHandler(cfg, (token, user, onTokenRejected) =>
      buildServer(cfg, new BearerTokenProvider(token), user.email, onTokenRejected),
    );
    const httpServer = createServer(handler);
    httpServer.requestTimeout = 120_000;
    httpServer.headersTimeout = 30_000;
    httpServer.listen(cfg.httpPort, () =>
      process.stderr.write(`servicedesk-projects MCP ${VERSION} listening on :${cfg.httpPort} — public URL ${cfg.publicBaseUrl}/mcp\n`),
    );
  } else {
    const server = buildServer(cfg, new RefreshTokenProvider(cfg));
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
