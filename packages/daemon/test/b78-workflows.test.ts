import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import { WorkflowPlan } from "@mendcode/protocol"
import { b78MapPlan, outputB78 } from "../../workflows/test/b78-harness"
import { startDaemon } from "../src"
import { usableEffort, type ModelCatalog } from "../src/models"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => { const directory = mkdtempSync(path.join(tmpdir(), "mend-b78-")); cleanups.push(() => rmSync(directory, { recursive: true, force: true })); return directory }
const catalog: ModelCatalog = { selectable: true, defaults: { model: "main" }, list: () => [{ id: "main", name: "Local fake", efforts: [] }] }

async function boot() {
  const dir = temp(), project = temp(), requests: ModelRequest[] = []
  const responses = [outputB78(["a.ts", "b.ts"]), outputB78({ file: "a.ts" }), outputB78({ file: "b.ts" }), "done"]
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), models: catalog, engine: ({ store, agents, tasks }) => createNativeEngine({
    provider: { id: "fake", model: "main", async *stream(request) {
      requests.push(request)
      yield { type: "text", delta: responses.shift() ?? "done" }
      yield { type: "usage", usage: { input: 4, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
      yield { type: "finish", reason: "stop" }
    } },
    tools: [], history: memoryHistory(), cwdFor: (id) => store.sessionDirectory(id)!, system: () => "local test", compactionPrompt: "summarize", agents, tasks,
    modelFor: (id) => usableEffort(store.sessionModel(id) ?? { model: "main" }, catalog),
  }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "B78" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { daemon, client, project, requests }
}

describe("B78 daemon and typed client", () => {
  test("preview and immutable save show phases, map routing, outputs and overlap without provider calls", async () => {
    const current = await boot()
    const plan = WorkflowPlan.parse(b78MapPlan({ overlapPolicy: "queue" }))
    const preview = await current.client.send({ type: "workflow.preview", directory: current.project, plan })
    expect(preview).toMatchObject({ ok: true, result: { problems: [], summary: { phases: [{ id: "discover" }, { id: "inspect" }, { id: "reporting" }], overlapPolicy: "queue", tasks: [{ output: { kind: "json" } }, { kind: "map", map: { maxItems: 3 }, routing: { permission: "ask" } }, { id: "report" }] } } })
    const saved = await current.client.saveWorkflow({ directory: current.project, plan })
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error(saved.error.message)
    expect(saved.receipt.plan).toMatchObject({ phases: [{ id: "discover", barrier: { kind: "all" } }, { id: "inspect" }, { id: "reporting" }], overlapPolicy: "queue" })
    expect(current.requests).toHaveLength(0)
    expect(current.daemon.workflowsLoaded()).toBe(false)
  })

  test("typed start/get execute bounded map through daemon routing and persist structured output", async () => {
    const current = await boot()
    const plan = WorkflowPlan.parse(b78MapPlan({ maxConcurrent: 2 }))
    const started = await current.client.startWorkflow({ directory: current.project, plan })
    if (!started.ok) throw new Error(started.error.message)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const result = await current.client.getWorkflow(started.workflow.workflowId)
      if (result.ok && ["completed", "failed"].includes(result.workflow.state)) {
        expect(result.workflow.state).toBe("completed")
        expect(result.workflow.tasks.find((task) => task.id === "review")?.output?.value).toBe('[{"file":"a.ts"},{"file":"b.ts"}]')
        expect(result.workflow.tasks.filter((task) => task.mapParentId).every((task) => task.execution?.readOnly && task.execution.model?.model === "main")).toBe(true)
        expect(result.workflow.planHash).toBe(started.workflow.planHash)
        expect(current.requests).toHaveLength(4)
        const stored = current.daemon.store.workflows.all().find((run) => run.workflowId === result.workflow.workflowId)
        expect(stored?.tasks.find((task) => task.id === "review")?.output).toEqual(result.workflow.tasks.find((task) => task.id === "review")?.output)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("local workflow did not finish within 4s")
  }, 8000)

  test("preview rejects unknown model routing inside map templates", async () => {
    const current = await boot()
    const raw = b78MapPlan()
    const tasks = raw.tasks as Array<Record<string, unknown>>
    const map = tasks[1]!.map as { taskTemplate: Record<string, unknown> }
    map.taskTemplate.model = { model: "missing" }
    const preview = await current.client.send({ type: "workflow.preview", directory: current.project, plan: WorkflowPlan.parse(raw) })
    expect(preview).toMatchObject({ ok: true, result: { problems: [expect.stringContaining("review")] } })
    expect(current.requests).toHaveLength(0)
  })
})
