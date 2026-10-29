import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type WorkflowSummary } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createInProcessScriptHost } from "../../workflows/src/script-inprocess"
import { startDaemon } from "../src"
import { createWorkflowsHost, type WorkflowCommand } from "../src/workflows"
import { workflowScriptTool } from "../src/workflow-tools"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 15_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-script-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SCRIPT = `export const meta = { name: "greet", description: "say hi twice", phases: [{ title: "Hi" }], budget: { agents: 4 } }
phase("Hi")
const first = await agent("say hi", { label: "first" })
const both = await parallel([() => agent("say a", { label: "a" }), () => agent("say b", { label: "b" })])
log("done", both.length)
return { first: typeof first, both: both.length, who: args.who }`

describe("script workflows in the daemon (real isolated host process, faux engine)", () => {
  test("a script starts from its source, runs its agents as workflow tasks and completes with its result", async () => {
    const dir = tempDir(), project = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const changes: WorkflowSummary[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "script", onGlobal: (e) => void (e.type === "workflow.changed" && changes.push(e.workflow)) })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())

    const preview = await client.send({ type: "workflow.preview", directory: project, plan: { script: SCRIPT, args: { who: "me" } } } as never)
    expect(preview).toMatchObject({ ok: true, result: { problems: [], summary: { name: "greet", script: { origin: "inline", hash: expect.stringMatching(/^[a-f0-9]{64}$/) } } } })
    expect(daemon.workflowsLoaded()).toBe(false)

    const started = await client.send({ type: "workflow.start", directory: project, plan: { script: SCRIPT, args: { who: "me" } } } as never)
    expect(started.ok).toBe(true)
    const workflow = (started.ok ? started.result?.workflow : undefined) as WorkflowSummary
    await until(() => changes.some((entry) => entry.workflowId === workflow.workflowId && entry.state === "completed"))
    const done = changes.filter((entry) => entry.workflowId === workflow.workflowId).at(-1)!
    expect(done.script).toMatchObject({ calls: 3, counts: { done: 3 }, phase: "Hi", logs: ["done 2"], budget: { agents: 4 } })
    const full = await client.send({ type: "workflow.get", workflowId: workflow.workflowId } as never)
    expect(JSON.parse((full.ok ? (full.result?.workflow as { script: { result: string } }) : undefined)!.script.result)).toEqual({ first: "string", both: 2, who: "me" })
    expect(done.tasks.map((task) => task.title).sort()).toEqual(["a", "b", "first"])
    // Every agent call is an ordinary child session of the run, with the ordinary single-source ledger.
    expect(daemon.store.readAfter((full.ok ? (full.result?.workflow as { tasks: Array<{ sessionId: string }> }) : undefined)!.tasks[0]!.sessionId as never, 0).some((event) => event.type === "queue.added")).toBe(true)
  }, 60_000)

  test("a script that spends past its declared cap pauses with a reason, and workflow.script raises the cap", async () => {
    const dir = tempDir(), project = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const changes: WorkflowSummary[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "script", onGlobal: (e) => void (e.type === "workflow.changed" && changes.push(e.workflow)) })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const script = `export const meta = { name: "loop", budget: { agents: 2 } }\nfor (let i = 0; i < 3; i++) await agent("step " + i)\nreturn "ok"`
    const started = await client.send({ type: "workflow.start", directory: project, plan: { script } } as never)
    const workflow = (started.ok ? started.result?.workflow : undefined) as WorkflowSummary
    await until(() => changes.some((entry) => entry.workflowId === workflow.workflowId && entry.state === "paused"))
    expect(changes.filter((entry) => entry.workflowId === workflow.workflowId).at(-1)).toMatchObject({ state: "paused", reason: expect.stringContaining("agent cap reached (2/2)") })
    expect(await client.send({ type: "workflow.script", workflowId: workflow.workflowId, action: "budget", budget: {} } as never)).toMatchObject({ ok: false })
    expect(await client.send({ type: "workflow.script", workflowId: workflow.workflowId, action: "budget", budget: { agents: 10 } } as never)).toMatchObject({ ok: true, result: { workflow: { script: { budget: { agents: 10 } } } } })
    expect(await client.send({ type: "workflow.control", workflowId: workflow.workflowId, action: "resume" } as never)).toMatchObject({ ok: true })
    await until(() => changes.some((entry) => entry.workflowId === workflow.workflowId && entry.state === "completed"))
  }, 60_000)

  test("a script outside every rule fails validation before anything starts", async () => {
    const dir = tempDir(), project = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: "script" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    for (const bad of [`const x = 1`, `export const meta = { name: process.env.X }\nreturn 1`, `export const meta = { name: "x" }\nawait import("node:fs")`, `export const meta = { name: "x", budget: { agents: 999 } }\nreturn 1`]) {
      const reply = await client.send({ type: "workflow.start", directory: project, plan: { script: bad } } as never)
      expect(reply.ok).toBe(false)
    }
    expect(daemon.workflowsLoaded()).toBe(false)
  })

  test("a project script runs only in a trusted project; a user script needs no trust", async () => {
    const dir = tempDir(), project = tempDir()
    mkdirSync(path.join(project, ".mendcode", "workflows"), { recursive: true })
    mkdirSync(path.join(dir, "workflows"), { recursive: true })
    writeFileSync(path.join(project, ".mendcode", "workflows", "proj.js"), `export const meta = { name: "proj" }\nreturn "p"`)
    writeFileSync(path.join(dir, "workflows", "mine.js"), `export const meta = { name: "mine" }\nreturn "m"`)
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: "script" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const untrusted = await client.send({ type: "workflow.preview", directory: project, plan: { scriptRef: "proj" } } as never)
    expect(untrusted).toMatchObject({ ok: true, result: { problems: [expect.stringContaining("not trusted")] } })
    expect(await client.send({ type: "workflow.preview", directory: project, plan: { scriptRef: "mine" } } as never)).toMatchObject({ ok: true, result: { problems: [], summary: { script: { origin: "user" } } } })
    await client.send({ type: "tools.trust", directory: project, trusted: true } as never)
    expect(await client.send({ type: "workflow.preview", directory: project, plan: { scriptRef: "proj" } } as never)).toMatchObject({ ok: true, result: { problems: [], summary: { script: { origin: "project" } } } })
    expect(await client.send({ type: "workflow.preview", directory: project, plan: { scriptRef: "missing" } } as never)).toMatchObject({ ok: true, result: { problems: [expect.stringContaining("no saved script")] } })
  }, 30_000)
})

