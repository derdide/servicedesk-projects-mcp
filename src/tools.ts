import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { SdpClient } from "./sdp.js";
import { fromEpochMs, toEpochMs } from "./dates.js";

type Json = Record<string, any>;

// ---------- result shaping (keeps responses compact) ----------

function user(u: Json | null | undefined) {
  return u ? { id: u.id, name: u.name, email: u.email_id ?? null } : null;
}

function makeShapers(tz: string, streamField?: string) {
  const d = (v: Json | null | undefined) => fromEpochMs(v?.value, tz);
  return {
    project: (p: Json) => ({
      id: p.id,
      display_id: p.display_id?.display_value,
      title: p.title,
      status: p.status?.name,
      priority: p.priority?.name,
      owner: user(p.owner),
      scheduled_start: d(p.scheduled_start_time),
      scheduled_end: d(p.scheduled_end_time),
      projected_end: d(p.projected_end),
      percentage_completion: p.percentage_completion,
      estimated_cost: p.estimated_cost,
      description: p.description,
    }),
    milestone: (m: Json) => ({
      id: m.id,
      index: m.index,
      title: m.title,
      status: m.status?.name,
      owner: user(m.owner),
      scheduled_start: d(m.scheduled_start_time),
      scheduled_end: d(m.scheduled_end_time),
      actual_start: d(m.actual_start_time),
      actual_end: d(m.actual_end_time),
      estimated_hours: m.estimated_hours,
      description: m.description,
    }),
    task: (t: Json) => ({
      id: t.id,
      index: t.index,
      title: t.title,
      milestone: t.milestone ? { id: t.milestone.id, title: t.milestone.title } : null,
      status: t.status?.name,
      priority: t.priority?.name,
      owner: user(t.owner),
      scheduled_start: d(t.scheduled_start_time),
      scheduled_end: d(t.scheduled_end_time),
      actual_start: d(t.actual_start_time),
      actual_end: d(t.actual_end_time),
      percentage_completion: t.percentage_completion,
      estimated_effort_days: t.estimated_effort_days,
      estimated_effort_hours: t.estimated_effort_hours,
      overdue: t.overdue,
      ...(streamField ? { stream: t.udf_fields?.[streamField] ?? null } : {}),
      description: t.description,
    }),
    comment: (c: Json) => ({
      id: c.id,
      comment: c.comment,
      created_by: user(c.created_by),
      created: d(c.created_time),
      parent_id: c.parent_comment?.id ?? null,
    }),
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: (e as Error).message ?? String(e) }] };
}

// ---------- schemas ----------

const dateStr = z
  .string()
  .describe("YYYY-MM-DD (or YYYY-MM-DDTHH:mm), interpreted in the server timezone (SDP_TIMEZONE)");

const taskFields = {
  description: z.string().optional(),
  owner_email: z.string().email().optional().describe("Owner's email; resolved against project members"),
  status: z.string().optional().describe('Status name exactly as in ServiceDesk, e.g. "Open", "In Progress", "Closed"'),
  priority: z.string().optional().describe('Priority name, e.g. "High", "Medium", "Low"'),
  scheduled_start: dateStr.optional(),
  scheduled_end: dateStr.optional(),
  actual_start: dateStr.optional(),
  actual_end: dateStr.optional(),
  percentage_completion: z.number().int().min(0).max(100).optional(),
  estimated_effort_days: z.number().int().min(0).optional(),
  estimated_effort_hours: z.number().int().min(0).optional(),
  stream: z
    .string()
    .optional()
    .describe("Value of the custom grouping field configured in SDP_STREAM_FIELD (e.g. a workstream picklist); must match an allowed value exactly"),
  udf_fields: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe("Other custom fields by API name, e.g. {\"udf_char2\": \"...\"}"),
};

const milestoneFields = {
  description: z.string().optional(),
  owner_email: z.string().email().optional(),
  status: z.string().optional().describe('Project status name, e.g. "Open", "In Progress", "Closed"'),
  priority: z.string().optional(),
  scheduled_start: dateStr.optional(),
  scheduled_end: dateStr.optional(),
  actual_start: dateStr.optional(),
  actual_end: dateStr.optional(),
  estimated_hours: z.number().int().min(0).optional(),
};

// ---------- registration ----------

