import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, isReadOnlyCommand, type ReasoningPolicy } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createReasoningService } from "../src/reasoning"
import { startDaemon } from "../src"
import type { ModelCatalog } from "../src/models"
import type { BudgetPort } from "../src/budgets"

const ids = createIdFactory()
const config: ReasoningPolicy = { version: 1, mode: "adaptive", remoteProcessing: true, provider: "openrouter", maxLeaseSteps: 2, maxDecisionsPerTurn: 8, failureMode: "pause" }
const catalog: ModelCatalog = { selectable: true, defaults: { model: "local:main", effort: "low" }, list: () => [{ id: "local:main", name: "Local", efforts: ["low", "medium", "high"], defaultEffort: "low" }] }
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b25-daemon-"))
  const project = path.join(dir, "project")
  mkdirSync(project)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, project }
}

function service(budget?: BudgetPort) {
  const files = workspace()
  const store = openStore({ dir: files.dir })
  cleanups.push(() => store.close())
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: files.project, title: "B25" })
  let calls = 0
  const reasoning = createReasoningService({ ...files, store, catalog, engine: "native", budget: budget ?? { guard: async () => {}, record() {}, price: () => undefined }, evaluator: async () => { calls++; return { effort: "high", leaseSteps: 2, inputTokens: 12, outputTokens: 3, costMicros: 100 } } })
  const generation = () => ({ sessionId, turnId: "turn", role: "main" as const, choice: { model: "local:main", effort: "low" as const }, messages: [{ role: "user" as const, content: "Fix parser" }], signal: new AbortController().signal, manual: false })
  return { ...files, store, sessionId, reasoning, generation, calls: () => calls }
}

