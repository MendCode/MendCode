import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { BudgetPolicy, type Settings } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-setup-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, models: { selectable: true, defaults: { model: "fake" }, list: () => [{ id: "fake", name: "Fake", efforts: [] }] }, ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "setup-test" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { client, dir }
}

describe("daemon setup control plane", () => {
  test("memory extraction records available usage and obeys the global stop", async () => {
    let calls = 0
    const { client, dir } = await boot({ extractMemory: async (_job, _signal, usage) => { calls++; usage?.({ provider: "fake", model: "fake", input: 500_000, output: 0 }); return [] } })
    const file = path.join(dir, "notes.md")
    writeFileSync(file, "Build with pnpm")
    await client.setBudget(BudgetPolicy.parse({ mode: "api-usage", stopUsd: 0.5, prices: { fake: { input: 1, output: 2 } } }))
    expect(await client.memoryControl(dir, { operation: "propose", fromFile: file, scope: "project" })).toMatchObject({ ok: true })
    expect(await client.budgetStatus(dir)).toMatchObject({ ok: true, result: { enforcement: { state: "stop" }, telemetry: { knownCalls: 1, recordedUsd: 0.5 } } })
    expect(await client.memoryControl(dir, { operation: "propose", fromFile: file, scope: "project" })).toMatchObject({ ok: false })
    expect(calls).toBe(1)
  }, 15_000)
  test("readiness, local plan artifact and doctor never call a provider", async () => {
    let calls = 0
    const { client, dir } = await boot({ complete: async () => { calls++; return "hello" } })
    expect(await client.setupStatus(dir)).toMatchObject({ ok: true, report: { aiReady: true, helper: { ready: true, model: "fake" }, budget: { enforcement: { state: "not-enforced" } } } })
    const plan = await client.send({ type: "setup.plan", directory: dir })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.result).toMatchObject({ callsProviders: false, writesConfig: false, path: path.join(dir, "setup/plan.json") })
      expect(JSON.parse(readFileSync(String(plan.result?.path), "utf8"))).toMatchObject({ readiness: { aiReady: true } })
    }
    expect(await client.send({ type: "setup.doctor", directory: dir })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "budget.doctor", directory: dir })).toMatchObject({ ok: true, result: { ok: true } })
    expect(calls).toBe(0)
  }, 15_000)
  test("presets set prompt/memory/approval and keep models, providers and budgets", async () => {
    const { client, dir } = await boot()
    const budgets = BudgetPolicy.parse({ mode: "api-usage", warnUsd: 2, stopUsd: 5 })
    expect(await client.send({ type: "settings.set", patch: { models: { main: { model: "fake" } }, budgets } })).toMatchObject({ ok: true })
    const minimal = await client.send({ type: "setup.preset", directory: dir, preset: "minimal" })
    expect(minimal).toMatchObject({ ok: true, result: { settings: { setupPreset: "minimal", memoryEnabled: false, memoryUse: false, memoryGenerate: false, defaultPermission: "ask", models: { main: { model: "fake" } }, budgets }, prompt: { mode: "minimal" }, profile: { density: "compact" } } })
    expect(await client.send({ type: "setup.preset", directory: dir, preset: "full" })).toMatchObject({ ok: true, result: { settings: { memoryEnabled: true, memoryRequireApproval: true }, prompt: { mode: "full" } } })
    expect(await client.send({ type: "setup.preset", directory: dir, preset: "custom" })).toMatchObject({ ok: true, result: { settings: { memoryEnabled: true }, prompt: { mode: "full" } } })
  }, 15_000)
  test("helper is tool-less, redacted, priced and blocked at the next call", async () => {
    let calls = 0
    let prompt = ""
    const token = "gh" + "p_" + "a1B2c3D4".repeat(5).slice(0, 36)
    const { client, dir } = await boot({ setupComplete: async (input) => { calls++; prompt = input.prompt; expect(input.system).toContain("no tools"); return { text: `Use /model ${token}`, usage: { provider: "fake", model: "fake", input: 500_000, output: 0 } } } })
    await client.setBudget(BudgetPolicy.parse({ mode: "api-usage", stopUsd: 0.5, prices: { fake: { input: 1, output: 2 } } }))
    const reply = await client.send({ type: "setup.ask", directory: dir, text: `Which model? ${token}`, history: [{ role: "user", text: "Prior question" }] })
    expect(reply).toMatchObject({ ok: true, result: { text: expect.stringContaining("Use /model [redacted:github-token]"), model: "fake", writesConfig: false } })
    expect(prompt).not.toContain(token)
    expect(prompt).toContain("Prior question")
    expect(await client.budgetStatus(dir)).toMatchObject({ ok: true, result: { enforcement: { state: "stop", currentKnownUsd: 0.5 }, telemetry: { knownCalls: 1 } } })
    expect(await client.send({ type: "setup.ask", directory: dir, text: "Again?", history: [] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("Budget stop reached") } })
    expect(calls).toBe(1)
    const settings = await client.send({ type: "settings.get" })
    if (settings.ok) expect((settings.result?.settings as Settings).setupPreset).toBeUndefined()
  })
  test("unavailable services, provider errors and ignored aborts are bounded", async () => {
    const unavailable = await boot()
    expect(await unavailable.client.setupStatus(unavailable.dir)).toMatchObject({ ok: true, report: { helper: { ready: false } } })
    expect(await unavailable.client.send({ type: "setup.ask", directory: unavailable.dir, text: "Hi", history: [] })).toMatchObject({ ok: false })
    const slow = await boot({ setupTimeoutMs: 20, complete: async () => new Promise<string>(() => {}) })
    expect(await slow.client.send({ type: "setup.ask", directory: slow.dir, text: "Hi", history: [] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("timed out") } })
    const fail = await boot({ complete: async () => { throw new Error("Fake provider failure") } })
    expect(await fail.client.send({ type: "setup.ask", directory: fail.dir, text: "Hi", history: [] })).toMatchObject({ ok: false, error: { message: "Fake provider failure" } })
  })
})