describe("who may start a script", () => {
  function host() {
    const dir = tempDir(), project = tempDir()
    const ids = createIdFactory()
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    const workflows = createWorkflowsHost({
      store: store.workflows, definitions: store.workflowDefinitions,
      clock: { now: () => Date.now(), setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) } } },
      ids, layersFor: () => [], defaultPermission: () => "ask",
      journal: store.workflowJournal, scriptHost: createInProcessScriptHost(),
      createSession(input) { const id = ids("session"); store.createSession({ ...input, id }); return id },
      submit: async () => ({ queueId: ids("queue") }), cancelTurn: () => {}, deleteSession: () => true,
      runCheck: async () => ({ exitCode: 0, output: "" }), fingerprint: async () => "x", emit: () => {},
    })
    cleanups.push(() => workflows.dispose())
    return { workflows, project, store }
  }
  const plan = { script: `export const meta = { name: "x" }\nreturn 1` }

  test("a remote or peer client cannot preview, start or save a script, nor change one", async () => {
    const { workflows, project } = host()
    for (const command of [{ type: "workflow.start", directory: project, plan }, { type: "workflow.preview", directory: project, plan }, { type: "workflow.save", directory: project, plan }] as WorkflowCommand[]) {
      const reply = await workflows.handle(command, { local: false })
      expect(reply.ok === true ? (reply.result?.problems as string[])?.[0] ?? "ok" : reply.message).toContain("only from the machine that runs them")
    }
    expect(await workflows.handle({ type: "workflow.script", workflowId: createIdFactory()("workflow"), action: "budget", budget: { agents: 5 } } as WorkflowCommand, { local: false })).toMatchObject({ ok: false, code: "forbidden" })
    expect(workflows.loaded()).toBe(false)
  })

  test("a saved script revision is refused for a remote client too, and local start works", async () => {
    const { workflows, project } = host()
    const saved = await workflows.handle({ type: "workflow.save", directory: project, plan } as WorkflowCommand)
    expect(saved).toMatchObject({ ok: true })
    const revisionId = saved.ok ? (saved.result!.receipt as { revisionId: string }).revisionId : ""
    const remote = await workflows.handle({ type: "workflow.start", directory: project, plan: { revisionId } } as WorkflowCommand, { local: false })
    expect(remote.ok).toBe(false)
    const local = await workflows.handle({ type: "workflow.start", directory: project, plan: { revisionId } } as WorkflowCommand)
    expect(local.ok).toBe(true)
  })

  test("a client cannot claim a trusted origin; a model-written script is marked model", async () => {
    const { workflows, project } = host()
    const claimed = await workflows.handle({ type: "workflow.preview", directory: project, plan: { script: plan.script, origin: "package" } } as WorkflowCommand)
    expect(claimed).toMatchObject({ ok: true, result: { summary: { script: { origin: "inline" } } } })
    const port = workflows.port("session_x" as never, project)
    const preview = await port.preview({ script: plan.script })
    expect(preview.detail).toContain("origin model")
    expect(preview.detail).toContain("Source sha256:")
    expect(preview.detail).toContain("none declared (limited to 10 agent calls)")
    expect(preview.detail).toContain('export const meta = { name: "x" }')
  })
})

describe("the workflow_script tool", () => {
  test("it is lazy, balanced and tier-gated, always asks, and answers help without asking", () => {
    expect(workflowScriptTool.tier).toBe("balanced")
    expect(workflowScriptTool.approvalFor?.({ script: "x" })).toBe(true)
    expect(workflowScriptTool.approvalFor?.({ help: true })).toBe(false)
    expect(workflowScriptTool.permissionFor?.({ help: true })).toBe("read")
    expect(workflowScriptTool.permissionFor?.({ script: "x" })).toBe("execute")
    expect(workflowScriptTool.args.safeParse({}).success).toBe(false)
    expect(workflowScriptTool.args.safeParse({ script: "x", name: "y" }).success).toBe(false)
    expect(workflowScriptTool.args.safeParse({ name: "y" }).success).toBe(true)
    expect(workflowScriptTool.description.length).toBeLessThan(900)
  })

  test("help returns the API reference; start goes through the workflow port", async () => {
    const help = await workflowScriptTool.execute({ help: true }, { cwd: "/", signal: new AbortController().signal } as never)
    expect(help.output).toContain("await agent(prompt, opts)")
    expect(help.output).toContain("export const meta")
    const started = await workflowScriptTool.execute({ script: "export const meta = { name: 'x' }" }, { cwd: "/", signal: new AbortController().signal, workflows: { start: async (input: unknown) => ({ ok: true, workflowId: "wf1", name: JSON.stringify(input).slice(0, 12), tasks: 0 }) } } as never)
    expect(started.output).toContain("started (wf1)")
  })
})
