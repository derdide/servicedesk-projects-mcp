# The Zoho OAuth client (multi-user mode)

All AI clients — Claude, Microsoft 365 Copilot, Copilot Studio — sign users in through **one** Zoho OAuth client. Each client gets its own copy of the client ID and secret; the MCP server itself does not need them.

## 1. Create it

1. Open the Zoho API console of your data centre (EU: https://api-console.zoho.eu, US: https://api-console.zoho.com, …).
2. **Add Client** → **Server-based Applications** (not *Self Client*, which is the single-user type).
3. Fill in:
   - **Client name** — e.g. "ServiceDesk projects MCP"
   - **Homepage URL** — any valid URL, e.g. your MCP server's `PUBLIC_BASE_URL`
   - **Authorized redirect URIs** — one line per AI client you will connect:

     | Client | Redirect URI |
     |---|---|
     | Claude (web, desktop, mobile, Cowork) | `https://claude.ai/api/mcp/auth_callback` |
     | Microsoft 365 Copilot (declarative agent) | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` |
     | Copilot Studio | shown by Copilot Studio when you add the MCP tool — add it then |
     | Check script (optional) | `http://localhost:8765/callback` |
4. Create, and keep the **Client ID** and **Client Secret** somewhere safe (a password manager or a key vault).

## 2. Verify it (optional, 10 minutes)

[`zoho-oauth-check.ps1`](zoho-oauth-check.ps1) signs you in exactly as the AI clients will (authorization code + PKCE S256 + `access_type=offline`) and prints PASS/FAIL lines only, no tokens:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\zoho-oauth-check.ps1
```

It checks: Zoho's discovery document and PKCE support, the code exchange, that a refresh token is issued, that ServiceDesk accepts the user's token, that the user's e-mail can be read (audit log), refresh, and — optionally — that a wrong PKCE verifier is rejected.

Expected result (Zoho EU, October 2026): everything PASS except *Registration endpoint (DCR)*, which Zoho does not offer. That is why each AI client is given the client ID and secret explicitly instead of registering itself.

## 3. Scopes

The server requests, by default (`ZOHO_SCOPES`):

| Scope | Why |
|---|---|
| `SDPOnDemand.projects.READ`, `.CREATE`, `.UPDATE` | the tools — deliberately no `.DELETE` |
| `AaaServer.profile.READ` | the user's e-mail, for the allow-list and the audit log |

## Notes

- Zoho issues a refresh token only when the sign-in carries `access_type=offline`. MCP clients do not send it; the server's `/oauth/authorize` adds it. Configure every client to use the **server's** authorize and token URLs, not Zoho's.
- Zoho does not rotate refresh tokens. The clients are confidential (they hold the client secret), so this is acceptable under OAuth 2.1.
- A user revokes access in Zoho under *My account → Connected apps*; an administrator revokes it for everyone by deleting the client.
