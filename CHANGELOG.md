# Changelog

## Unreleased
- `deploy/compose/` and [docs/self-host.md](docs/self-host.md): Docker Compose example for self-hosting (Caddy or Cloudflare Tunnel), e.g. to test the hosted mode end to end.

## 0.5.3 — 2026-10-16
- `@modelcontextprotocol/sdk` 1.30.1 → 1.32.1 (advisory GHSA-6qxp-vccf-f47h, high; it concerns the SDK's OAuth *client*, which this server does not use, but `npm audit` rightly blocks CI). `zod` 4.6.7, `@types/node` 26.6.5.

## 0.5.2 — 2026-10-16
Fixes from a second independent review (of 0.5.1).
- **OAuth facade:** repeated parameters refused (a second `client_id` could previously slip past the check); only a fixed set of parameters is forwarded to Zoho; `response_type=code` only; PKCE, if sent, must be S256; `prompt=consent` always.
- `/mcp` accepts POST only; GET and DELETE answer `405` (no never-ending SSE streams).
- Zoho outage or 5xx during the token check → `503 Retry-After`, no longer cached as a bad token.
- Per-IP rate limit counts anonymous traffic only; signed-in users are limited per user (they share Anthropic's or Microsoft's addresses).
- Updates refused when ServiceDesk does not say which project a task or milestone belongs to (fail closed).
- `SDP_TIMEZONE` validated at startup.
- Docs: single time zone for all users documented; security model states that the allow-list on `/mcp`, not the facade, decides access; Node ≥ 20 in README; build target node20.

## 0.5.1 — 2026-10-16
Security fixes from an independent review of 0.5.0.
- **IDs are numeric-only** and URL-encoded; the API client refuses any non-plain path. Path traversal through `task_id`, `milestone_id` or comment targets (which could reach other projects, other modules or other portals) is no longer possible. Updates first read the record and refuse if it belongs to another project.
- HTTP mode: JSON-RPC batches refused, 256 KB body limit on `/mcp`; per-IP rate limit before authentication; rejected tokens cached for 60 s; token check cache 60 s (was 300 s) and evicted when ServiceDesk rejects a token; `Host`/`Origin` checks; timeouts on all outbound calls.
- HTTP mode fails closed: refuses to start without `ALLOWED_EMAIL_DOMAINS`/`ALLOWED_USERS` (or explicit `ALLOW_ANY_ZOHO_USER=true`); numeric settings validated at startup.
- OAuth facade accepts only `ZOHO_CLIENT_ID`; HTTP Basic client credentials parsed correctly (secrets containing `:`), malformed ones answered with 401; Basic + form credentials together refused; query strings never logged.
- Dates: impossible calendar dates refused (no more silent roll-over); dry runs compare real timestamps and validate all date fields.
- Bulk create: at most 50 tasks per call, stops when the client disconnects, batch id in the audit.
- Update tools flagged `destructiveHint: true`; refusals do not reveal writable project ids.
- Audit: every write attempt with outcome (`ok` / `refused` / `failed` / `stopped`), the resolved project, and the previous values of changed fields.
- Dockerfile builds from source (multi-stage); `.dockerignore`; CI workflow and Dependabot; Node ≥ 20.
- README: security model (token passthrough, prompt injection, what the guard-rails cover).

## 0.5.0 — 2026-10-16
- **Multi-user HTTP mode.** Each user signs in with their own Zoho/ServiceDesk account through their AI client (Claude, Microsoft 365 Copilot declarative agent, Copilot Studio); the server forwards the user's token and stores no tokens or secrets.
- OAuth discovery (RFC 9728 protected resource metadata, RFC 8414 authorization server metadata) and a facade in front of Zoho: `access_type=offline`, scope normalisation, `resource` parameter stripped, Zoho errors mapped to RFC 6749 codes.
- Token check against Zoho user-info (cached), `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_USERS`, per-user rate limit, user e-mail in every audit line.
- `SDP_TASK_TEMPLATES`: task template per project.
- Docs: Zoho client set-up and check script, Azure Container Apps deployment and hardening, client set-up for Claude / Copilot / Copilot Studio.
- HTTP-mode test suite (18 checks).

## 0.4.1 — 2026-10-08
- Removed `sdp_get_task_field_options`: the metadata endpoint needs a broader OAuth scope than the projects scopes this server asks for.
- Task dependencies verified against a live instance (create and list); README status updated.

## 0.4.0 — 2026-10-07
- First public release. All organisation-specific defaults removed: `SDP_BASE_URL` and `SDP_PORTAL` are now required; `ZOHO_ACCOUNTS_URL` defaults to the US data centre, `SDP_TIMEZONE` to UTC, `SDP_DEFAULT_TASK_TEMPLATE` to "Default Task".
- `stream` is opt-in: set `SDP_STREAM_FIELD` to the `udf_*` field to expose.
- Test suite rewritten with assertions (`npm test`).

## 0.3.0 — 2026-09-29
- Task dependencies: `sdp_list_dependencies`, `sdp_add_dependency`, and `key` / `depends_on` in `sdp_bulk_create_tasks` (validated in the dry run, created after the tasks).

## 0.2.0 — 2026-09-29
- `stream` parameter mapped to a task custom field; generic `udf_fields` on create/update.
- `sdp_get_task_field_options` (allowed values of a picklist field).
- Configurable default task template.

## 0.1.1 — 2026-09-28
- Lifecycle diagnostics on stderr: start, stdin closed, signals, crashes, exit code.

## 0.1.0 — 2026-09-25
- Read projects, milestones, tasks, members, comments; create/update milestones and tasks; comments; bulk create with dry run.
- Write allow-list per project, audit log, no delete operations.
- stdio transport (local) and stateless Streamable HTTP (for container hosting).
