import { createServer } from "node:http";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const AUDIT = join(tmpdir(), `sdp-mcp-audit-${process.pid}.jsonl`);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = [];
let tokenCalls = 0, first401 = true;
const P = "100000000000001", M = "100000000000101";
const mock = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const input = req.method === "GET" ? url.searchParams.get("input_data") : new URLSearchParams(body).get("input_data");
  log.push({ m: req.method, p: url.pathname, auth: req.headers.authorization, accept: req.headers.accept, input: input && JSON.parse(input), form: req.method === "DELETE" ? Object.fromEntries(new URLSearchParams(body)) : undefined });
  const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/oauth/v2/token") { tokenCalls++; return send({ access_token: "tok" + tokenCalls, expires_in: 3600 }); }
  const p = url.pathname.replace("/app/servicedesk/api/v3", "");
  if (p === `/projects/${P}/milestones` && req.method === "GET" && first401) { first401 = false; return send({ error: "expired" }, 401); }
  if (p === `/projects/${P}/project_members`) return send({ project_members: [{ id: "1", role: { name: "Team Member" }, is_active: true, user: { id: "300001", name: "Doe, Jane", email_id: "jane.doe@example.com" } }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/milestones` && req.method === "GET") return send({ milestones: [{ id: M, index: 1, title: "Phase 1 - Preparation", status: { name: "In Progress" }, scheduled_end_time: { value: "1798757999999" } }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/tasks` && req.method === "GET") return send({ tasks: [{ id: "100000000000201", title: "Sandbox migration #1" }], list_info: { has_more_rows: false } });
  if (p === `/projects/${P}/task_dependencies` && req.method === "POST") { const d = JSON.parse(input).task_dependency; return send({ task_dependency: { id: "D" + log.length, ...d } }); }
  if (p === `/projects/${P}/task_dependencies` && req.method === "GET") return send({ task_dependencies: [{ id: "D1", parent_task: { id: "100000000000201", title: "Sandbox migration #1" }, child_task: { id: "T9", title: "ATC" } }] });
  const J = () => JSON.parse(input);
  if (p === `/projects/${P}` && req.method === "GET") return send({ project: { id: P, title: "Old project", status: { name: "Open" }, percentage_completion: 10 } });
  if (p === `/projects/${P}` && req.method === "PUT") return send({ project: { id: P, ...J().project } });
  if (p === `/projects/${P}/project_members` && req.method === "POST") return send({ project_member: { id: "M2", ...J().project_member } });
  if (/\/project_members\/\d+$/.test(p) && req.method === "GET") return send({ project_member: { id: "M2", role: { name: "Team Member" }, is_active: true } });
  if (/\/project_members\/\d+$/.test(p) && req.method === "PUT") return send({ project_member: { id: "M2", ...J().project_member } });
  if (p.endsWith("/worklogs") && req.method === "GET") return send({ worklogs: [{ id: "W1", owner: { id: "300001", name: "Doe, Jane" }, time_spent: { hours: "2", minutes: "30" } }], list_info: { has_more_rows: false } });
  if (p.endsWith("/worklogs") && req.method === "POST") return send({ worklog: { id: "W2", ...J().worklog } });
  if (/\/worklogs\/\d+$/.test(p) && req.method === "GET") return send({ worklog: { id: "W1", description: "old", time_spent: { hours: "1", minutes: "0" } } });
  if (/\/worklogs\/\d+$/.test(p) && req.method === "PUT") return send({ worklog: { id: "W1", ...J().worklog } });
  if (/\/comments\/\d+$/.test(p) && req.method === "GET") return send({ project_comment: { id: "C9", comment: "old text" } });
  if (/\/comments\/\d+$/.test(p) && req.method === "PUT") return send({ project_comment: { id: "C9", ...J().project_comment } });
  if ((p.endsWith("/_request_associations") || p.includes("/rel/")) && ["POST", "DELETE"].includes(req.method)) return send({ response_status: { status_code: 2000, status: "success" } });
  if (p.endsWith("/tasks") && req.method === "POST") { const t = JSON.parse(input).task; return send({ task: { id: String(900000 + log.length), ...t, project: { id: P }, milestone: { id: M, title: "Phase 1" } } }); }
  if (/\/tasks\/\d+$/.test(p) && req.method === "GET") {
    const id = p.split("/").pop();
    return send({ task: { id, title: "Old title", status: { name: "Open" }, percentage_completion: 0, ...(id === "100000000000888" ? {} : { project: { id: id === "100000000000999" ? "100000000000002" : P } }) } });
  }
  if (p.includes("/tasks/") && p.endsWith("/comments")) return send({ task_comment: { id: "C1", comment: JSON.parse(input).task_comment.comment } });
  if (p.includes("/tasks/") && req.method === "PUT") return send({ task: { id: "X", ...JSON.parse(input).task } });
  send({ response_status: { messages: [{ message: "not mocked " + p }] } }, 404);
});
await new Promise(r => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.mjs"], env: { ...process.env,
  SDP_BASE_URL: base, ZOHO_ACCOUNTS_URL: base, ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "rt", SDP_PORTAL: "servicedesk", SDP_STREAM_FIELD: "udf_char1", SDP_TIMEZONE: "Europe/Zurich",
  SDP_WRITE_PROJECT_IDS: P, SDP_AUDIT_LOG: AUDIT }, stderr: "pipe" }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content[0].text };
};
let passed = 0;
const check = (cond, label) => { assert.ok(cond, label); passed++; console.log("ok -", label); };

