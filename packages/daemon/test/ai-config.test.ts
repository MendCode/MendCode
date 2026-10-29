import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type AIConfigInput, type AIConfigPlan, type ModelInfo, type Settings } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createAIConfigService } from "../src/ai-config"
import { readRecipes } from "../src/recipes"
import { createProviderService } from "../src/providers"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const models: ModelInfo[] = [
  { id: "local:large", name: "Large", provider: "local", efforts: ["low", "high"], variants: { careful: { effort: "high" } } },
  { id: "local:small", name: "Small", provider: "local", efforts: [] },
  { id: "subscription", name: "Subscription", efforts: [] },
  { id: "claude", name: "Claude Code", engine: "claude", efforts: [] },
]
const catalog = { selectable: true, list: () => models, defaults: { model: "subscription" } }
const planInput = { action: "plan", scope: "project", intent: "economical", taskKind: "repair", candidates: [{ model: "local:large" }, { model: "local:small" }] } as const
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "mendcode-ai-config-"))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, "project"), dir = path.join(base, "data")
  mkdirSync(project)
  mkdirSync(dir)
  const sessionId = ids("session")
  const settings: Settings = { models: { main: { model: "subscription" }, small: { model: "local:small" } }, budgets: { mode: "api-usage", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false, suppliedUsd: null, prices: { "local:large": { input: 2, output: 8 }, "local:small": { input: .1, output: .4 }, subscription: { input: 0, output: 0 } } } }
  const service = createAIConfigService({ dir, catalog, settings: () => settings, engine: "native", providers: () => [{ id: "local", baseUrl: "http://user:secret@127.0.0.1:11434/v1?key=hidden", enabled: true }], sessionDirectory: (id) => id === sessionId ? project : undefined, now: () => 42 })
  const run = (input: unknown) => service.run(project, input)
  const plan = (extra: object = {}) => run({ ...planInput, ...extra }) as AIConfigPlan
  const apply = (preview: AIConfigPlan, extra: object = {}) => run({ action: "apply", scope: preview.target.scope, target: preview.target.path, patch: preview.patch, expectedHash: preview.expectedHash, sessionId, confirm: true, ...extra })
  return { project, dir, sessionId, settings, service, run, plan, apply }
}

test("B70 inspect, plan and validate never write or call providers; inventory omits credentials", () => {
  const h = fixture()
  const inspection = h.run({ action: "inspect" })
  expect(inspection.action).toBe("inspect")
  expect(JSON.stringify(inspection)).not.toContain("secret")
  expect(JSON.stringify(inspection)).not.toContain("hidden")
  if (inspection.action !== "inspect") throw new Error("inspect")
  expect(inspection.models.find((model) => model.id === "local:large")?.apiOrigin).toBe("http://127.0.0.1:11434")
  expect(inspection.models.find((model) => model.id === "subscription")?.pricing).toBeNull()
  expect(inspection.advisor).toBe("off")
  expect(inspection.missingInformation.join(" ")).toContain("/compound")
  expect(inspection.missingInformation.join(" ")).not.toContain("B24")
  const plan = h.plan()
  expect(plan.patch.roles.main?.model).toBe("local:small")
  expect(plan.alternatives.every((item) => item.strategy === "single" && item.feasibility === "feasible")).toBe(true)
  expect(plan.alternatives[0]?.estimatedMaxCostUsd).toBe(.0128)
  expect(plan.evidence).toMatchObject({ observedAt: 42, callsProviders: false, quality: "unknown" })
  expect(h.run({ action: "validate", patch: plan.patch, scope: "project", target: plan.target.path, expectedHash: plan.expectedHash })).toMatchObject({ valid: true, diff: plan.diff })
  expect(readdirSync(h.project)).toEqual([])
  expect(readdirSync(h.dir)).toEqual([])
})

