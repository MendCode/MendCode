import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type WorkflowId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { httpOpenApi } from "../src/http"
import { nativeWorkflowPlan } from "../src/workflow-rest-plan"

const ids = createIdFactory(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const donor = (prompt = "Verify the local adapter") => ({
  formatVersion: 1 as const, name: "HTTP parity", description: "Local fixture", objective: "Verify the workflow API",
  phases: [{ id: "Review", ordinal: 1, name: "Review", barrier: { kind: "all" as const }, taskIDs: ["Final"] }],
  tasks: [{ id: "Final", phaseID: "Review", name: "Review routes", kind: "synthesize" as const, prompt, dependsOn: [], output: { kind: "text" as const } }],
  finalTaskID: "Final", completionCriteria: ["Routes verified"], requiredGates: [],
})
async function boot(options: { failFirst?: boolean; hold?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b86-"))), project = path.join(dir, "project")
  mkdirSync(project)
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const tokens = remoteTokens(dir), token = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const attempts = new Map<string, number>()
  const start = () => startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, http: { enabled: true }, httpListen: false,
    models: { selectable: true, list: () => [{ id: "echo", name: "Echo", efforts: [], provider: "faux" }], defaults: { model: "echo" } },
    engine: ({ clock }) => {
      const engine = createFauxEngine({ clock, deltaMs: 1 })
      engine.runTurn = async (input) => {
        await Bun.sleep(1)
        if (options.hold && input.text.includes("hold-for-b86")) {
          await new Promise<void>((resolve) => { if (input.signal.aborted) resolve(); else input.signal.addEventListener("abort", () => resolve(), { once: true }) })
          return { status: "ok" }
        }
        const count = (attempts.get(input.sessionId) ?? 0) + 1
        attempts.set(input.sessionId, count)
        if (options.failFirst && count === 1 && !input.text.includes("[audit of workflow")) return { status: "error", code: "local_fixture_failure", message: "Retry this local task" }
        const itemId = input.newItemId()
        if (input.text.includes("[audit of workflow")) {
          const read = input.newItemId()
          input.emit({ type: "item.started", itemId: read, kind: "tool_call", meta: { tool: "read", path: "fixture.md" } })
          input.emit({ type: "item.completed", itemId: read, status: "ok", text: "Local route fixture inspected" })
        }
        input.emit({ type: "item.started", itemId, kind: "agent_message" })
        input.emit({ type: "item.completed", itemId, status: "ok", text: input.text.includes("[audit of workflow") ? "```AUDIT_VERDICT\nverdict: pass\ncriteria:\n- criterion-1: pass — fixture.md:1\nfindings: Local fixture checked\n```" : "```WORKFLOW_OUTPUT\nLocal route verified\n```\n```TASK_RESULT\nstatus: done\nsummary: Local route verified\n```" })
        return { status: "ok" }
      }
      return engine
    },
  })
  let daemon = await start()
  cleanup.push(() => daemon.stop())
  const request = async (route: string, options: { value?: unknown; method?: string; token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${options.token ?? token}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
    if (!response) throw new Error("unexpected upgrade")
    return response
  }
  const command = (value: Record<string, unknown>, headers?: Record<string, string>) => request("/command", { value: { id: ids("command"), clientId: ids("client"), ...value }, ...(headers ? { headers } : {}) })
  return { get daemon() { return daemon }, request, command, dir, project, observer, token, async restart() { await daemon.stop(); daemon = await start() } }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) { if (Date.now() >= deadline) throw new Error("B86 local workflow deadline"); await Bun.sleep(2) }
}
async function start(h: Awaited<ReturnType<typeof boot>>, plan: unknown = donor()) {
  const response = await h.request("/workflow/start", { value: { plan } })
  expect(response.status).toBe(200)
  return response.json()
}

test("B86 preview validates donor/native plans without loading the runner or creating sessions", async () => {
  const h = await boot()
  const response = await h.request("/workflow/preview", { value: { plan: { ...donor(), model: { providerID: "faux", modelID: "echo" }, budget: { maxTokens: 2000, maxCost: 1, maxConcurrency: 1 } } } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ phaseCount: 1, taskCount: 1, taskUpperBound: 1, maxConcurrency: 1, maxFanOut: 1, estimatedTokenLimit: 2000, estimatedCostLimit: 1 })
  expect(h.daemon.workflowsLoaded()).toBe(false)
  expect(h.daemon.store.listSessions()).toHaveLength(0)
  const invalid = donor(); invalid.tasks[0]!.dependsOn = ["Missing"] as never
  expect((await h.request("/workflow/preview", { value: { plan: invalid } })).status).toBe(400)
  expect((await h.request("/workflow/preview", { value: { plan: { ...donor(), model: { providerID: "wrong", modelID: "echo" } } } })).status).toBe(400)
})

