# Connect the AI clients (multi-user mode)

All three use the same server and the same Zoho client ([zoho-client.md](zoho-client.md)). Replace `https://mcp.example.com` with your `PUBLIC_BASE_URL`.

| Setting | Value |
|---|---|
| MCP server URL | `https://mcp.example.com/mcp` |
| Authorization URL | `https://mcp.example.com/oauth/authorize` |
| Token URL / refresh URL | `https://mcp.example.com/oauth/token` |
| Scopes | `SDPOnDemand.projects.READ SDPOnDemand.projects.CREATE SDPOnDemand.projects.UPDATE AaaServer.profile.READ` |
| Client ID / secret | from the Zoho client |

Use the server's authorization and token URLs, **not Zoho's**: the server adds `access_type=offline`, without which users would have to sign in again every hour.

Menus and screens of these products change often; the steps below describe what to configure, not every click.

## Claude (web, desktop, mobile, Cowork)

1. An organization Owner adds a **custom connector**: URL `https://mcp.example.com/mcp`.
2. Under the advanced/authentication settings, enter the Zoho **client ID** and **client secret** (Zoho offers no dynamic client registration, so this is required).
3. Each user connects once; the sign-in goes to Zoho (and your SSO). Claude discovers the authorization and token URLs itself from the server's metadata.

Reference: [Claude connector authentication](https://claude.com/docs/connectors/building/authentication).

## Microsoft 365 Copilot — declarative agent

A declarative agent is a Copilot agent with your instructions and this server as its tool, deployed to users like an app.

1. In VS Code, install the **Microsoft 365 Agents Toolkit**, create a **declarative agent**, and add an action from an **MCP server** with URL `https://mcp.example.com/mcp`.
2. Authentication: **OAuth (static registration)** — authorization URL, token URL, refresh URL and scopes from the table above, plus the Zoho client ID and secret. The toolkit registers this in the Teams Developer Portal; the redirect URI to allow in Zoho is `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`.
3. Write the agent's instructions. Suggested core:
   > You maintain ServiceDesk projects for the signed-in user. Before creating several tasks, call `sdp_bulk_create_tasks` with `dry_run=true`, show the plan, and only run it with `dry_run=false` after the user confirms. Use dates as YYYY-MM-DD. Never claim a change was made unless the tool returned it.
4. **Provision** to test (sideloaded for you only), then hand the package to your Microsoft 365 admin for deployment to a user group (admin center → integrated apps).

Reference: [Build a plugin for a declarative agent from an MCP server](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins). Check licensing: users without a Microsoft 365 Copilot licence may be billed per use for agents.

## Copilot Studio

1. In the agent: **Tools → Add a tool → Model Context Protocol** (wording may vary), server URL `https://mcp.example.com/mcp`.
2. Authentication: **OAuth 2.0, manual** — client ID, client secret, authorization URL, token URL, refresh URL, scopes from the table above.
3. Copilot Studio shows a **redirect URL**: add it to the Zoho client's redirect URIs.
4. Publish the agent to Teams / Microsoft 365 Copilot as needed. Copilot Studio usage is billed in Copilot credits.

Reference: [Copilot Developer Camp — MCP with OAuth](https://microsoft.github.io/copilot-camp/pages/make/copilot-studio/10-mcp-oauth/).

## What users see

The first time the agent or Claude calls a tool, the user is asked to sign in (Zoho → your SSO) and to approve the scopes. After that, tokens are renewed in the background. Every change appears in ServiceDesk under the user's own name.