test("B70 quality keeps supplied order, role candidates resolve, unknown prices stay unknown", () => {
  const h = fixture()
  expect(h.plan({ intent: "quality" }).patch.roles.main?.model).toBe("local:large")
  expect(h.plan({ candidates: [], selectedRoles: ["small"] }).patch.roles.main?.model).toBe("local:small")
  expect(h.plan({ candidates: [{ model: "subscription" }] }).alternatives[0]?.estimatedMaxCostUsd).toBeNull()
  for (const extra of [{ candidates: [] }, { candidates: [{ model: "gone" }] }, { candidates: [{ model: "local:large", effort: "medium" }] }, { candidates: [{ model: "local:large", variant: "gone" }] }]) expect(() => h.plan(extra)).toThrow()
})

test("B70 real provider inventory stays read-only, including file permissions and cached reads", () => {
  const h = fixture()
  const file = path.join(h.dir, "providers.json")
  writeFileSync(file, JSON.stringify({ providers: { local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:11434", models: [{ id: "large" }, { id: "small" }] } } }), { mode: 0o644 })
  const before = readFileSync(file, "utf8")
  const providers = createProviderService({ dir: h.dir, env: {}, fetch: async () => { throw new Error("No network") } })
  const service = createAIConfigService({ dir: h.dir, catalog: { selectable: true, defaults: catalog.defaults, list: (readOnly) => providers.models(readOnly) }, settings: () => h.settings, engine: "native", providers: () => providers.list(true), sessionDirectory: () => h.project, now: () => 42 })
  service.run(h.project, { action: "inspect" })
  const planned = service.run(h.project, { ...planInput, candidates: [...planInput.candidates] }) as AIConfigPlan
  service.run(h.project, { action: "validate", patch: planned.patch, scope: "project", target: planned.target.path, expectedHash: planned.expectedHash })
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(statSync(file).mode & 0o777).toBe(0o644)
  providers.list()
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("B70 exact apply persists a compatible recipe without altering roles; repeat is a no-op", () => {
  const h = fixture()
  const before = JSON.stringify(h.settings)
  const planned = h.plan()
  const applied = h.apply(planned)
  expect(applied).toMatchObject({ action: "apply", changed: true, backupPath: null })
  expect(statSync(planned.target.path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(planned.target.path, "utf8"))).toEqual(planned.patch)
  expect(JSON.stringify(h.settings)).toBe(before)
  expect(readRecipes([{ dir: path.join(h.project, ".mendcode"), source: "project" }])[0]).toMatchObject({ name: "repair-economical", roles: planned.patch.roles })
  const next = h.plan()
  expect(h.apply(next)).toMatchObject({ changed: false, beforeHash: next.expectedHash, afterHash: next.expectedHash })
})

test("B70 replacement preserves a byte-exact backup and stale/wrong-project apply writes nothing", () => {
  const h = fixture()
  const initial = h.plan()
  h.apply(initial)
  const before = readFileSync(initial.target.path, "utf8")
  expect(() => h.apply(initial)).toThrow("Target changed")
  const update = h.plan({ intent: "quality", target: initial.target.path })
  expect(() => h.apply(update, { sessionId: ids("session") })).toThrow("causal session")
  expect(readFileSync(initial.target.path, "utf8")).toBe(before)
  const result = h.apply(update)
  if (result.action !== "apply") throw new Error("apply")
  expect(readFileSync(result.backupPath!, "utf8")).toBe(before)
  expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600)
})

test("B70 refuses traversal, symlink targets/parents, malformed files and unavailable role bindings", () => {
  const h = fixture()
  expect(() => h.plan({ target: path.join(h.project, "outside.json") })).toThrow("Target must")
  const folder = path.join(h.project, ".mendcode", "recipes")
  mkdirSync(folder, { recursive: true })
  const linked = path.join(folder, "linked.json")
  symlinkSync(path.join(h.dir, "external.json"), linked)
  expect(() => h.plan({ target: linked })).toThrow("symlinks")
  const malformed = path.join(folder, "bad.json")
  writeFileSync(malformed, "{ broken")
  expect(() => h.plan({ target: malformed })).toThrow("valid recipe")
  const planned = h.plan()
  expect(h.run({ action: "validate", scope: "project", target: planned.target.path, patch: { description: "Auxiliary", roles: { compaction: { model: "claude" } } } })).toMatchObject({ valid: false })
  const other = fixture()
  symlinkSync(other.dir, path.join(other.project, ".mendcode"))
  expect(() => other.plan()).toThrow("symlinks")
})

test("B70 global scope is opt-in and constrained to this daemon's recipes folder", () => {
  const h = fixture()
  const planned = h.plan({ scope: "global" })
  expect(planned.target.path).toStartWith(path.join(realpathSync(h.dir), "recipes"))
  h.apply(planned)
  expect(existsSync(path.join(h.project, ".mendcode"))).toBe(false)
  expect(() => h.plan({ scope: "global", target: path.join(h.project, ".mendcode", "recipes", "escape.json") })).toThrow()
})

test("B70 daemon/client RPC checks causality, persists across restart and preserves active model", async () => {
  const h = fixture()
  const boot = () => startDaemon({ dir: h.dir, socketPath: path.join(h.dir, "mendd.sock"), models: catalog, info: { engine: "native" }, providers: { list: () => [{ id: "local", type: "openai-compatible", baseUrl: "http://127.0.0.1:11434", enabled: true, hasKey: false, source: "config", models: [] }], models: () => models, runtime: () => ({}), set: () => ({ ok: false, code: "invalid_command", message: "unused" }), remove: () => ({ ok: false, code: "invalid_command", message: "unused" }), test: async () => undefined, refresh: async () => ({ ok: false, code: "invalid_command", message: "unused" }) }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  let daemon = await boot()
  let client = createClient({ socketPath: daemon.socketPath, name: "B70", reconnect: false })
  cleanups.push(() => daemon.stop(), () => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: h.project })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as ReturnType<typeof ids<"session">>
  await client.send({ type: "session.model.set", sessionId, choice: { model: "subscription" } })
  const reply = await client.aiConfig(h.project, { ...planInput, candidates: [...planInput.candidates] })
  if (!reply.ok || reply.report.action !== "plan") throw new Error("plan RPC failed")
  const preview = reply.report
  const apply: AIConfigInput = { action: "apply", patch: preview.patch, scope: "project", target: preview.target.path, expectedHash: preview.expectedHash, sessionId, confirm: true }
  expect(await client.aiConfig(h.project, apply)).toMatchObject({ ok: true, report: { changed: true } })
  expect(await client.aiConfig(h.project, apply)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(await client.send({ type: "models.list", sessionId })).toMatchObject({ ok: true, result: { session: { model: "subscription" }, roles: {} } })
  client.close()
  await daemon.stop()
  daemon = await boot()
  client = createClient({ socketPath: daemon.socketPath, name: "B70-restart", reconnect: false })
  await client.connect()
  expect(await client.send({ type: "recipes.list", directory: h.project })).toMatchObject({ ok: true, result: { recipes: expect.arrayContaining([expect.objectContaining({ name: "repair-economical", roles: preview.patch.roles })]) } })
  expect(await client.aiConfig(h.project, { ...apply, sessionId: ids("session") })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})

test("inspect names the model an engine alias last ran on, so the model knows which Opus claude-opus is", () => {
  const base = mkdtempSync(path.join(tmpdir(), "mendcode-ai-config-"))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const claude: ModelInfo[] = [{ id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["high"], contextWindow: 200_000, engine: "claude" }, { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", efforts: [], contextWindow: 200_000, engine: "claude" }]
  const service = createAIConfigService({ dir: base, catalog: { selectable: true, list: () => claude, defaults: { model: "claude-opus" } }, resolve: (list) => list.map((model) => model.id === "claude-opus" ? { ...model, resolved: "claude-opus-5-5" } : model), settings: () => ({}) as Settings, engine: "native", sessionDirectory: () => base, now: () => 42 })
  const inspection = service.run(base, { action: "inspect" }) as { models: Array<{ id: string; resolved?: string }> }
  expect(inspection.models.find((model) => model.id === "claude-opus")?.resolved).toBe("claude-opus-5-5")
  expect(inspection.models.find((model) => model.id === "claude-sonnet")?.resolved).toBeUndefined()
})
