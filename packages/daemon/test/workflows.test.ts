import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, WorkflowPlan, type WorkflowSummary } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createRun } from "@mendcode/workflows"
import { startDaemon } from "../src"
import { appliedPermission } from "../src/workflows"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-workflows-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const changes: Array<{ workflow: WorkflowSummary; deleted?: boolean | undefined }> = []
  const client = createClient({ socketPath: daemon.socketPath, name: "workflows", onGlobal: (e) => void (e.type === "workflow.changed" && changes.push(e)) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { daemon, client, changes }
}

const plan = (extra: Record<string, unknown> = {}) => ({
  name: "ship",
  objective: "Say hi twice.",
  tasks: [
    { kind: "agent", id: "hello", title: "Say hello", prompt: "say hi", mode: "read" },
    { kind: "agent", id: "again", title: "Say it again", prompt: "say hi again", needs: ["hello"], mode: "read" },
  ],
  ...extra,
})

describe("workflows in the daemon", () => {
  test("an idle daemon never builds the workflow service; preview creates nothing", async () => {
    const { daemon, client } = await boot(tempDir())
    expect(daemon.workflowsLoaded()).toBe(false)
    const project = tempDir()
    expect(await client.send({ type: "workflow.preview", directory: project, plan: plan({ permission: "full" }) } as never)).toMatchObject({ ok: true, result: { problems: [], summary: { permission: "ask", tasks: [{ id: "hello" }, { id: "again" }] } } })
    expect(await client.send({ type: "workflow.preview", directory: project, plan: plan({ tasks: [{ kind: "agent", id: "a", title: "a", prompt: "p", needs: ["zz"] }] }) } as never)).toMatchObject({ ok: true, result: { problems: [expect.stringContaining("zz")] } })
    expect(await client.send({ type: "workflow.list" } as never)).toMatchObject({ ok: true, result: { workflows: [] } })
    expect(daemon.workflowsLoaded()).toBe(false)
  })

  test("start runs the tasks in hidden child sessions, the contract check passes, and the run completes", async () => {
    const project = tempDir()
    const { daemon, client, changes } = await boot(tempDir())
    const started = await client.send({ type: "workflow.start", directory: project, plan: plan({ contract: { criteria: [{ id: "ok", text: "it ran" }], checks: [{ id: "ok", command: "true", covers: ["ok"] }] } }) } as never)
    expect(started.ok).toBe(true)
    const workflow = (started.ok ? started.result?.workflow : undefined) as WorkflowSummary
    await until(() => changes.some((c) => c.workflow.workflowId === workflow.workflowId && c.workflow.state === "completed"))
    const done = changes.filter((c) => c.workflow.workflowId === workflow.workflowId).at(-1)!.workflow
    expect(done.tasks.map((task) => task.state)).toEqual(["done", "done"])
    expect(done.verification).toMatchObject({ accepted: true, criteria: [{ id: "ok", status: "pass", by: "check" }] })
    // Task sessions are children of the root, so the session list shows no per-task rows.
    const listed = daemon.store.listSessions({ limit: 50 }).map((session) => session.title)
    expect(listed.filter((title) => title.startsWith("workflow · ship ·"))).toEqual([])
    const events = daemon.store.readAfter(done.tasks[1]!.sessionId!, 0)
    expect(events.find((e) => e.type === "queue.added" && e.text.includes("say hi again"))).toBeDefined()
    expect(await client.send({ type: "workflow.control", workflowId: workflow.workflowId, action: "delete" } as never)).toMatchObject({ ok: true })
    expect(daemon.store.hasSession(done.rootSessionId)).toBe(false)
    expect(changes.at(-1)).toMatchObject({ deleted: true })
  })

  test("a saved plan runs by name; a second workflow that edits the same directory is refused", async () => {
    const dir = tempDir()
    const project = tempDir()
    await Bun.write(path.join(project, ".mendcode", "workflows", "edit.json"), JSON.stringify({ name: "edit", objective: "o", tasks: [{ kind: "agent", id: "w", title: "w", prompt: "p", mode: "work", timeoutMinutes: 30 }] }))
    const { client } = await boot(dir)
    const first = await client.send({ type: "workflow.start", directory: project, plan: { ref: "edit" } } as never)
    expect(first.ok).toBe(true)
    // The first may already be done with the faux engine; only a live one refuses.
    const second = await client.send({ type: "workflow.start", directory: project, plan: { ref: "edit" } } as never)
    const state = ((first.ok ? first.result?.workflow : undefined) as WorkflowSummary).state
    if (state === "running") expect(second).toMatchObject({ ok: false, error: { code: "busy" } })
    expect(await client.send({ type: "workflow.start", directory: project, plan: { ref: "missing" } } as never)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })

  test("a run still live at boot is picked up and finished", async () => {
    const dir = tempDir()
    const project = tempDir()
    const ids = createIdFactory()
    const store = openStore({ dir, now: () => Date.now() })
    const rootSessionId = ids("session")
    store.createSession({ id: rootSessionId, directory: project, title: "workflow · boot" })
    const run = createRun({ workflowId: ids("workflow"), plan: WorkflowPlan.parse(plan({ name: "boot" })), planHash: "0".repeat(64), directory: project, permission: "ask", rootSessionId, at: Date.now() })
    store.workflows.save(run)
    store.close()
    const { daemon } = await boot(dir)
    expect(daemon.workflowsLoaded()).toBe(true)
    await until(() => daemon.store.workflows.all().find((entry) => entry.workflowId === run.workflowId)?.state === "completed")
  })

  test("the applied permission never exceeds what the user granted", () => {
    expect(appliedPermission("full", "edits")).toBe("edits")
    expect(appliedPermission("ask", "full")).toBe("ask")
    expect(appliedPermission(undefined, "edits")).toBe("edits")
    expect(appliedPermission("edits", undefined)).toBe("ask")
  })
})

describe("workflow tools", () => {
  test("the port previews exactly what will run, starts as a child of the session, and reports status", async () => {
    const dir = tempDir()
    const project = tempDir()
    let portFor: ((sessionId: never) => import("@mendcode/tools").WorkflowPort) | undefined
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: (input) => {
        portFor = input.workflows as never
        return createFauxEngine({ clock: input.clock, deltaMs: 1 })
      },
    })
    cleanups.push(() => daemon.stop())
    const sessionId = createIdFactory()("session")
    daemon.store.createSession({ id: sessionId, directory: project, title: "chat" })
    const port = portFor!(sessionId as never)
    const context = { cwd: project, signal: new AbortController().signal, workflows: port }
    const { workflowStartTool, workflowStatusTool } = await import("../src/workflow-tools")
    const withCheck = WorkflowPlan.parse(plan({ contract: { criteria: [{ id: "ok", text: "ok" }], checks: [{ id: "ok", command: "bun test --bail", covers: ["ok"] }] } }))
    const detail = await workflowStartTool.preview!(withCheck, context)
    expect(detail).toContain("- bun test --bail")
    expect(detail).toContain("permission ask")
    const broken = WorkflowPlan.parse(plan({ tasks: [{ kind: "agent", id: "a", title: "a", prompt: "p", needs: ["zz"] }] }))
    expect(await workflowStartTool.preview!(broken, context)).toContain("Problems:")
    expect(await workflowStartTool.execute(broken, context)).toMatchObject({ isError: true })
    const started = await workflowStartTool.execute(WorkflowPlan.parse(plan()), context)
    expect(started).toMatchObject({ isError: false, title: "◇ Workflow ship · 2 tasks · started — /workflows" })
    const run = daemon.store.workflows.all()[0]!
    expect(run.originSessionId).toBe(sessionId)
    expect((await workflowStatusTool.execute({}, context)).output).toContain(`${run.workflowId} "ship"`)
    expect((await workflowStatusTool.execute({ workflowId: "workflow_nope" }, context)).output).toBe("unknown workflow workflow_nope")
  })

  test("workflow_events and workflow_artifacts read the run's own ledger: bounded, redacted, paged and project scoped", async () => {
    const dir = tempDir()
    const project = tempDir()
    const elsewhere = tempDir()
    let portFor: ((sessionId: never) => import("@mendcode/tools").WorkflowPort) | undefined
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: (input) => {
        portFor = input.workflows as never
        return createFauxEngine({ clock: input.clock, deltaMs: 1 })
      },
    })
    cleanups.push(() => daemon.stop())
    const ids = createIdFactory()
    const sessionId = ids("session"), otherSession = ids("session")
    daemon.store.createSession({ id: sessionId, directory: project, title: "chat" })
    daemon.store.createSession({ id: otherSession, directory: elsewhere, title: "elsewhere" })
    const context = { cwd: project, signal: new AbortController().signal, workflows: portFor!(sessionId as never) }
    const { workflowStartTool, workflowEventsTool, workflowArtifactsTool } = await import("../src/workflow-tools")
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`
    await workflowStartTool.execute(WorkflowPlan.parse(plan({ tasks: [{ kind: "agent", id: "a", title: "a", prompt: `use token ${secret} to read` }, { kind: "agent", id: "b", title: "b", prompt: "second", needs: ["a"] }] })), context)
    const run = daemon.store.workflows.all()[0]!
    const artifacts = await workflowArtifactsTool.execute({ workflowId: run.workflowId }, context)
    expect(artifacts).toMatchObject({ isError: false })
    expect(artifacts.output).toContain(`${run.workflowId} · artifacts · retained`)
    expect(artifacts.output).toContain("task-spec [a]")
    expect(artifacts.output).toContain("[redacted:github-token]")
    expect(artifacts.output).not.toContain(secret)
    const events = await workflowEventsTool.execute({ workflowId: run.workflowId }, context)
    expect(events.output).toContain("workflow.running")
    expect(events.output).not.toContain("task-spec")
    const paged = await workflowEventsTool.execute({ workflowId: run.workflowId, limit: 1 }, context)
    expect(paged.output).toMatch(/next_before: \d+/)
    const older = await workflowEventsTool.execute({ workflowId: run.workflowId, limit: 1, before: Number(/next_before: (\d+)/.exec(paged.output)![1]) }, context)
    expect(older.output).not.toEqual(paged.output)
    expect((await workflowEventsTool.execute({ workflowId: "workflow_nope" }, context)).output).toBe("unknown workflow workflow_nope")
    const foreign = { cwd: elsewhere, signal: new AbortController().signal, workflows: portFor!(otherSession as never) }
    expect((await workflowArtifactsTool.execute({ workflowId: run.workflowId }, foreign)).output).toBe(`unknown workflow ${run.workflowId}`)
    expect(workflowArtifactsTool.permission).toBe("read")
    expect((await workflowEventsTool.execute({ workflowId: run.workflowId }, { cwd: project, signal: new AbortController().signal })).isError).toBe(true)
  })
})

describe("B21 definitions", () => {
  test("save freezes named contracts without running; old revisions survive restart and run deletion", async () => {
    const dir = tempDir()
    const project = tempDir()
    const contractFile = path.join(project, ".mendcode", "contracts", "gate.json")
    await Bun.write(contractFile, JSON.stringify({ criteria: [{ id: "ok", text: "Original" }], checks: [{ id: "ok", command: "true", covers: ["ok"] }] }))
    const { client, daemon } = await boot(dir)
    const saved = await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan({ contract: "gate" })), name: "Saved title", description: "Read-only plan" })
    if (!saved.ok) throw new Error(saved.error.message)
    const r = saved.receipt
    expect(r).toMatchObject({ revision: 1, immutable: true, definition: { name: "Saved title", saved: true } })
    expect(daemon.workflowsLoaded()).toBe(false)
    expect(daemon.store.listSessions({ limit: 20 })).toEqual([])
    await Bun.write(contractFile, JSON.stringify({ criteria: [{ id: "ok", text: "New" }], checks: [{ id: "ok", command: "false", covers: ["ok"] }] }))
    expect(await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan({ contract: "gate", objective: "New objective" })), definitionId: r.definitionId })).toMatchObject({ ok: true, receipt: { revision: 2 } })
    expect(await client.workflowRevision(project, r.revisionId)).toMatchObject({ ok: true, receipt: { plan: { contract: { criteria: [{ text: "Original" }], checks: [{ command: "true" }] } } } })
    const started = await client.send({ type: "workflow.start", directory: project, plan: { revisionId: r.revisionId } })
    expect(started).toMatchObject({ ok: true, result: { workflow: { name: "Saved title", definitionId: r.definitionId, revisionId: r.revisionId, planHash: r.planHash, revision: 1 } } })
    if (!started.ok) throw new Error(started.error.message)
    const run = started.result!.workflow as WorkflowSummary
    await until(() => daemon.store.workflows.all().find((entry) => entry.workflowId === run.workflowId)?.state === "completed")
    expect(await client.send({ type: "workflow.control", workflowId: run.workflowId, action: "delete" })).toMatchObject({ ok: true })
    await client.close()
    await daemon.stop()
    const restarted = await boot(dir)
    expect(await restarted.client.workflowRevision(project, r.revisionId)).toMatchObject({ ok: true, receipt: { revision: 1, planHash: r.planHash } })
    expect(await restarted.client.workflowDefinitions(project)).toMatchObject({ ok: true, definitions: [{ currentRevision: 2, definitionId: r.definitionId }] })
    expect(restarted.daemon.workflowsLoaded()).toBe(false)
  })

  test("current definition previews the head; invalid/cross-project refs and read-only access reject", async () => {
    const { client } = await boot(tempDir())
    const project = tempDir()
    const first = await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan()) })
    if (!first.ok) throw new Error(first.error.message)
    const second = await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan({ objective: "Revised" })), definitionId: first.receipt.definitionId })
    if (!second.ok) throw new Error(second.error.message)
    expect(await client.send({ type: "workflow.preview", directory: project, plan: { definitionId: first.receipt.definitionId } })).toMatchObject({ ok: true, result: { summary: { revisionId: second.receipt.revisionId, revision: 2 } } })
    expect(await client.workflowRevision(tempDir(), first.receipt.revisionId)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan()), definitionId: "wfd_unknown" })).toMatchObject({ ok: false })
    const started = await client.send({ type: "workflow.start", directory: project, plan: WorkflowPlan.parse(plan()) })
    if (!started.ok) throw new Error(started.error.message)
    const run = started.result!.workflow as WorkflowSummary
    expect(await client.workflowRevision(project, run.revisionId!)).toMatchObject({ ok: true, receipt: { definition: { saved: false } } })
    expect(await client.saveWorkflow({ directory: project, plan: WorkflowPlan.parse(plan()), definitionId: run.definitionId! })).toMatchObject({ ok: true, receipt: { revision: 2, definition: { saved: true } } })
    expect(await client.send({ type: "workflow.save", directory: project, plan: { ...plan(), tasks: [{ kind: "agent", id: "a", title: "A", prompt: "p", needs: ["missing"] }] } } as never)).toMatchObject({ ok: false })
    const { isReadOnlyCommand } = await import("@mendcode/protocol/wire")
    for (const type of ["workflow.save", "workflow.definitions", "workflow.revision.get"]) expect(isReadOnlyCommand(type as never)).toBe(false)
  })

  test("model save/control tools use the scoped port and report receipts and refusals", async () => {
    const dir = tempDir()
    const project = tempDir()
    let portFor!: (sessionId: never) => import("@mendcode/tools").WorkflowPort
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: (input) => {
      portFor = input.workflows as never
      return createFauxEngine({ clock: input.clock, deltaMs: 1 })
    } })
    cleanups.push(() => daemon.stop())
    const sessionId = createIdFactory()("session")
    daemon.store.createSession({ id: sessionId, directory: project, title: "chat" })
    const port = portFor(sessionId as never)
    const ctx = { cwd: project, signal: new AbortController().signal, workflows: port }
    const { workflowSaveTool, workflowControlTool, workflowStartTool } = await import("../src/workflow-tools")
    const withCheck = WorkflowPlan.parse(plan({ contract: { criteria: [{ id: "ok", text: "ok" }], checks: [{ id: "ok", command: "true", covers: ["ok"] }] } }))
    const saved = await workflowSaveTool.execute({ plan: withCheck }, ctx)
    expect(saved).toMatchObject({ isError: false, meta: { revision: 1 } })
    expect(saved.output).toContain("plan_hash:")
    const started = await workflowStartTool.execute({ revisionId: String(saved.meta!.revisionId) }, ctx)
    expect(started.isError).toBe(false)
    const workflowId = String(started.meta!.workflowId)
    expect((await workflowControlTool.execute({ workflowId, action: "pause" }, ctx)).isError).toBe(false)
    expect(await workflowControlTool.preview!({ workflowId, action: "resume" }, ctx)).toContain("permission ask")
    expect(await port.previewControl!(workflowId)).toContain("Tasks:")
    expect(await workflowControlTool.preview!({ workflowId, action: "retry", taskId: "a" }, ctx)).toContain("- true")
    expect((await workflowControlTool.execute({ workflowId: "wfl_missing", action: "resume" }, ctx)).isError).toBe(true)
    const other = portFor(createIdFactory()("session") as never)
    expect(await other.status(workflowId)).toContain("unknown")
    expect(await other.control!(workflowId, "stop")).toMatchObject({ ok: false })
    expect((await workflowSaveTool.execute({ plan: WorkflowPlan.parse(plan()) }, { cwd: project, signal: ctx.signal })).isError).toBe(true)
  })
})