try {
  check(tools.length === 26 && tools.includes("sdp_add_dependency") && tools.includes("sdp_add_worklog"), `26 tools registered (${tools.length})`);

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

  // ---- regression tests for the security review (v0.5.1) ----
  const puts = () => log.filter((l) => l.m === "PUT").length;
  const before = puts();
  for (const bad of ["../../999/tasks/555", "%2e%2e/%2e%2e/999", "123?x=1", "12/34", ""]) {
    const r = await call("sdp_update_task", { project_id: P, task_id: bad, status: "Closed" });
    check(r.err, `F1: task_id ${JSON.stringify(bad)} refused`);
  }
  const r1 = await call("sdp_create_task", { project_id: P, milestone_id: "../../../requests/42", title: "x" });
  check(r1.err, "F1: traversal through milestone_id refused");
  const r2 = await call("sdp_add_comment", { project_id: P, task_id: "%2e%2e", comment: "x" });
  check(r2.err, "F1: encoded traversal through comment target refused");
  check(puts() === before && !log.some((l) => l.p.includes("..") || l.p.includes("%2e") || l.p.includes("/requests")), "F1: no request left the project paths");
  const other = await call("sdp_update_task", { project_id: P, task_id: "100000000000999", status: "Closed" });
  check(other.err && /belongs to project/.test(other.text) && puts() === before, "F1: task of another project refused before any PUT");
  const noProj = await call("sdp_update_task", { project_id: P, task_id: "100000000000888", status: "Closed" });
  check(noProj.err && /could not confirm/.test(noProj.text) && puts() === before, "R4: task without project information refused (fail closed)");
  const refused2 = await call("sdp_create_task", { project_id: "100000000000002", title: "x" });
  check(refused2.err && !refused2.text.includes(P), "F10: refusal does not reveal writable project ids");

  const bad1 = await call("sdp_create_task", { project_id: P, title: "x", scheduled_end: "2026-02-31" });
  check(bad1.err && /no such calendar date/.test(bad1.text), "F8a: impossible date refused (2026-02-31)");
  const d2 = JSON.parse((await call("sdp_bulk_create_tasks", { project_id: P, tasks: [
    { title: "a", scheduled_start: "2026-09-31" },
    { title: "b", scheduled_start: "2026-10-22T10:00", scheduled_end: "2026-10-22" },
    { title: "c", scheduled_start: "1793487599999", scheduled_end: "2026-10-01" },
    { title: "d", actual_start: "2026-13-01" } ] })).text);
  check(d2.problems.some((x) => x.startsWith("#1")) && !d2.problems.some((x) => x.startsWith("#2")), "F8b: dry run compares dates, not strings");
  check(d2.problems.some((x) => x.startsWith("#3") && /start after/.test(x)), "F8c: epoch start after end detected");
  check(d2.problems.some((x) => x.startsWith("#4")), "F8: actual_* dates validated in dry run");
  const many = await call("sdp_bulk_create_tasks", { project_id: P, tasks: Array.from({ length: 51 }, (_, i) => ({ title: "t" + i })) });
  check(many.err, "F7: more than 50 tasks per call refused");

  const ann = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
  check(ann.sdp_update_task.destructiveHint === true && ann.sdp_update_milestone.destructiveHint === true && ann.sdp_list_tasks.readOnlyHint === true, "F13: update tools flagged destructive");

  const okUpd = await call("sdp_update_task", { project_id: P, task_id: "100000000000201", title: "New title" });
  const auditLines = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const updLine = auditLines.filter((l) => l.op === "update_task" && l.outcome === "ok").at(-1);
  check(!okUpd.err && updLine?.before?.title === "Old title", "F14: audit keeps the before-value of changed fields");
  check(auditLines.some((l) => l.outcome === "refused" && l.op === "update_task"), "F14: refused writes are audited");

  // ---- project-level writes (0.6.0) ----
  const T = "100000000000201", W = "100000000000301";
  const last = (m, suffix) => log.filter((l) => l.m === m && l.p.endsWith(suffix)).at(-1);

  const pu = await call("sdp_update_project", { project_id: P, status: "In Progress", percentage_completion: 40, projected_end: "2026-12-31", owner_email: "jane.doe@example.com" });
  const puBody = last("PUT", `/projects/${P}`)?.input.project;
  check(!pu.err && puBody.status.name === "In Progress" && puBody.percentage_completion === "40" && puBody.owner.id === "300001", "project updated (status, %, owner by email)");
  check(puBody.projected_end.value === "1798757999999", "projected_end = end of day in SDP_TIMEZONE");
  check((await call("sdp_update_project", { project_id: "999", status: "Closed" })).err, "project update outside SDP_WRITE_PROJECT_IDS refused");

  const wl = await call("sdp_add_worklog", { project_id: P, task_id: T, owner_email: "jane.doe@example.com", start: "2026-10-28T09:00", end: "2026-10-28T11:30", hours: 2, minutes: 30, description: "Analysis" });
  const wlBody = last("POST", `/tasks/${T}/worklogs`)?.input.worklog;
  check(!wl.err && wlBody.owner.id === "300001" && wlBody.time_spent.hours === "2" && wlBody.time_spent.minutes === "30", "worklog added on a project task");
  check(Number(wlBody.end_time.value) - Number(wlBody.start_time.value) === 9_000_000, "worklog start/end converted to epoch");
  const wlM = await call("sdp_add_worklog", { project_id: P, milestone_id: M, task_id: T, owner_email: "jane.doe@example.com", hours: 1 });
  check(!wlM.err && !!last("POST", `/milestones/${M}/tasks/${T}/worklogs`), "worklog added on a milestone task");
  check((await call("sdp_add_worklog", { project_id: P, task_id: T, owner_email: "jane.doe@example.com" })).err, "worklog without time refused");
  check(/not a member/.test((await call("sdp_add_worklog", { project_id: P, task_id: T, owner_email: "nobody@example.com", hours: 1 })).text), "worklog owner must be a project member");
  const postsBefore = log.filter((l) => l.m === "POST").length;
  const wlOther = await call("sdp_add_worklog", { project_id: P, task_id: "100000000000999", owner_email: "jane.doe@example.com", hours: 1 });
  check(wlOther.err && /belongs to project/.test(wlOther.text) && log.filter((l) => l.m === "POST").length === postsBefore, "worklog on a task of another project refused before any POST");
  check((await call("sdp_add_worklog", { project_id: P, task_id: T, owner_email: "jane.doe@example.com", start: "2026-10-28T12:00", end: "2026-10-28T11:00" })).err, "worklog start after end refused");
  const wls = JSON.parse((await call("sdp_list_worklogs", { project_id: P, task_id: T })).text);
  check(wls[0].time_spent.hours === 2 && wls[0].time_spent.minutes === 30, "worklogs listed");
  const wu = await call("sdp_update_worklog", { project_id: P, task_id: T, worklog_id: W, description: "new" });
  check(!wu.err && last("PUT", `/worklogs/${W}`)?.input.worklog.description === "new", "worklog updated");

  const cu = await call("sdp_update_comment", { project_id: P, comment_id: "100000000000401", comment: "edited" });
  check(!cu.err && last("PUT", `/projects/${P}/comments/100000000000401`)?.input.project_comment.comment === "edited", "project comment edited");

  const am = await call("sdp_add_project_member", { project_id: P, user_email: "new.person@example.com", role: "Team Member" });
  const amBody = last("POST", `/projects/${P}/project_members`)?.input.project_member;
  check(!am.err && amBody.user.email_id === "new.person@example.com" && amBody.role.name === "Team Member", "project member added by email");
  check((await call("sdp_add_project_member", { project_id: P, user_email: "a@example.com", user_id: "1" })).err, "member: user_email and user_id together refused");
  const um = await call("sdp_update_project_member", { project_id: P, member_id: "100000000000501", active: false });
  check(!um.err && last("PUT", "/project_members/100000000000501")?.input.project_member.is_active === false, "project member deactivated");

  const R = ["100000000000601", "100000000000602"];
  check(!(await call("sdp_attach_requests", { project_id: P, request_ids: R })).err && last("POST", "/_request_associations")?.input.requests[1] === R[1], "requests attached");
  check(!(await call("sdp_detach_requests", { project_id: P, request_ids: R })).err && last("DELETE", "/_request_associations")?.form.ids === R.join(","), "requests detached (ids form field)");
  check(!(await call("sdp_attach_changes", { project_id: P, change_ids: ["100000000000701"] })).err && last("POST", "/rel/initiated_changes")?.input.initiated_changes[0].change.id === "100000000000701", "change caused by project attached");
  check(!(await call("sdp_attach_changes", { project_id: P, change_ids: ["100000000000702"], relation: "initiated_project" })).err && !!last("POST", "/rel/initiated_by_change"), "initiating change attached");
  check(!(await call("sdp_detach_changes", { project_id: P, change_ids: ["100000000000701"] })).err && last("DELETE", "/rel/initiated_changes")?.form.ids === "100000000000701", "change detached");
  check((await call("sdp_attach_requests", { project_id: P, request_ids: ["../1"] })).err, "non-numeric request id refused");
  const ann2 = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
  check(ann2.sdp_detach_requests.destructiveHint && ann2.sdp_update_project.destructiveHint && ann2.sdp_list_worklogs.readOnlyHint, "detach and update tools flagged destructive");
  const pl = JSON.parse((await call("sdp_list_tasks", { project_id: P, project_level_only: true })).text);
  check(pl.length === 1 && pl[0].milestone === null, "project_level_only lists tasks outside milestones");

  console.log(`\n${passed} checks passed`);
} finally {
  await client.close();
  mock.close();
}