test("B86 save preserves immutable donor JSON, revision metadata and owner; restart rehydrates receipts", async () => {
  const h = await boot()
  const owner = await (await h.request("/session", { value: { title: "Owner" } })).json()
  const saved = await (await h.request("/workflow/save", { value: { plan: donor(), ownerSessionID: owner.id, saved: true } })).json()
  expect(typeof saved.definitionID).toBe("string")
  expect(typeof saved.revisionID).toBe("string")
  expect(structuredClone(saved)).toMatchObject({ revision: 1, plan: donor(), preview: { taskCount: 1 } })
  expect(h.daemon.workflowsLoaded()).toBe(false)
  const revised = await h.request("/workflow/save", { value: { plan: { ...donor(), name: "Updated" }, definitionID: saved.definitionID } })
  const second = await revised.json()
  if (!revised.ok) throw new Error(`B86 revision save ${revised.status}: ${JSON.stringify(second)}`)
  expect(second.revision).toBe(2)
  await h.restart()
  const started = await (await h.request("/workflow/start", { value: { revisionID: saved.revisionID } })).json()
  expect(started.revision.plan).toEqual(donor())
  expect(started.definition.ownerSessionID).toBe(owner.id)
  expect(started.run.revisionID).toBe(saved.revisionID)
  expect(started.definition.currentRevision).toBe(2)
  const firstRun = started.run.id as WorkflowId
  await until(() => h.daemon.store.workflows.all().find((run) => run.workflowId === firstRun)?.state === "completed")
  expect((await h.request("/workflow/start", { value: { definitionID: saved.definitionID } })).status).toBe(200)
}, 10_000)

test("B86 start/list/show/events/artifacts reflect real completion and bounded durable output evidence", async () => {
  const h = await boot(), initial = await start(h), id = initial.run.id as WorkflowId
  await until(() => h.daemon.store.workflows.all().find((run) => run.workflowId === id)?.state === "completed")
  const shown = await (await h.request(`/workflow/${id}`)).json()
  expect(shown).toMatchObject({ run: { id, state: "completed" }, tasks: [{ id: "Final", phaseID: "Review", state: "completed", value: { kind: "text", value: "Local route verified\n" } }], phases: [{ id: "Review", counts: { total: 1, completed: 1 } }] })
  expect(shown.native.verifications.at(-1).accepted).toBe(true)
  expect(await (await h.request("/workflow?limit=1")).json()).toMatchObject([{ run: { id } }])
  const events = await h.request(`/workflow/${id}/events?limit=1`), page = await events.json()
  expect(page).toHaveLength(1)
  const before = events.headers.get("x-next-before")
  expect(before).not.toBeNull()
  const older = await (await h.request(`/workflow/${id}/events?limit=1&before=${before}`)).json()
  expect(older[0].sequence).toBeLessThan(page[0].sequence)
  const artifacts = await (await h.request(`/workflow/${id}/artifacts`)).json()
  expect(artifacts.find((artifact: { kind: string }) => artifact.kind === "task-output")).toMatchObject({ runID: id, taskID: "Final", status: "valid", data: { value: "Local route verified\n" } })
  await h.restart()
  expect(await (await h.request(`/workflow/${id}/artifacts`)).json()).toEqual(artifacts)
  expect(await (await h.request(`/workflow/${id}`, { method: "DELETE" })).json()).toBe(true)
  expect((await h.request(`/workflow/${id}`)).status).toBe(404)
  expect(h.daemon.store.automationLedger.known("workflow", id)).toBe(false)
}, 10_000)

