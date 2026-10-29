import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "@mendcode/engine-native"
import { createIdFactory, WorkflowPlan, type ModelRoles, type WorkflowRun } from "@mendcode/protocol"
import { createRun, taskExecution } from "@mendcode/workflows"
import { startDaemon } from "../src"
import { createWorkflowRouter } from "../src/workflow-routing"
import { usableEffort, type ModelCatalog } from "../src/models"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-b45-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const catalog: ModelCatalog = { selectable: true, defaults: { model: "main" }, list: () => ["main", "configured", "plan", "task"].map((id) => ({ id, name: id, efforts: ["low", "high"], variants: { fast: { effort: "low" }, deep: { effort: "high" } } })) }
const rawPlan = (extra = {}) => ({ name: "B45", objective: "Verify task routing", tasks: [{ kind: "agent", id: "a", title: "Inspect", prompt: "Inspect the project", mode: "read" }], ...extra })
const usage: ModelEvent = { type: "usage", usage: { input: 4, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }

async function boot(steps?: ModelEvent[][]) {
  const dir = temp()
  const project = temp()
  const requests: ModelRequest[] = []
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), models: catalog, engine: ({ store, agents, tasks }) => createNativeEngine({ provider: { id: "fake", model: "main", async *stream(request) { requests.push(request); yield* steps?.shift() ?? [{ type: "text", delta: "done" }, usage, { type: "finish", reason: "stop" }] } }, tools: [], history: memoryHistory(), cwdFor: (id) => store.sessionDirectory(id)!, system: () => "test", compactionPrompt: "summarize", agents, tasks, modelFor: (id) => usableEffort(store.sessionModel(id) ?? { model: "main" }, catalog) }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "B45" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { client, project, requests }
}

async function finished(h: Awaited<ReturnType<typeof boot>>, input: Record<string, unknown>) {
  const started = await h.client.startWorkflow({ directory: h.project, plan: input as never })
  if (!started.ok) throw new Error(started.error.message)
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const read = await h.client.getWorkflow(started.workflow.workflowId)
    if (read.ok && ["completed", "failed"].includes(read.workflow.state)) return read.workflow
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("workflow did not finish")
}

describe("B45 workflow daemon/client routing", () => {
  test("task then plan then workflow role selects independent models and variants", async () => {
    const h = await boot()
    expect((await h.client.send({ type: "settings.set", patch: { models: { workflow: { model: "configured", variant: "fast" } } } })).ok).toBe(true)
    const first = await finished(h, rawPlan({ model: { model: "plan", variant: "fast" }, tasks: [{ kind: "agent", id: "a", title: "a", prompt: "a", mode: "read", model: { model: "task", variant: "deep" }, agent: "explore" }] }))
    expect(first.tasks[0]?.execution).toMatchObject({ model: { model: "task", variant: "deep", effort: "high" }, agent: "explore", readOnly: true })
    await finished(h, rawPlan({ model: { model: "plan" } }))
    await finished(h, rawPlan())
    expect(h.requests.map((request) => [request.model, request.effort])).toEqual([["task", "high"], ["plan", undefined], ["configured", "low"]])
  })

  test("preview rejects unknown models/agents/variants without creating sessions or calls", async () => {
    const h = await boot()
    for (const extra of [{ model: { model: "missing" } }, { model: { model: "task", variant: "missing" } }, { agent: "missing" }]) {
      const preview = await h.client.send({ type: "workflow.preview", directory: h.project, plan: rawPlan(extra) as never })
      expect(preview).toMatchObject({ ok: true, result: { problems: [expect.stringContaining("task") ] } })
    }
    expect(h.requests).toHaveLength(0)
    expect(await h.client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [] } })
  })

  test("token and unpriced cost budgets fail with durable reasons", async () => {
    const h = await boot()
    const tokens = await finished(h, rawPlan({ budget: { maxTokens: 5 } }))
    expect(tokens.tasks[0]).toMatchObject({ state: "failed", reason: "token budget exhausted (6/5)", usage: { input: 4, output: 2, calls: 1 } })
    const cost = await finished(h, rawPlan({ budget: { maxCost: 1 } }))
    expect(cost.tasks[0]?.reason).toContain("price is unknown")
  })

  test("router freezes a prior execution choice when settings change", async () => {
    const ids = createIdFactory()
    const plan = WorkflowPlan.parse(rawPlan())
    const run = createRun({ workflowId: ids("workflow"), rootSessionId: ids("session"), plan, planHash: "0".repeat(64), directory: temp(), permission: "ask", at: 0 })
    let roles: ModelRoles = { workflow: { model: "configured", variant: "fast" } }
    const router = createWorkflowRouter({ dir: temp(), catalog, roles: () => roles, sessionModel: () => undefined, agent: (directory, name) => ({ name, description: directory, mode: "subagent", prompt: "" }) })
    const spec = plan.tasks[0]!
    const ready = await router.prepare(run, spec, taskExecution(run, spec))
    roles = { workflow: { model: "main", variant: "deep" } }
    run.tasks[0]!.execution = ready
    expect((await router.prepare(run, spec, ready)).model).toEqual(ready.model)
  })

  test("isolated task workspace is created in a temp repo, retained and reused", async () => {
    const directory = temp()
    const data = temp()
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "B45", GIT_AUTHOR_EMAIL: "b45@test.local", GIT_COMMITTER_NAME: "B45", GIT_COMMITTER_EMAIL: "b45@test.local" } })
      const error = await new Response(child.stderr).text()
      if (await child.exited) throw new Error(error)
    }
    await git("init", "--quiet")
    writeFileSync(path.join(directory, "fixture.txt"), "original")
    await git("add", "fixture.txt")
    await git("commit", "--quiet", "-m", "fixture")
    const ids = createIdFactory()
    const plan = WorkflowPlan.parse(rawPlan({ workspace: { mode: "per-run-worktree" } }))
    const run = createRun({ workflowId: ids("workflow"), rootSessionId: ids("session"), plan, planHash: "0".repeat(64), directory, permission: "ask", at: 0 })
    const router = createWorkflowRouter({ dir: data, catalog, roles: () => ({}), sessionModel: () => undefined, agent: (_directory, name) => ({ name, description: "", mode: "subagent", prompt: "" }) })
    const ready = await router.prepare(run, plan.tasks[0]!, taskExecution(run, plan.tasks[0]!))
    expect(ready.directory.startsWith(path.join(data, "workflows", "workspaces"))).toBe(true)
    writeFileSync(path.join(ready.directory, "fixture.txt"), "worktree edit")
    expect(readFileSync(path.join(directory, "fixture.txt"), "utf8")).toBe("original")
    run.tasks[0]!.execution = ready
    expect((await router.prepare(run, plan.tasks[0]!, ready)).directory).toBe(ready.directory)
    expect(readFileSync(path.join(ready.directory, "fixture.txt"), "utf8")).toBe("worktree edit")
  })
})