describe("B25 host-owned consent", () => {
  test("default off, guarded private persistence, restrictions only reduce consent and revisions reject stale writes", () => {
    const harness = service()
    const initial = harness.reasoning.report(harness.project)
    expect(initial).toMatchObject({ config: { mode: "off", remoteProcessing: false }, valid: true, reasoningAuto: false })
    const active = harness.reasoning.configure(harness.project, config, initial.revision)
    expect(active.config).toEqual(config)
    const folder = path.join(harness.dir, "reasoning", createHash("sha256").update(realpathSync(harness.project)).digest("hex"))
    expect(lstatSync(path.join(folder, "consent.json")).mode & 0o777).toBe(0o600)
    expect(lstatSync(folder).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path.join(folder, "consent.json"), "utf8")).config).toEqual(config)
    expect(() => harness.reasoning.configure(harness.project, config, initial.revision)).toThrow("changed")
    mkdirSync(path.join(harness.project, ".mendcode"))
    writeFileSync(path.join(harness.project, ".mendcode", "adaptive-reasoning.json"), JSON.stringify({ mode: "shadow", remoteProcessing: false, maxLeaseSteps: 1, maxDecisionsPerTurn: 2 }))
    const restricted = harness.reasoning.report(harness.project)
    expect(restricted.config).toMatchObject({ mode: "shadow", remoteProcessing: false, maxLeaseSteps: 1, maxDecisionsPerTurn: 2 })
    expect(restricted.consent).toEqual(config)
    const disabled = harness.reasoning.configure(harness.project, { ...config, mode: "off", remoteProcessing: false }, restricted.revision)
    writeFileSync(path.join(harness.project, ".mendcode", "adaptive-reasoning.json"), JSON.stringify({ mode: "adaptive", remoteProcessing: true }))
    expect(harness.reasoning.report(harness.project).config.mode).toBe("off")
    expect(disabled.config.remoteProcessing).toBe(false)
  })

  test("invalid JSON, unknown fields, oversized and symlinked policies fail off", () => {
    const harness = service()
    mkdirSync(path.join(harness.project, ".mendcode"))
    const restriction = path.join(harness.project, ".mendcode", "adaptive-reasoning.json")
    for (const content of ["{", '{"provider":"openrouter"}', " ".repeat(65537)]) {
      writeFileSync(restriction, content)
      const report = harness.reasoning.report(harness.project)
      expect(report).toMatchObject({ valid: false, config: { mode: "off", remoteProcessing: false }, revision: "invalid" })
      expect(() => harness.reasoning.configure(harness.project, config, report.revision)).toThrow()
    }
    rmSync(restriction)
    symlinkSync(path.join(harness.dir, "missing.json"), restriction)
    expect(harness.reasoning.report(harness.project).valid).toBe(false)
  })

  test("evaluation checks spend and records measured cost without selecting another provider/model", async () => {
    const ledger: unknown[] = []
    const guarded: string[] = []
    const harness = service({ guard: async ({ model }) => { guarded.push(model) }, record: (usage) => { ledger.push(usage) }, price: () => undefined })
    harness.reasoning.configure(harness.project, config, harness.reasoning.report(harness.project).revision)
    const prepared = await harness.reasoning.port.prepare(harness.generation())
    expect(prepared.effort).toBe("high")
    prepared.dispatch()
    expect(guarded).toEqual(["typesafe/jev-1.13"])
    expect(ledger).toEqual([{ provider: "openrouter", model: "typesafe/jev-1.13", input: 12, output: 3, costMicros: 100 }])
    harness.store.setSessionModel(harness.sessionId, { model: "local:main", effort: "medium" })
    expect((await harness.reasoning.port.prepare({ ...harness.generation(), choice: { model: "local:main", effort: "medium" } })).effort).toBe("medium")
    expect(harness.calls()).toBe(1)
    harness.reasoning.port.dispose()
  })

  test("budget refusal stops before evaluator invocation and baseline mode stays local", async () => {
    const harness = service({ guard: async () => { throw new Error("Budget reached") }, record() {}, price: () => undefined })
    harness.reasoning.configure(harness.project, config, harness.reasoning.report(harness.project).revision)
    await expect(harness.reasoning.port.prepare(harness.generation())).rejects.toMatchObject({ code: "response" })
    expect(harness.calls()).toBe(0)
    harness.reasoning.configure(harness.project, { ...config, failureMode: "baseline" }, harness.reasoning.report(harness.project).revision)
    expect((await harness.reasoning.port.prepare({ ...harness.generation(), turnId: "next" })).effort).toBe("low")
    harness.reasoning.port.dispose()
  })

  test("RPC validates confirmation, project scope and client helpers; experimental settings preserve unrelated flags", async () => {
    const files = workspace()
    const daemon = await startDaemon({ dir: files.dir, socketPath: path.join(files.dir, "daemon.sock"), models: catalog, info: { engine: "native" }, reasoningEvaluator: async () => ({ effort: "high", leaseSteps: 2 }), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "B25" })
    cleanups.push(() => client.close())
    await client.connect()
    const session = await client.send({ type: "session.create", directory: files.project })
    if (!session.ok) throw new Error(session.error.message)
    const sessionId = session.result!.sessionId as ReturnType<typeof ids<"session">>
    const initial = await client.reasoningStatus(files.project, sessionId)
    if (!initial.ok) throw new Error(initial.error.message)
    expect(initial.report.config.mode).toBe("off")
    expect(await client.reasoningStatus(realpathSync(files.project), sessionId)).toMatchObject({ ok: true, report: { revision: initial.report.revision } })
    const saved = await client.configureReasoning(files.project, config, initial.report.revision, true)
    expect(saved).toMatchObject({ ok: true, report: { config } })
    expect(await client.configureReasoning(files.project, config, initial.report.revision, true)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.reasoningStatus(files.dir, sessionId)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await client.send({ type: "settings.set", patch: { experimental: { reasoning_auto: true, continue_loop_on_deny: true } } })).toMatchObject({ ok: true })
    const current = await client.reasoningStatus(files.project, sessionId)
    expect(current).toMatchObject({ ok: true, report: { reasoningAuto: true } })
    const listed = await client.send({ type: "models.list", sessionId })
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.result).toMatchObject({ reasoning: { reasoningAuto: true } })
    expect(isReadOnlyCommand("reasoning.configure")).toBe(false)
    expect(isReadOnlyCommand("reasoning.status")).toBe(false)
  }, 10000)
})