test("B86 pause/resume/stop and permission-mode are durable, scoped and never exceed the start grant", async () => {
  const h = await boot({ hold: true }), initial = await start(h, donor("hold-for-b86")), id = initial.run.id as WorkflowId
  await until(() => h.daemon.store.workflows.all()[0]?.tasks[0]?.sessionId !== undefined)
  expect((await h.request(`/workflow/${id}`, { method: "DELETE" })).status).toBe(400)
  expect(await (await h.request(`/workflow/${id}/pause`, { value: { reason: "Review" } })).json()).toMatchObject({ run: { state: "paused" } })
  expect(await (await h.request(`/workflow/${id}/permission-mode`, { value: { mode: "report-only", sessionMode: "full_access" } })).json()).toMatchObject({ run: { permissionMode: "report-only", sessionPermissionMode: "full_access" }, native: { permission: "ask" } })
  const mode = h.daemon.store.workflows.all()[0]!
  expect(mode.permissionMode).toBe("report-only")
  expect(mode.plan.permissions).toBeUndefined()
  expect(await (await h.request(`/workflow/${id}/permission-mode`, { value: { mode: "normal", sessionMode: "global_default" } })).json()).toMatchObject({ run: { permissionMode: "normal" } })
  expect(h.daemon.store.workflows.all()[0]!.sessionPermission).toBeUndefined()
  expect((await h.request(`/workflow/${id}/resume`, { value: {} })).status).toBe(200)
  expect(await (await h.request(`/workflow/${id}/stop`, { value: { reason: "Done reviewing" } })).json()).toMatchObject({ run: { state: "stopped" } })
  expect((await h.request(`/workflow/${id}/permission-mode`, { value: { mode: "custom" } })).status).toBe(400)
  const events = await (await h.request(`/workflow/${id}/events`)).json()
  expect(events.filter((entry: { type: string }) => entry.type === "workflow.permissions")).toHaveLength(2)
})

test("B86 retry-task and retry-phase use donor IDs and queue real attempts without resetting counters", async () => {
  for (const action of ["retry-task", "retry-phase"]) {
    const h = await boot({ failFirst: true }), initial = await start(h), id = initial.run.id as WorkflowId
    await until(() => h.daemon.store.workflows.all()[0]?.state === "failed")
    const payload = action === "retry-task" ? { taskID: "Final" } : { phaseID: "Review" }
    expect((await h.request(`/workflow/${id}/${action}`, { value: payload })).status).toBe(200)
    await until(() => h.daemon.store.workflows.all()[0]?.state === "completed")
    expect(h.daemon.store.workflows.all()[0]!.tasks[0]!.attempt).toBe(2)
    expect((await h.request(`/workflow/${id}/${action}`, { value: payload })).status).toBe(400)
    expect((await h.request(`/workflow/${id}/retry-task`, { value: { taskID: "Unknown" } })).status).toBe(404)
    expect((await h.request(`/workflow/${id}/retry-phase`, { value: { phaseID: "Unknown" } })).status).toBe(404)
  }
})

test("B86 start overlapKey is project scoped and concurrent repeats create one run and one root", async () => {
  const h = await boot({ hold: true })
  const results = await Promise.all([1, 2].map(() => h.request("/workflow/start", { value: { plan: donor("hold-for-b86"), overlapKey: "request-1", loopID: "loop-local", loopRunID: "loop-run-local" } })))
  const snapshots = await Promise.all(results.map((response) => response.json()))
  expect(snapshots[0].run.id).toBe(snapshots[1].run.id)
  expect(snapshots[0].run).toMatchObject({ loopID: "loop-local", loopRunID: "loop-run-local" })
  expect(h.daemon.store.workflows.all()).toHaveLength(1)
  expect(h.daemon.store.listSessions().filter((row) => row.title === "workflow · HTTP parity")).toHaveLength(1)
})

