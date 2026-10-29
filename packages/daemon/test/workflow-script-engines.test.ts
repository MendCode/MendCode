import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { WorkflowSummary } from "@mendcode/protocol"
import { startDaemon } from "../src"

/**
 * Per-agent `engine` / `model` / `effort` in a script: two faux engines behind one router (what `main.ts` does with Claude Code),
 * chosen by the engine of each session's model.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function until(check: () => boolean, label: string, ms = 20_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-engines-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const MODELS = [
  { id: "native-a", name: "native-a", efforts: ["low", "high"] },
  { id: "claude-x", name: "claude-x", efforts: ["low", "high"], engine: "claude" },
]

async function boot(options: { tier?: "full"; claude?: boolean } = {}) {
  const dir = tempDir(), project = tempDir()
  const seen: Array<{ engine: string; model: string | undefined; title: string }> = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    models: { selectable: true, defaults: { model: "native-a" }, list: () => (options.claude === false ? MODELS.slice(0, 1) : MODELS) as never },
    engine: ({ clock, store }) => {
      const faux = createFauxEngine({ clock, deltaMs: 1 })
      const run = (name: string) => (input: Parameters<typeof faux.runTurn>[0]) => {
        const title = /Your task: (.*)/.exec(input.text)?.[1]?.trim() ?? "?"
        seen.push({ engine: name, model: store.sessionModel(input.sessionId)?.model, title })
        input.emit({ type: "usage", provider: "faux", model: name, input: name === "claude" ? 300 : 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
        return faux.runTurn({ ...input, text: `/say ${name}:${title}` })
      }
      const native = run("native")
      const claude = run("claude")
      return { ...faux, runTurn: (input) => (store.sessionModel(input.sessionId)?.model === "claude-x" ? claude(input) : native(input)) }
    },
  })
  const client = createClient({ socketPath: daemon.socketPath, name: "engines" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  if (options.tier) expect((await client.send({ type: "settings.set", patch: { tier: options.tier } } as never)).ok).toBe(true)
  const start = async (script: string) => {
    const started = await client.send({ type: "workflow.start", directory: project, plan: { script } } as never)
    return started
  }
  const finished = async (workflowId: string, label: string) => {
    await until(() => ["completed", "failed", "paused"].includes(daemon.store.workflows.all().find((run) => run.workflowId === workflowId)?.state ?? ""), label)
    return daemon.store.workflows.all().find((run) => run.workflowId === workflowId)!
  }
  return { daemon, client, start, finished, seen, project }
}
const idOf = (started: { ok: boolean; result?: Record<string, unknown> }) => (started.result?.workflow as WorkflowSummary).workflowId

describe("per-agent engine, model and effort in a script (two faux engines)", () => {
  test("each agent runs on the engine of its model, the row shows it, and usage is counted per engine and in total", async () => {
    const h = await boot({ tier: "full" })
    const script = `export const meta = { name: "two engines", budget: { agents: 6 } }
const a = await agent("on native", { label: "n1", engine: "native", model: "native-a", effort: "high" })
const b = await agent("on claude", { label: "c1", engine: "claude", model: "claude-x", effort: "low" })
const c = await agent("default", { label: "d1" })
return [a, b, c]`
    const started = await h.start(script)
    expect(started.ok).toBe(true)
    const run = await h.finished(idOf(started), "the run to finish")
    expect(run.state).toBe("completed")
    expect(JSON.parse(run.script!.result!)).toEqual(["native:n1", "claude:c1", "native:d1"])
    expect(h.seen.map((entry) => [entry.title, entry.engine, entry.model])).toEqual([["n1", "native", "native-a"], ["c1", "claude", "claude-x"], ["d1", "native", "native-a"]])
    expect(run.tasks.map((task) => [task.label, task.engine, task.modelId])).toEqual([["n1", "native", "native-a"], ["c1", "claude", "claude-x"], ["d1", undefined, undefined]])
    const listed = (await h.client.send({ type: "workflow.list", directory: h.project } as never))
    const summary = ((listed.ok ? listed.result?.workflows : []) as WorkflowSummary[])[0]!
    expect(summary.script?.usage).toMatchObject({ agents: 3, tokens: 150 + 350 + 150, engines: { native: { agents: 1, tokens: 150 }, claude: { agents: 1, tokens: 350 } } })
  }, 60_000)

  test("an unknown engine, a model of another engine and an unconfigured engine are refused before any agent starts", async () => {
    const h = await boot({ tier: "full" })
    const literal = await h.start(`export const meta = { name: "typo" }\nawait agent("x", { engine: "claud", model: "claude-x" })`)
    expect(literal).toMatchObject({ ok: false, error: { message: expect.stringContaining('engine must be "native", "claude"') } })
    const dynamic = await h.start(`export const meta = { name: "mismatch" }\nconst engine = ["native", "claude"][1]\nawait agent("x", { engine, model: "native-a" })`)
    const run = await h.finished(idOf(dynamic), "the mismatch run to fail")
    expect(run).toMatchObject({ state: "failed" })
    expect(run.script?.error).toContain("model native-a runs on native, not on claude")
    expect(h.seen).toEqual([])
    expect(run.tasks).toEqual([])

    const bare = await h.start(`export const meta = { name: "bare" }\nawait agent("x", { engine: ["claude"][0] })`)
    expect((await h.finished(idOf(bare), "the bare run to fail")).script?.error).toContain('needs an exact model of that engine')

    const withTools = await h.start(`export const meta = { name: "tools" }\nawait agent("x", { engine: ["claude"][0], model: "claude-x", allowedTools: ["read"] })`)
    expect((await h.finished(idOf(withTools), "the tools run to fail")).script?.error).toContain("cannot enforce allowedTools")
    expect(h.seen).toEqual([])

    const nobody = await boot({ tier: "full", claude: false })
    const literalClaude = await nobody.start(`export const meta = { name: "none" }\nawait agent("x", { engine: "claude", model: "claude-x" })`)
    expect(literalClaude).toMatchObject({ ok: false, error: { message: expect.stringContaining('unknown engine "claude"; configured: native') } })
    const unknownModel = await nobody.start(`export const meta = { name: "none" }\nawait agent("x", { model: ["nope"][0] })`)
    expect((await nobody.finished(idOf(unknownModel), "the unknown model run to fail")).script?.error).toContain("unknown model nope")
    expect(nobody.seen).toEqual([])
  }, 60_000)

  test("another engine needs the full tier", async () => {
    const h = await boot()
    const started = await h.start(`export const meta = { name: "tier" }\nawait agent("x", { engine: ["claude"][0], model: "claude-x" })`)
    const run = await h.finished(idOf(started), "the tier run to fail")
    expect(run.script?.error).toContain("needs the full tier")
    expect(h.seen).toEqual([])
  }, 60_000)
})
