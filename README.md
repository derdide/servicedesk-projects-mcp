# servicedesk-projects-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) **read and maintain projects in ManageEngine ServiceDesk Plus Cloud**: milestones, tasks, comments and task dependencies.

ServiceDesk Plus Cloud has its own MCP connector, but in our use (autumn 2026) it could only read the Projects module, not change it. This server fills that gap for a project manager who wants an AI assistant to keep the project plan current — with guard-rails.

Two ways to run it:

- **Single user, local** — Claude Desktop starts it on your PC with your own Zoho token ([installation](#installation--single-user-local-claude-desktop)).
- **Multi-user, hosted** — one HTTPS service for a team; each person signs in with their own ServiceDesk account; works with **Claude** and **Microsoft 365 Copilot / Copilot Studio** ([multi-user mode](#multi-user-mode-http--for-a-team-claude-and-microsoft-copilot)).

> Not affiliated with or endorsed by ManageEngine / Zoho.

## What it does

| Tool | Access | Purpose |
|---|---|---|
| `sdp_list_projects`, `sdp_get_project` | read | Find projects and their ids |
| `sdp_list_project_members` | read | Members and roles (owners must be members) |
| `sdp_list_milestones` | read | Milestones of a project, in order |
| `sdp_list_tasks`, `sdp_get_task` | read | Tasks, optionally per milestone |
| `sdp_list_comments` | read | Comments on a project, milestone or task |
| `sdp_list_dependencies` | read | Task dependencies (predecessor → successor) |
| `sdp_create_milestone`, `sdp_update_milestone` | write | |
| `sdp_create_task`, `sdp_update_task` | write | Update can also post a comment explaining the change |
| `sdp_bulk_create_tasks` | write | A whole work breakdown in one call, **dry run by default**, with dependencies between the new tasks |
| `sdp_add_dependency` | write | Successor starts after predecessor |
| `sdp_add_comment` | write | Status notes, decisions |

### Guard-rails

- **No delete.** Not implemented, and the OAuth scopes below do not include it.
- **Write allow-list.** Create/update only on the project ids in `SDP_WRITE_PROJECT_IDS`; every other project is read-only. Empty = the whole server is read-only.
- **Dry run first.** `sdp_bulk_create_tasks` validates milestones, owners, dates and dependencies and returns the plan without creating anything unless `dry_run=false`.
- **Attribution.** Changes appear in ServiceDesk under the account whose token the server uses — a real person, not a generic account.
- **Audit trail.** Every write is logged to stderr (visible in the MCP client's log) and optionally to a JSON-lines file (`SDP_AUDIT_LOG`).
- Owners are resolved by email against the project's members. Dates are plain `YYYY-MM-DD` in `SDP_TIMEZONE`; start dates become 00:00, end dates 23:59:59.999.

## Requirements

- ServiceDesk Plus **Cloud** (the on-premise edition has a different API and is not supported).
- A ServiceDesk account with access to the projects you want to manage (project member or admin).
- Node.js 20 or later (`node -v`).
- An MCP client. Instructions below are for **Claude Desktop**; any client that launches stdio servers works.

## Installation — single user, local (Claude Desktop)

### 1. Get the server

Either clone the repository, or download it as a ZIP from GitHub and unzip it. Use a local folder that is **not synced** to the cloud (OneDrive, Dropbox…), because it will hold your personal token.

```
git clone https://github.com/derdide/servicedesk-projects-mcp.git
```

`dist/server.mjs` is pre-built and has no dependencies: no `npm install` is needed to run it.

> Windows: "Extract All" often creates an extra nested folder. Check where `dist\server.mjs` actually is before step 5.

### 2. Find your data centre and portal

Open ServiceDesk in your browser. The URL looks like `https://<domain>/app/<portal>/...`.

| | Value |
|---|---|
| `SDP_BASE_URL` | `https://<domain>` — your custom domain, or `https://sdpondemand.manageengine.com` (US), `.eu` (EU), `.in` (IN) |
| `SDP_PORTAL` | `<portal>` |
| `ZOHO_ACCOUNTS_URL` | Zoho accounts server of the same data centre: `https://accounts.zoho.com` (US), `.eu`, `.in` |

### 3. Create a Zoho Self Client (one-time)

1. Open the Zoho API console of your data centre (e.g. https://api-console.zoho.eu) → **Add Client** → **Self Client** → **Create**. Note the **Client ID** and **Client Secret**.
2. Tab **Generate Code**:
   - Scope: `SDPOnDemand.projects.READ,SDPOnDemand.projects.CREATE,SDPOnDemand.projects.UPDATE`
   - Time duration: 10 minutes; any description.
   - If asked, choose your ServiceDesk portal.
   - Copy the generated code.
3. Within those 10 minutes, exchange the code for a refresh token.

   PowerShell:
   ```powershell
   Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.eu/oauth/v2/token" -Body @{
     grant_type="authorization_code"; client_id="<ID>"; client_secret="<SECRET>"; code="<CODE>" }
   ```
   macOS / Linux:
   ```bash
   curl -X POST https://accounts.zoho.eu/oauth/v2/token \
     -d grant_type=authorization_code -d client_id=<ID> -d client_secret=<SECRET> -d code=<CODE>
   ```
   Use your own data centre's accounts URL. Copy `refresh_token` from the answer. It does not expire; revoke it by deleting the Self Client in the API console.

### 4. Configure

Copy `.env.example` to `.env` in the repository folder (next to this README) and fill it in. At minimum: `SDP_BASE_URL`, `SDP_PORTAL`, `ZOHO_ACCOUNTS_URL`, the three `ZOHO_*` credentials, and `SDP_WRITE_PROJECT_IDS` if you want write access.

Don't know your project id yet? Leave `SDP_WRITE_PROJECT_IDS` empty, finish the installation, ask Claude to list your projects, then add the id and restart.

### 5. Register in Claude Desktop

*Settings → Developer → Edit Config*, then add to `mcpServers`:

```json
{
  "mcpServers": {
    "servicedesk-projects": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\mcp\\servicedesk-projects-mcp\\dist\\server.mjs"]
    }
  }
}
```

macOS: `"args": ["/Users/<you>/mcp/servicedesk-projects-mcp/dist/server.mjs"]`.

Quit Claude Desktop completely (tray / menu bar) and start it again.

### 6. Test, in this order

1. "List my ServiceDesk projects" → find the project id; add it to `SDP_WRITE_PROJECT_IDS` and restart if needed.
2. "List the milestones and members of project <id>".
3. "Add a comment to project <id>: connector test" — the first write.
4. "Create a test task under milestone <X>, owner <email>, due <date>" — then update it.

## Configuration reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SDP_BASE_URL` | yes | — | ServiceDesk base URL (custom domain or data-centre URL) |
| `SDP_PORTAL` | yes | — | Portal name from the ServiceDesk URL |
| `ZOHO_ACCOUNTS_URL` | | `https://accounts.zoho.com` | Zoho accounts server of your data centre |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | yes | — | Self Client credentials (step 3) |
| `SDP_WRITE_PROJECT_IDS` | | empty (read-only) | Comma-separated project ids where writes are allowed, or `*` |
| `SDP_AUDIT_LOG` | | none | Path of a JSON-lines file receiving one line per write |
| `SDP_TIMEZONE` | | `UTC` | IANA timezone for dates, e.g. `Europe/Zurich`; checked at startup. **One time zone for all users** (see *Known limits*) |
| `SDP_DEFAULT_TASK_TEMPLATE` | | `Default Task` | Task template used when creating tasks. A task's template cannot be changed after creation |
| `SDP_STREAM_FIELD` | | none | A task custom field (`udf_*`) exposed as `stream`, e.g. a workstream picklist. Values must match the picklist exactly; existing values are visible on the tasks |
| `SDP_ENV_FILE` | | | Explicit path of the `.env` file |
| `MCP_TRANSPORT` | | `stdio` | `http` for the multi-user mode (see below) |
| `SDP_TASK_TEMPLATES` | | `{}` | Per-project task template, JSON: `{"<project id>":"<template name>"}` |

Multi-user (HTTP) mode only — `ZOHO_CLIENT_SECRET` and `ZOHO_REFRESH_TOKEN` are **not** used in this mode; `ZOHO_CLIENT_ID` is (it is the only client the OAuth facade accepts):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | yes | — | Public HTTPS address of the server, e.g. `https://mcp.example.com` (no path). Requests with another `Host` are refused |
| `ZOHO_CLIENT_ID` | yes | — | Client ID of the shared Zoho client ([docs/zoho-client.md](docs/zoho-client.md)); other client IDs are refused |
| `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_USERS` | **one of them** | — | Who may use the server (comma-separated domains / e-mails). The server refuses to start without either, unless `ALLOW_ANY_ZOHO_USER=true` |
| `PORT` | | `8080` | Listening port inside the container |
| `ZOHO_SCOPES` | | projects READ/CREATE/UPDATE + `AaaServer.profile.READ` | Scopes requested at sign-in (comma-separated) |
| `RATE_LIMIT_PER_MINUTE` | | `120` | HTTP requests per user per minute |
| `IP_RATE_LIMIT_PER_MINUTE` | | `300` | HTTP requests per client IP per minute, checked before authentication |
| `TRUST_PROXY_HOPS` | | `0` | Reverse proxies in front of the server; set `1` behind Azure Container Apps ingress so the client IP is taken from `X-Forwarded-For` |
| `TOKEN_CACHE_SECONDS` | | `60` | How long a checked token is trusted before it is checked again (rejected tokens: 60 s) |
| `ALLOWED_ORIGINS` | | — | Browser `Origin`s accepted on `/mcp` besides `PUBLIC_BASE_URL`'s own; requests with any other `Origin` are refused |
| `SDP_TIMEOUT_SECONDS` | | `45` | Timeout for ServiceDesk calls (Zoho calls: 15 s) |

Numeric settings are validated at startup; an invalid value stops the server instead of silently disabling a limit.

The `.env` file is looked up next to `server.mjs` and one folder above it. Real environment variables take precedence.

## Security model

**The guard-rails protect against the AI, not against the user or the AI client.**

- In multi-user mode each AI client (Claude, Copilot, Copilot Studio) holds the user's own Zoho token and passes it through this server to ServiceDesk ("token passthrough"). That token can do in ServiceDesk what the user can do, within the Zoho scopes granted — no more, but also without this server's guard-rails if used directly. The real boundaries are therefore **the user's ServiceDesk permissions and the Zoho scopes** (no `DELETE` scope). This is a deliberate trade-off: the alternative — the server issuing its own tokens and keeping Zoho tokens server-side — would make it a token store. It deviates from the MCP authorization specification, which asks servers to accept only tokens issued for them.
- **Who gets in is decided on `/mcp`, not by the OAuth facade.** The facade only shapes the sign-in request (it forwards a fixed set of parameters for your own Zoho client and adds `access_type=offline`); anyone with a Zoho account could complete a sign-in. Access is granted when the token's e-mail matches `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_USERS`, and limited by that user's ServiceDesk permissions.
- What the server adds on top: numeric-only ids (no path tricks), a check that an updated task or milestone belongs to the named project (refused if ServiceDesk does not confirm it), no delete operations, dry runs for bulk creation (50 tasks per call), strict dates, and an audit line for every write attempt — with the user's e-mail, the outcome, and the previous values of changed fields.
- **Prompt injection.** Task titles, descriptions and comments are written by many people and are passed to the AI as data. A crafted text can try to make the AI change other tasks or post comments. Mitigations: updates are flagged *destructive* so clients that honour MCP annotations ask before running them; configure your clients to require approval for write tools; review dry runs before confirming. `SDP_WRITE_PROJECT_IDS` can additionally limit writes to named projects; with `*`, any project the user can write in ServiceDesk is reachable.
- **Single-user mode** keeps a long-lived refresh token in `.env` in plain text: protect the file like a password.

## Status and known limits

Tested against a live ServiceDesk Plus Cloud instance (EU data centre, custom domain): reading projects, milestones, tasks and members; creating and updating tasks under a milestone and at project level; owner resolution by email; a custom field exposed as `stream`; comments; task dependencies (creating and listing); token refresh.

Note on dependencies: ServiceDesk Plus Cloud documents dependencies for request tasks only. The project-task endpoint used here (`/projects/{id}/task_dependencies`, `parent_task` / `child_task`) follows the same pattern and works, but is not in the official API reference, so it could change without notice.

Other limits: no delete (by design); **one time zone for everyone** — dates given as `YYYY-MM-DD` (or without offset) are read in `SDP_TIMEZONE`, so a user in another time zone may see a deadline land a few hours off, at worst on the neighbouring day near midnight; creating a task with a milestone or task id is not cross-checked against the project (ServiceDesk permissions still apply); a task cannot be moved between milestones through the API; a bulk creation interrupted by a disconnect stops cleanly but is not resumed — the result lists what was created, and re-running it creates the remaining tasks again *and* duplicates of the created ones, so check before re-running. The multi-user mode keeps its token cache and rate limits in memory: run **one replica**, or put a gateway in front for more.

The multi-user OAuth flow was verified against Zoho (EU) with the [check script](docs/zoho-oauth-check.ps1): discovery, PKCE S256 (enforced), refresh tokens with `access_type=offline`, user-info, and ServiceDesk calls with the user's token. The end-to-end connection from Claude, Microsoft 365 Copilot and Copilot Studio is covered by mocks only so far.

## Multi-user mode (HTTP) — for a team, Claude and Microsoft Copilot

`MCP_TRANSPORT=http` turns the server into a shared, hosted service:

- **Each user signs in with their own ServiceDesk (Zoho) account** — through your SSO if ServiceDesk uses it. The MCP client (Claude, a Microsoft 365 Copilot agent, Copilot Studio) runs the OAuth flow and keeps the user's token; every change in ServiceDesk is made **as that user** and limited by **their** ServiceDesk permissions.
- **The server stores no tokens and no secrets.** It checks each token once (cached), forwards it to ServiceDesk, and logs every write with the user's e-mail.
- It publishes standard OAuth discovery documents and a thin **OAuth facade** in front of Zoho, which adds what Zoho needs and MCP clients don't send (`access_type=offline` for refresh tokens, comma-separated scopes) and translates Zoho's error responses.

```
 Claude / Copilot ──(user's Zoho token)──► /mcp ──(same token)──► ServiceDesk Plus Cloud
        │                                    │
        └──► /oauth/authorize, /oauth/token ─┴──► Zoho accounts (sign-in, via your SSO)
```

| Endpoint | Purpose |
|---|---|
| `/mcp` | MCP (Streamable HTTP, stateless). `401` + `WWW-Authenticate` without a valid token |
| `/.well-known/oauth-protected-resource[/mcp]` | Protected resource metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | Authorization server metadata (RFC 8414) describing the facade |
| `/oauth/authorize` | Redirect to Zoho sign-in |
| `/oauth/token` | Pass-through to Zoho's token endpoint |
| `/healthz` | Liveness |

Guard-rails in this mode: mandatory `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_USERS`, the OAuth facade only accepts your own Zoho client and forwards only allow-listed, non-repeated parameters (PKCE, if used, must be S256), per-user rate limits and a per-IP limit for anonymous traffic, POST-only `/mcp` (no SSE streams), one MCP message per request (no JSON-RPC batches, 256 KB), `Host`/`Origin` checks, timeouts, and `SDP_WRITE_PROJECT_IDS` as an optional server-wide brake on top of ServiceDesk permissions. See [Security model](#security-model) for what these do and do not protect against.

Set-up guides:

- [docs/zoho-client.md](docs/zoho-client.md) — the one Zoho OAuth client all AI clients share, and how to verify it
- [docs/deploy-azure.md](docs/deploy-azure.md) — Azure Container Apps, custom domain, hardening
- [docs/self-host.md](docs/self-host.md) — Docker Compose on any host (e.g. a homelab test), with Caddy or Cloudflare Tunnel
- [docs/clients.md](docs/clients.md) — connect Claude, a Microsoft 365 Copilot declarative agent, and Copilot Studio

## Development

```
npm install
npm run typecheck
npm run build      # → dist/server.mjs (single bundled file)
npm test           # builds, then runs both modes against a local mock of Zoho + ServiceDesk
```

Source layout: `src/server.ts` (entry, transports), `src/http.ts` (multi-user HTTP front end, OAuth facade), `src/tools.ts` (tool definitions), `src/sdp.ts` (API client, audit), `src/auth.ts` (tokens, identity), `src/config.ts`, `src/dates.ts`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module …\dist\server.mjs` | Wrong path in the client config (often a nested folder after unzipping) |
| `Missing required configuration: …` | `.env` not found or incomplete; check its location or set `SDP_ENV_FILE` |
| `Zoho token refresh failed` | Wrong client id/secret/refresh token, or `ZOHO_ACCOUNTS_URL` of the wrong data centre |
| HTTP 404 or HTML instead of JSON | Wrong `SDP_BASE_URL` or `SDP_PORTAL` |
| `Write refused: project … is not in SDP_WRITE_PROJECT_IDS` | Add the project id and restart the client |
| `… is not a member of project …` | Add the owner as project member in ServiceDesk first |
| `Refusing to start: in HTTP mode set ALLOWED_EMAIL_DOMAINS…` | Set who may use the server |
| `403 invalid_host` | `PUBLIC_BASE_URL` does not match the address clients use |
| Server disconnects unexpectedly | Look for `[lifecycle]` lines in the client's MCP log: they tell whether the client closed the connection, the OS sent a signal, or the server crashed |

## License

MIT — see [LICENSE](LICENSE).
