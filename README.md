# servicedesk-projects-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) **read and maintain projects in ManageEngine ServiceDesk Plus Cloud**: milestones, tasks, comments and task dependencies.

ServiceDesk Plus Cloud has its own MCP connector, but in our use (autumn 2026) it could only read the Projects module, not change it. This server fills that gap for a project manager who wants an AI assistant to keep the project plan current — with guard-rails.

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
- Node.js 18 or later (`node -v`).
- An MCP client. Instructions below are for **Claude Desktop**; any client that launches stdio servers works.

## Installation

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
| `SDP_TIMEZONE` | | `UTC` | IANA timezone for dates, e.g. `Europe/Zurich` |
| `SDP_DEFAULT_TASK_TEMPLATE` | | `Default Task` | Task template used when creating tasks. A task's template cannot be changed after creation |
| `SDP_STREAM_FIELD` | | none | A task custom field (`udf_*`) exposed as `stream`, e.g. a workstream picklist. Values must match the picklist exactly; existing values are visible on the tasks |
| `SDP_ENV_FILE` | | | Explicit path of the `.env` file |
| `MCP_TRANSPORT` | | `stdio` | `http` for container hosting (see below) |
| `PORT` | | `8080` | HTTP port when `MCP_TRANSPORT=http` |

The `.env` file is looked up next to `server.mjs` and one folder above it. Real environment variables take precedence.

## Status and known limits

Tested against a live ServiceDesk Plus Cloud instance (EU data centre, custom domain): reading projects, milestones, tasks and members; creating and updating tasks under a milestone and at project level; owner resolution by email; a custom field exposed as `stream`; comments; task dependencies (creating and listing); token refresh.

Note on dependencies: ServiceDesk Plus Cloud documents dependencies for request tasks only. The project-task endpoint used here (`/projects/{id}/task_dependencies`, `parent_task` / `child_task`) follows the same pattern and works, but is not in the official API reference, so it could change without notice.

Other limits: no delete (by design); a task cannot be moved between milestones through the API; the HTTP mode is single-user (see below).

## Hosting (HTTP mode)

`MCP_TRANSPORT=http` serves stateless Streamable HTTP on `:PORT/mcp`, plus `/healthz`. A `Dockerfile` is included (e.g. Azure Container Apps, any container host); provide the configuration as environment variables or secrets instead of `.env`.

**This mode still uses the single refresh token from the configuration: everyone who can reach the endpoint acts as that one user.** Do not expose it to other people as is. A multi-user deployment needs:

1. OAuth at the MCP level, so the client authenticates each user (e.g. against your identity provider),
2. a Zoho *server-based* client instead of a Self Client, so each user grants access once,
3. per-user refresh tokens stored encrypted (e.g. a key vault), looked up from the authenticated identity.

`src/auth.ts` defines a `TokenProvider` interface as the seam for this; only the single-user provider is implemented.

## Development

```
npm install
npm run typecheck
npm run build      # → dist/server.mjs (single bundled file)
npm test           # builds, then runs the tools against a local mock of Zoho + ServiceDesk
```

Source layout: `src/server.ts` (entry, transports), `src/tools.ts` (tool definitions), `src/sdp.ts` (API client, audit), `src/auth.ts` (tokens), `src/config.ts`, `src/dates.ts`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module …\dist\server.mjs` | Wrong path in the client config (often a nested folder after unzipping) |
| `Missing required configuration: …` | `.env` not found or incomplete; check its location or set `SDP_ENV_FILE` |
| `Zoho token refresh failed` | Wrong client id/secret/refresh token, or `ZOHO_ACCOUNTS_URL` of the wrong data centre |
| HTTP 404 or HTML instead of JSON | Wrong `SDP_BASE_URL` or `SDP_PORTAL` |
| `Write refused: project … is not in SDP_WRITE_PROJECT_IDS` | Add the project id and restart the client |
| `… is not a member of project …` | Add the owner as project member in ServiceDesk first |
| Server disconnects unexpectedly | Look for `[lifecycle]` lines in the client's MCP log: they tell whether the client closed the connection, the OS sent a signal, or the server crashed |

## License

MIT — see [LICENSE](LICENSE).