export function registerTools(server: McpServer, sdp: SdpClient, cfg: Config): void {
  const tz = cfg.timezone;
  const shape = makeShapers(tz, cfg.streamField);

  const assertWritable = (projectId: string) => {
    if (cfg.writeProjectIds === "*") return;
    if (!cfg.writeProjectIds.has(projectId)) {
      throw new Error(
        `Write refused: project ${projectId} is not in SDP_WRITE_PROJECT_IDS. ` +
          `Allowed: ${[...cfg.writeProjectIds].join(", ") || "(none — server is read-only)"}.`,
      );
    }
  };

  const memberCache = new Map<string, { at: number; byEmail: Map<string, Json> }>();
  async function resolveOwner(projectId: string, email: string): Promise<Json> {
    let entry = memberCache.get(projectId);
    if (!entry || Date.now() - entry.at > 5 * 60_000) {
      const members = await sdp.listAll(`/projects/${projectId}/project_members`, "project_members");
      const byEmail = new Map<string, Json>();
      for (const m of members) if (m.user?.email_id) byEmail.set(String(m.user.email_id).toLowerCase(), m.user);
      entry = { at: Date.now(), byEmail };
      memberCache.set(projectId, entry);
    }
    const u = entry.byEmail.get(email.toLowerCase());
    if (!u) {
      throw new Error(
        `${email} is not a member of project ${projectId}. Add them as a project member in ServiceDesk first ` +
          `(sdp_list_project_members shows current members).`,
      );
    }
    return { id: u.id, name: u.name };
  }

  async function buildTaskOrMilestoneBody(projectId: string, a: Json, kind: "task" | "milestone"): Promise<Json> {
    const b: Json = {};
    if (a.title !== undefined) b.title = a.title;
    if (a.description !== undefined) b.description = a.description;
    if (a.owner_email) b.owner = await resolveOwner(projectId, a.owner_email);
    if (a.status) b.status = { name: a.status };
    if (a.priority) b.priority = { name: a.priority };
    if (a.scheduled_start) b.scheduled_start_time = { value: toEpochMs(a.scheduled_start, tz, "start") };
    if (a.scheduled_end) b.scheduled_end_time = { value: toEpochMs(a.scheduled_end, tz, "end") };
    if (a.actual_start) b.actual_start_time = { value: toEpochMs(a.actual_start, tz, "start") };
    if (a.actual_end) b.actual_end_time = { value: toEpochMs(a.actual_end, tz, "end") };
    if (kind === "task") {
      if (a.percentage_completion !== undefined) b.percentage_completion = String(a.percentage_completion);
      if (a.estimated_effort_days !== undefined) b.estimated_effort_days = String(a.estimated_effort_days);
      if (a.estimated_effort_hours !== undefined) b.estimated_effort_hours = String(a.estimated_effort_hours);
      const udf: Json = { ...(a.udf_fields ?? {}) };
      if (a.stream !== undefined) {
        if (!cfg.streamField) throw new Error("stream is not configured: set SDP_STREAM_FIELD (e.g. udf_char1) to use it.");
        udf[cfg.streamField] = a.stream;
      }
      if (Object.keys(udf).length) b.udf_fields = udf;
    } else if (a.estimated_hours !== undefined) {
      b.estimated_hours = String(a.estimated_hours);
    }
    return b;
  }

  const taskPath = (projectId: string, milestoneId?: string) =>
    milestoneId ? `/projects/${projectId}/milestones/${milestoneId}/tasks` : `/projects/${projectId}/tasks`;

  const RO = { readOnlyHint: true, openWorldHint: true } as const;
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  // ----- read -----

  server.registerTool(
    "sdp_list_projects",
    {
      title: "List projects",
      description: "List ServiceDesk projects, optionally filtered by a text contained in the title.",
      inputSchema: { title_contains: z.string().optional(), max: z.number().int().min(1).max(200).default(50) },
      annotations: RO,
    },
    async ({ title_contains, max }) => {
      try {
        const extra = title_contains
          ? { search_criteria: [{ field: "title", condition: "contains", value: title_contains }] }
          : {};
        const list = await sdp.listAll("/projects", "projects", max, extra);
        return ok(list.map(shape.project).map(({ description, ...p }) => p));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_get_project",
    {
      title: "Get project",
      description: "Get one project with its full description.",
      inputSchema: { project_id: z.string() },
      annotations: RO,
    },
    async ({ project_id }) => {
      try {
        const res = await sdp.get(`/projects/${project_id}`);
        return ok(shape.project(res.project as Json));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_list_project_members",
    {
      title: "List project members",
      description: "List members of a project with their project role. Task/milestone owners must be members.",
      inputSchema: { project_id: z.string() },
      annotations: RO,
    },
    async ({ project_id }) => {
      try {
        const list = await sdp.listAll(`/projects/${project_id}/project_members`, "project_members");
        return ok(list.map((m) => ({ member_id: m.id, role: m.role?.name, active: m.is_active, user: user(m.user) })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_list_milestones",
    {
      title: "List milestones",
      description: "List all milestones of a project, in order.",
      inputSchema: { project_id: z.string() },
      annotations: RO,
    },
    async ({ project_id }) => {
      try {
        const list = await sdp.listAll(`/projects/${project_id}/milestones`, "milestones");
        return ok(list.map(shape.milestone).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks of a project (includes milestone tasks), or only the tasks of one milestone. " +
        "Use include_description=false for compact overviews.",
      inputSchema: {
        project_id: z.string(),
        milestone_id: z.string().optional(),
        include_description: z.boolean().default(false),
        max: z.number().int().min(1).max(1000).default(500),
      },
      annotations: RO,
    },
    async ({ project_id, milestone_id, include_description, max }) => {
      try {
        const list = await sdp.listAll(taskPath(project_id, milestone_id), "tasks", max);
        const shaped = list.map(shape.task);
        return ok(include_description ? shaped : shaped.map(({ description, ...t }) => t));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_get_task",
    {
      title: "Get task",
      description: "Get one task. Pass milestone_id if the task belongs to a milestone (it is shown in sdp_list_tasks).",
      inputSchema: { project_id: z.string(), task_id: z.string(), milestone_id: z.string().optional() },
      annotations: RO,
    },
    async ({ project_id, task_id, milestone_id }) => {
      try {
        const res = await sdp.get(`${taskPath(project_id, milestone_id)}/${task_id}`);
        return ok(shape.task(res.task as Json));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_get_task_field_options",
    {
      title: "Get task field options",
      description:
        "Allowed values of a task picklist field: the stream field configured in SDP_STREAM_FIELD (default), status, priority, or any udf_* field. " +
        "Use before setting stream on tasks.",
      inputSchema: { field: z.string().default("stream").describe('"stream", "status", "priority", or a udf_* API name') },
      annotations: RO,
    },
    async ({ field }) => {
      try {
        const f = field === "stream" ? cfg.streamField : field;
        if (!f) throw new Error("stream is not configured: set SDP_STREAM_FIELD or pass a udf_* field name.");
        if (f.startsWith("udf_")) {
          const meta = await sdp.get("/tasks/_metainfo");
          const def = (meta as Json).metainfo?.fields?.udf_fields?.fields?.[f];
          if (!def) throw new Error(`Custom field ${f} not found on tasks`);
          const res = await sdp.get(`/tasks/udf_fields/${def.id}/allowed_values`).catch(async () => sdp.get(`/tasks/udf_fields/${def.id}`));
          return ok({ field: f, name: def.display_name, default: def.default_value, raw: res });
        }
        const res = await sdp.get(`/tasks/_metainfo/fields/${f}/allowed_values`).catch(async () => sdp.get(`/tasks/${f}`));
        return ok({ field: f, raw: res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_list_comments",
    {
      title: "List comments",
      description:
        "List comments on a project (project_id only), a milestone (+milestone_id), a project task (+task_id) " +
        "or a milestone task (+milestone_id +task_id).",
      inputSchema: { project_id: z.string(), milestone_id: z.string().optional(), task_id: z.string().optional() },
      annotations: RO,
    },
    async ({ project_id, milestone_id, task_id }) => {
      try {
        const { path, root } = commentTarget(project_id, milestone_id, task_id);
        const res = await sdp.get(path);
        const key = Object.keys(res).find((k) => Array.isArray(res[k]) && k !== "response_status") ?? root + "s";
        return ok(((res[key] as Json[]) ?? []).map(shape.comment));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----- write (create / update only; no delete by design) -----

  server.registerTool(
    "sdp_create_milestone",
    {
      title: "Create milestone",
      description: "Create a milestone in a project. Only allowed for projects listed in SDP_WRITE_PROJECT_IDS.",
      inputSchema: { project_id: z.string(), title: z.string(), ...milestoneFields },
      annotations: RW,
    },
    async (a) => {
      try {
        assertWritable(a.project_id);
        const body = await buildTaskOrMilestoneBody(a.project_id, a, "milestone");
        const res = await sdp.post(`/projects/${a.project_id}/milestones`, { milestone: body });
        const m = res.milestone as Json;
        sdp.audit({ op: "create_milestone", project_id: a.project_id, milestone_id: m?.id, fields: Object.keys(body) });
        return ok(shape.milestone(m));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_update_milestone",
    {
      title: "Update milestone",
      description: "Update fields of an existing milestone. Only the fields you pass are changed.",
      inputSchema: { project_id: z.string(), milestone_id: z.string(), title: z.string().optional(), ...milestoneFields },
      annotations: { ...RW, idempotentHint: true },
    },
    async (a) => {
      try {
        assertWritable(a.project_id);
        const body = await buildTaskOrMilestoneBody(a.project_id, a, "milestone");
        if (!Object.keys(body).length) throw new Error("Nothing to update.");
        const res = await sdp.put(`/projects/${a.project_id}/milestones/${a.milestone_id}`, { milestone: body });
        sdp.audit({ op: "update_milestone", project_id: a.project_id, milestone_id: a.milestone_id, fields: Object.keys(body) });
        return ok(shape.milestone(res.milestone as Json));
      } catch (e) {
        return fail(e);
      }
    },
  );

  async function createTask(a: Json): Promise<Json> {
    const body = await buildTaskOrMilestoneBody(a.project_id, a, "task");
    body.template = { name: a.template ?? cfg.defaultTaskTemplate };
    const res = await sdp.post(taskPath(a.project_id, a.milestone_id), { task: body });
    const t = res.task as Json;
    sdp.audit({ op: "create_task", project_id: a.project_id, milestone_id: a.milestone_id ?? null, task_id: t?.id, title: a.title });
    return shape.task(t);
  }

  server.registerTool(
    "sdp_create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project, under a milestone if milestone_id is given (recommended). " +
        "Owner must be a project member.",
      inputSchema: {
        project_id: z.string(),
        milestone_id: z.string().optional(),
        title: z.string(),
        template: z.string().optional().describe('Task template name; defaults to "Default Task"'),
        ...taskFields,
      },
      annotations: RW,
    },
    async (a) => {
      try {
        assertWritable(a.project_id);
        return ok(await createTask(a));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_bulk_create_tasks",
    {
      title: "Bulk create tasks",
      description:
        "Create many tasks at once (e.g. a work breakdown under several milestones). Each task names its milestone " +
        "by milestone_id or exact milestone_title. dry_run=true (default) validates and returns the plan without " +
        "creating anything — always show the dry run to the user before running with dry_run=false. " +
        "Tasks may declare predecessors with depends_on (batch keys or existing task ids); dependencies are created after the tasks.",
      inputSchema: {
        project_id: z.string(),
        dry_run: z.boolean().default(true),
        tasks: z
          .array(
            z.object({
              title: z.string(),
              milestone_id: z.string().optional(),
              milestone_title: z.string().optional(),
              template: z.string().optional(),
              key: z.string().optional().describe("Short local reference (e.g. \"T3\") so other tasks in this batch can depend on it"),
              depends_on: z
                .array(z.string())
                .optional()
                .describe("Predecessors: keys of tasks in this batch, or ids of existing tasks. This task starts after them."),
              ...taskFields,
            }),
          )
          .min(1)
          .max(200),
      },
      annotations: RW,
    },
    async ({ project_id, dry_run, tasks }) => {
      try {
        assertWritable(project_id);
        const milestones = await sdp.listAll(`/projects/${project_id}/milestones`, "milestones");
        const byTitle = new Map(milestones.map((m) => [String(m.title).trim().toLowerCase(), String(m.id)]));
        const ids = new Set(milestones.map((m) => String(m.id)));
        const plan: Json[] = [];
        const problems: string[] = [];
        const keys = new Set(tasks.map((t) => t.key).filter(Boolean) as string[]);
        if (keys.size !== tasks.filter((t) => t.key).length) problems.push("Duplicate task keys in batch");
        const needExisting = tasks.some((t) => (t.depends_on ?? []).some((d) => !keys.has(d)));
        const existingIds = needExisting
          ? new Set((await sdp.listAll(`/projects/${project_id}/tasks`, "tasks")).map((t) => String(t.id)))
          : new Set<string>();
        for (const [i, t] of tasks.entries()) {
          for (const d of t.depends_on ?? []) {
            if (!keys.has(d) && !existingIds.has(d)) problems.push(`#${i + 1} "${t.title}": predecessor "${d}" is neither a batch key nor an existing task id`);
            if (d === t.key) problems.push(`#${i + 1} "${t.title}": depends on itself`);
          }
          let mid = t.milestone_id;
          if (!mid && t.milestone_title) mid = byTitle.get(t.milestone_title.trim().toLowerCase());
          if (t.milestone_title && !mid) problems.push(`#${i + 1} "${t.title}": milestone "${t.milestone_title}" not found`);
          if (mid && !ids.has(mid)) problems.push(`#${i + 1} "${t.title}": milestone id ${mid} not in project`);
          if (t.owner_email) {
            try {
              await resolveOwner(project_id, t.owner_email);
            } catch (e) {
              problems.push(`#${i + 1} "${t.title}": ${(e as Error).message}`);
            }
          }
          for (const k of ["scheduled_start", "scheduled_end"] as const) {
            if (t[k]) {
              try {
                toEpochMs(t[k]!, tz);
              } catch (e) {
                problems.push(`#${i + 1} "${t.title}": ${(e as Error).message}`);
              }
            }
          }
          if (t.scheduled_start && t.scheduled_end && t.scheduled_start > t.scheduled_end) {
            problems.push(`#${i + 1} "${t.title}": start after end`);
          }
          plan.push({ ...t, milestone_id: mid ?? null });
        }
        if (dry_run || problems.length) {
          return ok({ dry_run: true, would_create: plan.length, problems, plan });
        }
        const created: Json[] = [];
        const failed: Json[] = [];
        const idByKey = new Map<string, string>();
        const createdPlan: { t: Json; id: string }[] = [];
        for (const t of plan) {
          try {
            const { key, depends_on, ...fields } = t;
            const task = await createTask({ ...fields, project_id, milestone_id: t.milestone_id ?? undefined });
            created.push(task);
            if (key) idByKey.set(key, String(task.id));
            createdPlan.push({ t, id: String(task.id) });
          } catch (e) {
            failed.push({ title: t.title, error: (e as Error).message });
          }
        }
        const deps: Json[] = [];
        const depFailed: Json[] = [];
        for (const { t, id } of createdPlan) {
          for (const d of t.depends_on ?? []) {
            const parent = idByKey.get(d) ?? (keys.has(d) ? undefined : d);
            if (!parent) {
              depFailed.push({ child: t.title, predecessor: d, error: "predecessor task was not created" });
              continue;
            }
            try {
              deps.push(await addDependency(project_id, parent, id));
            } catch (e) {
              depFailed.push({ child: t.title, predecessor: d, error: (e as Error).message });
            }
          }
        }
        return ok({
          created: created.length,
          failed,
          dependencies_created: deps.length,
          dependencies_failed: depFailed,
          tasks: created.map(({ description, ...x }) => x),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Task dependencies (predecessor → successor). Endpoint mirrors the documented request-task API
  // (/requests/{id}/task_dependencies, root key task_dependency with parent_task/child_task).
  const depPath = (projectId: string) => `/projects/${projectId}/task_dependencies`;

  async function addDependency(projectId: string, parentId: string, childId: string): Promise<Json> {
    if (parentId === childId) throw new Error("A task cannot depend on itself.");
    const res = await sdp.post(depPath(projectId), {
      task_dependency: { parent_task: { id: parentId }, child_task: { id: childId } },
    });
    const dep = (res.task_dependency as Json) ?? res;
    sdp.audit({ op: "add_dependency", project_id: projectId, parent_task_id: parentId, child_task_id: childId, dependency_id: dep?.id });
    return {
      id: dep?.id ?? null,
      predecessor: { id: parentId, title: dep?.parent_task?.title ?? null },
      successor: { id: childId, title: dep?.child_task?.title ?? null },
    };
  }

  server.registerTool(
    "sdp_list_dependencies",
    {
      title: "List task dependencies",
      description: "List all task dependencies of a project (predecessor → successor).",
      inputSchema: { project_id: z.string() },
      annotations: RO,
    },
    async ({ project_id }) => {
      try {
        const res = await sdp.get(depPath(project_id), { list_info: { row_count: 100, start_index: 1 } });
        const list = ((res.task_dependencies as Json[]) ?? []).map((d) => ({
          id: d.id,
          predecessor: { id: d.parent_task?.id, title: d.parent_task?.title ?? d.parent_task?.name ?? null },
          successor: { id: d.child_task?.id, title: d.child_task?.title ?? d.child_task?.name ?? null },
        }));
        return ok(list);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_add_dependency",
    {
      title: "Add task dependency",
      description:
        "Make one task depend on another: the successor starts after the predecessor. Use task ids from sdp_list_tasks.",
      inputSchema: {
        project_id: z.string(),
        predecessor_task_id: z.string(),
        successor_task_id: z.string(),
      },
      annotations: RW,
    },
    async ({ project_id, predecessor_task_id, successor_task_id }) => {
      try {
        assertWritable(project_id);
        return ok(await addDependency(project_id, predecessor_task_id, successor_task_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_update_task",
    {
      title: "Update task",
      description:
        "Update fields of an existing task (status, dates, owner, % complete, ...). Only the fields you pass are " +
        "changed. Pass milestone_id when the task belongs to a milestone. Optionally add a comment explaining the change.",
      inputSchema: {
        project_id: z.string(),
        task_id: z.string(),
        milestone_id: z.string().optional(),
        title: z.string().optional(),
        ...taskFields,
        change_note: z.string().optional().describe("If given, also posted as a comment on the task"),
      },
      annotations: { ...RW, idempotentHint: true },
    },
    async (a) => {
      try {
        assertWritable(a.project_id);
        const body = await buildTaskOrMilestoneBody(a.project_id, a, "task");
        if (!Object.keys(body).length && !a.change_note) throw new Error("Nothing to update.");
        let task: Json | undefined;
        if (Object.keys(body).length) {
          const res = await sdp.put(`${taskPath(a.project_id, a.milestone_id)}/${a.task_id}`, { task: body });
          task = res.task as Json;
          sdp.audit({ op: "update_task", project_id: a.project_id, task_id: a.task_id, fields: Object.keys(body) });
        }
        if (a.change_note) {
          const { path, root } = commentTarget(a.project_id, a.milestone_id, a.task_id);
          await sdp.post(path, { [root]: { comment: a.change_note } });
          sdp.audit({ op: "add_comment", project_id: a.project_id, task_id: a.task_id });
        }
        return ok(task ? shape.task(task) : { comment_added: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sdp_add_comment",
    {
      title: "Add comment",
      description:
        "Add a comment to a project (project_id only), a milestone (+milestone_id), a project task (+task_id) " +
        "or a milestone task (+milestone_id +task_id). HTML allowed. Use for status notes and decisions.",
      inputSchema: {
        project_id: z.string(),
        milestone_id: z.string().optional(),
        task_id: z.string().optional(),
        comment: z.string(),
        parent_comment_id: z.string().optional().describe("Reply to an existing comment"),
      },
      annotations: RW,
    },
    async ({ project_id, milestone_id, task_id, comment, parent_comment_id }) => {
      try {
        assertWritable(project_id);
        const { path, root } = commentTarget(project_id, milestone_id, task_id);
        const body: Json = { comment };
        if (parent_comment_id) body.parent_comment = { id: parent_comment_id };
        const res = await sdp.post(path, { [root]: body });
        sdp.audit({ op: "add_comment", project_id, milestone_id: milestone_id ?? null, task_id: task_id ?? null });
        return ok(shape.comment((res[root] as Json) ?? {}));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

function commentTarget(projectId: string, milestoneId?: string, taskId?: string): { path: string; root: string } {
  if (taskId && milestoneId)
    return { path: `/projects/${projectId}/milestones/${milestoneId}/tasks/${taskId}/comments`, root: "task_comment" };
  if (taskId) return { path: `/projects/${projectId}/tasks/${taskId}/comments`, root: "task_comment" };
  if (milestoneId) return { path: `/projects/${projectId}/milestones/${milestoneId}/comments`, root: "milestone_comment" };
  return { path: `/projects/${projectId}/comments`, root: "project_comment" };
}