test("B86 token authority, project isolation, invalid payloads and unsupported donor features fail closed", async () => {
  const h = await boot({ hold: true }), initial = await start(h, donor("hold-for-b86")), id = initial.run.id
  for (const route of ["/workflow", `/workflow/${id}`, `/workflow/${id}/events`, `/workflow/${id}/artifacts`]) expect((await h.request(route, { token: h.observer })).status).toBe(403)
  for (const route of ["/workflow/preview", "/workflow/save", "/workflow/start", `/workflow/${id}/pause`, `/workflow/${id}/permission-mode`]) expect((await h.request(route, { token: h.observer, value: { plan: donor() } })).status).toBe(403)
  const other = path.join(h.dir, "other"); mkdirSync(other)
  const workspace = await (await h.command({ type: "workspace.create", name: "Other", directory: other, adapter: "local" })).json()
  const headers = { "X-Mendcode-Workspace": workspace.workspace.id }
  for (const action of ["", "/events", "/artifacts"]) expect((await h.request(`/workflow/${id}${action}`, { headers })).status).toBe(403)
  expect((await h.request(`/workflow/${id}/stop`, { value: {}, headers })).status).toBe(403)
  const states = h.daemon.store.workflows.all().map((run) => run.state)
  const withHuman = (human: Record<string, unknown>) => ({ ...donor(), phases: [{ ...donor().phases[0]!, taskIDs: ["Manual", "Final"] }], tasks: [{ id: "Manual", phaseID: "Review", name: "Manual QA", kind: "human", prompt: "Try it", dependsOn: [], output: { kind: "text" }, ...human }, { ...donor().tasks[0]!, dependsOn: ["Manual"] }] })
  for (const plan of [{ ...donor(), tasks: donor().tasks.map((task) => ({ ...task, retry: { maxAttempts: 7 } })) }, { ...donor(), tasks: donor().tasks.map((task) => ({ ...task, retry: { maxAttempts: 2, backoffMs: 3_600_001 } })) }, withHuman({ output: { kind: "json", schema: { type: "object" } } }), withHuman({ inputs: [{ taskID: "Final" }] })]) expect((await h.request("/workflow/start", { value: { plan } })).status).toBe(501)
  expect((await h.request("/workflow/start", { value: { plan: { ...donor(), requiredGates: ["Same", "Same"] } } })).status).toBe(400)
  expect((await h.request("/workflow/start", { value: { plan: { ...donor(), tasks: donor().tasks.map((task) => ({ ...task, retry: { retryOn: ["rate_limited"] } })) } } })).status).toBe(400)
  expect((await h.request("/workflow/start", { value: {} })).status).toBe(400)
  expect((await h.request("/workflow/start", { value: { plan: donor(), definitionID: "wfd_unknown" } })).status).toBe(400)
  expect((await h.request("/workflow/start", { value: { revisionID: "wfr_unknown" } })).status).toBe(404)
  for (const query of ["limit=0", "limit=1.5", "before=-1", "unknown=true"]) expect((await h.request(`/workflow?${query}`)).status).toBe(400)
  expect((await h.request(`/workflow/${id}/pause`, { value: { unknown: true } })).status).toBe(400)
  expect((await h.request(`/workflow/${id}/permission-mode`, { value: { mode: "full" } })).status).toBe(400)
  expect(h.daemon.store.workflows.all().map((run) => run.state)).toEqual(states)
})

test("B86 OpenAPI names every donor endpoint and typed client helpers drive the native controls", async () => {
  const spec = httpOpenApi() as { paths: Record<string, Record<string, any>> }
  const operations = Object.values(spec.paths).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId)).filter((id: string) => id.startsWith("workflow."))
  expect(operations.sort()).toEqual(["workflow.preview", "workflow.save", "workflow.start", "workflow.list", "workflow.show", "workflow.delete", "workflow.events", "workflow.artifacts", "workflow.pause", "workflow.resume", "workflow.stop", "workflow.permissionMode", "workflow.retryTask", "workflow.retryPhase", "workflow.approveTask", "workflow.rejectTask"].sort())
  expect(spec.paths["/workflow/start"]!.post.requestBody.content["application/json"].schema.properties.revisionID).toBeDefined()
  const h = await boot({ hold: true }), initial = await start(h, donor("hold-for-b86")), id = initial.run.id as WorkflowId
  const client = createClient({ socketPath: h.daemon.socketPath, name: "B86 client" })
  cleanup.push(() => client.close())
  await client.connect()
  expect(await client.setWorkflowPermissions(id, { mode: "custom", sessionPermission: "ask" })).toMatchObject({ ok: true })
  expect(await client.retryWorkflowPhase(id, "phase-1")).toMatchObject({ ok: false, error: { code: "busy" } })
})

test("B86 plan translation preserves selectors, routing, map templates and completion policy", () => {
  const plan = { ...donor(), tasks: [
    { ...donor().tasks[0]!, id: "Producer", kind: "agent" as const, output: { kind: "json" as const, schema: { type: "array", items: { type: "string" } } } },
    { ...donor().tasks[0]!, id: "Final", dependsOn: ["Producer"], inputs: [{ taskID: "Producer", path: "0" }], model: { providerID: "faux", modelID: "echo" }, agentProfile: "general", budget: { maxTokens: 100 }, permissions: { mode: "report-only" as const } },
  ], phases: [{ ...donor().phases[0]!, taskIDs: ["Producer", "Final"] }], completion: { confirmation: "next-run" as const, maxAuditAttempts: 1, criteria: [{ id: "Check", description: "Routes verified", ownerTaskIDs: ["Final"] }] } }
  const converted = nativeWorkflowPlan(plan, [{ id: "echo", provider: "faux" }])
  expect(converted.plan.tasks[1]).toMatchObject({ id: "task-2", needs: ["task-1"], inputs: [{ taskId: "task-1", path: "0" }], model: { model: "echo" }, agent: "general", budget: { maxTokens: 100 }, permissions: { mode: "report-only" } })
  expect(converted.plan.contract).toMatchObject({ audit: "independent", maxAudits: 1, criteria: [{ id: "criterion-1", owners: ["task-2"] }] })
  expect(converted.restPlan).toEqual(plan)
})

