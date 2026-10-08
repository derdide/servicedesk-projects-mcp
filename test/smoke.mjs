import { createServer } from "node:http";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = [];
let tokenCalls = 0, first401 = true;
const P = "100000000000001", M = "100000000000101";
const mock = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const input = req.method === "GET" ? url.searchParams.get("input_data") : new URLSearchParams(body).get("input_data");
  log.push({ m: req.method, p: url.pathname, auth: req.headers.authorization, accept: req.headers.accept, input: input && JSON.parse(input) });
  const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/oauth/v2/token") { tokenCalls++; return send({ access_token: "tok" + tokenCalls, expires_in: 3600 }); }
  const p = url.pathname.replace("/app/servicedesk/api/v3", "");
  if (p === `/projects/${P}/milestones` && req.method === "GET" && first401) { first401 = false; return send({ error: "expired" }, 401); }
  if (p === `/projects/${P}/project_members`) return send({ project_members: [{ id: "1", role: { name: "Team Member" }, is_active: true, user: { id: "300001", name: "Doe, Jane", email_id: "jane.doe@example.com" } }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/milestones` && req.method === "GET") return send({ milestones: [{ id: M, index: 1, title: "Phase 1 - Preparation", status: { name: "In Progress" }, scheduled_end_time: { value: "1798757999999" } }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/tasks` && req.method === "GET") return send({ tasks: [{ id: "100000000000201", title: "Sandbox migration #1" }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/task_dependencies` && req.method === "POST") { const d = JSON.parse(input).task_dependency; return send({ task_dependency: { id: "D" + log.length, ...d } }); }
  if (p === `/projects/${P}/task_dependencies` && req.method === "GET") return send({ task_dependencies: [{ id: "D1", parent_task: { id: "100000000000201", title: "Sandbox migration #1" }, child_task: { id: "T9", title: "ATC" } }] });
  if (p.endsWith("/tasks") && req.method === "POST") { const t = JSON.parse(input).task; return send({ task: { id: "T" + log.length, ...t, milestone: { id: M, title: "Phase 1" } } }); }
  if (p.includes("/tasks/") && p.endsWith("/comments")) return send({ task_comment: { id: "C1", comment: JSON.parse(input).task_comment.comment } });
  if (p.includes("/tasks/") && req.method === "PUT") return send({ task: { id: "X", ...JSON.parse(input).task } });
  send({ response_status: { messages: [{ message: "not mocked " + p }] } }, 404);
});
await new Promise(r => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.mjs"], env: { ...process.env,
  SDP_BASE_URL: base, ZOHO_ACCOUNTS_URL: base, ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "rt", SDP_PORTAL: "servicedesk", SDP_STREAM_FIELD: "udf_char1", SDP_TIMEZONE: "Europe/Zurich",
  SDP_WRITE_PROJECT_IDS: P, SDP_AUDIT_LOG: join(tmpdir(), `sdp-mcp-audit-${process.pid}.jsonl`) }, stderr: "pipe" }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content[0].text };
};
let passed = 0;
const check = (cond, label) => { assert.ok(cond, label); passed++; console.log("ok -", label); };

try {
  check(tools.length === 15 && tools.includes("sdp_add_dependency"), `15 tools registered (${tools.length})`);

  const ms = await call("sdp_list_milestones", { project_id: P });
  check(!ms.err && JSON.parse(ms.text)[0].scheduled_end.startsWith("2026-12-31"), "milestones listed after 401 + token refresh");
  check(tokenCalls === 2, "access token refreshed once after 401");

  const refused = await call("sdp_create_task", { project_id: "999", title: "x" });
  check(refused.err && /Write refused/.test(refused.text), "writes outside SDP_WRITE_PROJECT_IDS refused");

  const dry = JSON.parse((await call("sdp_bulk_create_tasks", { project_id: P, tasks: [
    { title: "Refresh readiness check", milestone_title: "Phase 1 - Preparation", owner_email: "jane.doe@example.com", scheduled_start: "2026-10-01", scheduled_end: "2026-10-31" },
    { title: "Bad owner", milestone_title: "Phase 1 - Preparation", owner_email: "nobody@example.com" },
    { title: "Bad milestone", milestone_title: "M9" } ] })).text);
  check(dry.dry_run && dry.problems.length === 2, "dry run reports unknown owner and unknown milestone");

  const real = JSON.parse((await call("sdp_bulk_create_tasks", { project_id: P, dry_run: false, tasks: [
    { title: "Refresh readiness check", milestone_title: "Phase 1 - Preparation", owner_email: "jane.doe@example.com", scheduled_start: "2026-10-01", scheduled_end: "2026-10-31", priority: "High", estimated_effort_days: 3, stream: "02 - Technical" } ] })).text);
  check(real.created === 1, "bulk create (real) creates the task");
  const post = log.find((l) => l.m === "POST" && l.p.endsWith(`/milestones/${M}/tasks`));
  check(post?.input.task.udf_fields?.udf_char1 === "02 - Technical", "stream written to the configured udf field");
  check(post?.input.task.owner?.id === "300001", "owner resolved by email to member id");
  check(post?.input.task.scheduled_start_time.value === "1790805600000", "start date = 00:00 in SDP_TIMEZONE");
  check(post?.input.task.scheduled_end_time.value === "1793487599999", "end date = 23:59:59.999 in SDP_TIMEZONE (DST handled)");

  const depDry = JSON.parse((await call("sdp_bulk_create_tasks", { project_id: P, tasks: [
    { key: "A", title: "Custom code analysis", milestone_title: "Phase 1 - Preparation", depends_on: ["100000000000201"] },
    { key: "B", title: "Custom code measurement", milestone_title: "Phase 1 - Preparation", depends_on: ["A", "NOPE"] } ] })).text);
  check(depDry.problems.length === 1 && /NOPE/.test(depDry.problems[0]), "dry run flags unknown predecessor");

  const depReal = JSON.parse((await call("sdp_bulk_create_tasks", { project_id: P, dry_run: false, tasks: [
    { key: "A", title: "Custom code analysis", milestone_title: "Phase 1 - Preparation", depends_on: ["100000000000201"] },
    { key: "B", title: "Custom code measurement", milestone_title: "Phase 1 - Preparation", depends_on: ["A"] } ] })).text);
  check(depReal.created === 2 && depReal.dependencies_created === 2, "tasks and dependencies created in one batch");

  const deps = JSON.parse((await call("sdp_list_dependencies", { project_id: P })).text);
  check(deps[0].predecessor.id === "100000000000201", "dependencies listed");

  const upd = await call("sdp_update_task", { project_id: P, milestone_id: M, task_id: "100000000000201", status: "In Progress", percentage_completion: 20, change_note: "Started" });
  check(!upd.err && log.some((l) => l.m === "POST" && l.p.endsWith("/comments")), "update with change_note also posts a comment");

  console.log(`\n${passed} checks passed`);
} finally {
  await client.close();
  mock.close();
}
