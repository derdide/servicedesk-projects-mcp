# Changelog

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