test("R5 required gates, human tasks, per-task retry and per-plan retention run natively and appear in the donor snapshot", async () => {
  const h = await boot({ failFirst: true })
  const gated = { ...donor(), requiredGates: ["Release"], budget: { retention: { maxArtifacts: 1 } }, tasks: donor().tasks.map((task) => ({ ...task, retry: { maxAttempts: 2 } })) }
  const initial = await start(h, gated), id = initial.run.id as WorkflowId
  expect(initial).toMatchObject({ run: { state: "needs_input" }, gates: [{ id: "Release", state: "blocked", required: true }], tasks: [{ id: "Final", state: "pending" }] })
  expect(initial.tasks).toHaveLength(1)
  expect(initial.revision.plan.budget.retention).toEqual({ maxArtifacts: 1 })
  expect(h.daemon.store.workflows.all()[0]!.tasks.map((task) => [task.id, task.kind, task.state])).toEqual([["gate-1", "human", "needs_input"], ["task-1", "agent", "pending"]])
  expect((await h.request(`/workflow/${id}/approve-task`, { value: { taskID: "Nope" } })).status).toBe(404)
  expect((await h.request(`/workflow/${id}/approve-task`, { value: { taskID: "Final" } })).status).toBe(400)
  expect((await h.request(`/workflow/${id}/approve-task`, { token: h.observer, value: { taskID: "Release" } })).status).toBe(403)
  const approved = await (await h.request(`/workflow/${id}/approve-task`, { value: { taskID: "Release", reason: "cleared" } })).json()
  expect(approved.gates[0]).toMatchObject({ id: "Release", state: "pass", reason: "cleared" })
  await until(() => h.daemon.store.workflows.all()[0]?.state === "completed")
  expect(h.daemon.store.workflows.all()[0]!.tasks[1]).toMatchObject({ state: "done", attempt: 2 })
  const shown = await (await h.request(`/workflow/${id}`)).json()
  expect(shown.tasks[0]).toMatchObject({ id: "Final", attempt: 2, retry: { maxAttempts: 2 } })
  const artifacts = await (await h.request(`/workflow/${id}/artifacts`)).json()
  expect(artifacts.length).toBeLessThanOrEqual(1)
  expect(shown.pagination.artifacts.truncated).toBe(true)
})

test("R5 a rejected gate fails the run before any task starts, and a human task passes its note on", async () => {
  const h = await boot()
  const rejected = await start(h, { ...donor(), requiredGates: ["Release"] }), rejectedId = rejected.run.id as WorkflowId
  const after = await (await h.request(`/workflow/${rejectedId}/reject-task`, { value: { taskID: "Release", reason: "not today" } })).json()
  expect(after).toMatchObject({ run: { state: "failed" }, gates: [{ id: "Release", state: "fail", reason: "rejected: not today" }], tasks: [{ id: "Final", state: "blocked" }] })
  expect(h.daemon.store.workflows.all().find((run) => run.workflowId === rejectedId)!.tasks[1]!.sessionId).toBeUndefined()
  const manual = { ...donor(), phases: [{ ...donor().phases[0]!, taskIDs: ["Manual", "Final"] }], tasks: [{ id: "Manual", phaseID: "Review", name: "Manual QA", kind: "human" as const, prompt: "Try the build", dependsOn: [], output: { kind: "text" as const } }, { ...donor().tasks[0]!, dependsOn: ["Manual"] }] }
  const started = await start(h, manual), id = started.run.id as WorkflowId
  expect(started).toMatchObject({ run: { state: "needs_input" }, tasks: [{ id: "Manual", kind: "human", state: "needs_input" }, { id: "Final", state: "pending" }], gates: [] })
  await h.request(`/workflow/${id}/approve-task`, { value: { taskID: "Manual", reason: "works on my machine" } })
  await until(() => h.daemon.store.workflows.all().find((run) => run.workflowId === id)?.state === "completed")
  const done = await (await h.request(`/workflow/${id}`)).json()
  expect(done.tasks[0]).toMatchObject({ id: "Manual", state: "completed", value: { kind: "text", value: "works on my machine" } })
  expect(h.daemon.store.workflows.all().find((run) => run.workflowId === id)!.tasks[1]!.state).toBe("done")
}, 10_000)
