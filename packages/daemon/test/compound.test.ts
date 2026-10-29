import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelProvider } from "@mendcode/engine-native"
import { createIdFactory, type CompoundConfig, type CompoundProfile, type CompoundRun, type CompoundRunInput, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createCompoundHost } from "../src/compound"
import { compoundHash, readCompoundConfig, resolveCompoundProfiles, writeCompoundConfig } from "../src/compound-config"
import { compoundCheckArgs, type CompoundSnapshot } from "../src/compound-workspace"
import type { ModelCatalog } from "../src/models"
import { createProviderService } from "../src/providers"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b24-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const catalog: ModelCatalog = { selectable: true, defaults: { model: "small", effort: "low" }, list: () => [{ id: "small", name: "Small", efforts: ["low"] }, { id: "big", name: "Big", efforts: ["high"], variants: { review: { effort: "high" } } }] }
const limits = { maxModelRequests: 4, maxTotalTokens: 30_000, maxRuntimeMs: 10_000, unknownCost: "allow-with-token-cap" as const }
const config = (strategy: CompoundProfile["strategy"], enabled = true): CompoundConfig => ({ version: 1, orchestration: { enabled, profiles: { safe: { strategy, primary: { role: "main" }, ...(strategy === "cascade" ? { escalation: { providerID: "openai", modelID: "big" } } : strategy === "critic" ? { critic: { providerID: "openai", modelID: "big", variant: "review" } } : {}), limits: { ...limits } } } } })
const startInput = (directory: string): CompoundRunInput => ({ directory, profile: "safe", prompt: "Repair parser", permission: "ask", checks: [{ id: "diff", command: "git diff --check" }] })
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const snapshot = (text: string): CompoundSnapshot => ({ base: "b".repeat(40), fingerprint: hash(text), diff: text ? "+fixed" : "", files: text ? [{ path: "parser.ts", content: text }] : [] })

function harness(strategy: CompoundProfile["strategy"], input: { codes?: number[]; critic?: string; revision?: string; mutateReview?: boolean; primaryFailure?: boolean; hang?: boolean; failProvider?: boolean } = {}) {
  const dir = temp()
  writeFileSync(path.join(dir, "ai.json"), JSON.stringify(config(strategy)))
  const roles: string[] = []
  const codes = [...(input.codes ?? [0])]
  let candidate = ""
  const host = createCompoundHost({ dir, catalog, supported: true, roles: () => ({}), createSession: () => createIdFactory()("session"), cancel: () => {},
    workspace: async () => ({ path: dir, base: "b".repeat(40) }), snapshot: async () => snapshot(candidate),
    check: async () => { const code = codes.shift() ?? 0; return { exitCode: code, output: code < 0 ? "cannot run executable" : "local check" } },
    execute: async ({ call, signal }) => {
      roles.push(call.role)
      if (input.hang) await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }) })
      if (signal.aborted) return { state: "blocked", text: "", reason: "cancelled" }
      let text = call.role === "critic" ? input.critic ?? '{"verdict":"accept","findings":[],"summary":"checked"}' : call.role === "revision" ? input.revision ?? "disposition: parser.ts fixed" : "candidate"
      const p: ModelProvider = { id: "fake", model: call.choice.model, async *stream() { if (input.failProvider) throw new Error("provider failed"); yield { type: "text", delta: text }; yield { type: "usage", usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }; yield { type: "finish", reason: "stop" } } }
      try { for await (const _ of call.budget.stream(p, { system: "sys", messages: [{ role: "user", content: "task" }], tools: [], signal }, call)) {} }
      catch (error) { return { state: "failed", text: "", reason: String(error) } }
      if (call.role !== "critic" || input.mutateReview) candidate = call.role === "revision" ? "revised" : input.mutateReview && call.role === "critic" ? "changed behind review" : "candidate"
      if (input.primaryFailure && call.role === "primary") return { state: "failed", text, reason: "environment failure" }
      return { state: "completed", text }
    },
  })
  cleanups.push(() => host.dispose())
  const run = () => host.start(startInput(dir))
  async function done(runId: string): Promise<CompoundRun> {
    for (let i = 0; i < 300; i++) { const current = host.report(dir, runId).activeRun!; if (current.state !== "running") return current; await Bun.sleep(1) }
    throw new Error("local compound run did not settle")
  }
  return { host, dir, roles, run, done }
}

test("missing config is off; CAS writes only exact expected configuration", () => {
  const dir = temp()
  expect(readCompoundConfig(dir)).toMatchObject({ config: { orchestration: { enabled: false, profiles: {} } }, issues: [] })
  const before = readCompoundConfig(dir).config
  writeCompoundConfig(dir, config("single"), compoundHash(before))
  expect(() => writeCompoundConfig(dir, config("critic"), compoundHash(before))).toThrow("changed")
  expect(readCompoundConfig(dir).config).toEqual(config("single"))
  writeFileSync(path.join(dir, "ai.json"), "invalid")
  expect(readCompoundConfig(dir).config.orchestration.enabled).toBe(false)
  expect(readCompoundConfig(dir).issues.length).toBe(1)
})
test("resolution checks native models, roles, variants and independent critics", () => {
  const a = config("critic")
  expect(resolveCompoundProfiles(a, catalog, {}).profiles[0]).toMatchObject({ primary: { model: "small", effort: "low" }, critic: { model: "big", variant: "review", effort: "high" } })
  a.orchestration.profiles.safe!.critic = { role: "main" }
  expect(resolveCompoundProfiles(a, catalog, {}).issues[0]).toContain("distinct")
  a.orchestration.profiles.safe!.critic = { role: "small" }
  expect(resolveCompoundProfiles(a, catalog, {}).issues[0]).toContain("not configured")
  a.orchestration.profiles.safe!.critic = { providerID: "unknown", modelID: "big" }
  expect(resolveCompoundProfiles(a, catalog, {}).issues[0]).toContain("unknown model")
})
test("only local deterministic validation families pass the host allowlist", () => {
  for (const command of ["git diff --check", "bun test test/parser.test.ts", "pnpm run typecheck", "python3 -m pytest test_parser.py", "cargo check"]) expect(compoundCheckArgs(command).length).toBeGreaterThan(0)
  for (const command of ["curl example.org", "git diff --check --output=secret", "bun test; rm -rf .", "pnpm install", "bun test /etc/passwd", "bun test ../test.ts"]) expect(() => compoundCheckArgs(command)).toThrow()
})
test("configured provider prices reach immutable compound USD reservations without network", () => {
  const dir = temp()
  const providers = createProviderService({ dir, env: {} })
  const pricing = { inputUsdPer1M: 1, outputUsdPer1M: 2, cacheReadUsdPer1M: .5, cacheWriteUsdPer1M: 1, source: "local test tariff" }
  expect(providers.set({ id: "ollama", models: [{ id: "small", compoundPricing: pricing }] }).ok).toBe(true)
  expect(providers.models()[0]).toMatchObject({ id: "ollama:small", compoundPricing: pricing })
  const cfg = config("single")
  cfg.orchestration.profiles.safe!.primary = { providerID: "ollama", modelID: "small" }
  cfg.orchestration.profiles.safe!.limits.unknownCost = "block"
  const models: ModelCatalog = { selectable: true, list: () => providers.models(), defaults: { model: "ollama:small" } }
  const resolved = resolveCompoundProfiles(cfg, models, {}).profiles[0]!
  expect(resolved.pricing["ollama:small"]).toEqual(pricing)
  providers.set({ id: "ollama", models: [{ id: "small", compoundPricing: { ...pricing, inputUsdPer1M: 0, outputUsdPer1M: 0, cacheReadUsdPer1M: 0, cacheWriteUsdPer1M: 0 } }] })
  expect(resolveCompoundProfiles(cfg, models, {}).profiles[0]!.pricing).toEqual({})
})
test("single accepts host checks and persists a conservative ledger", async () => {
  const h = harness("single")
  const run = await h.done(h.run().runId)
  expect(run.state).toBe("accepted")
  expect(h.roles).toEqual(["primary"])
  expect(run.ledger.requests).toHaveLength(1)
  expect(run.ledger.tokens).toBeGreaterThan(4_096)
  expect(run.fingerprint).toBe(hash("candidate"))
  expect(JSON.parse(readFileSync(path.join(h.dir, "compound-runs", `${run.runId}.json`), "utf8")).state).toBe("accepted")
})
test("cascade escalates once only on quality failures and shares its budget", async () => {
  const h = harness("cascade", { codes: [1, 0] })
  const run = await h.done(h.run().runId)
  expect(run.state).toBe("accepted")
  expect(h.roles).toEqual(["primary", "escalation"])
  expect(run.validation.map((check) => check.status)).toEqual(["quality", "pass"])
  expect(run.legs[0]!.sessionId).toBe(run.legs[1]!.sessionId)
  const failed = harness("cascade", { codes: [1, 1] })
  expect((await failed.done(failed.run().runId)).state).toBe("failed")
  expect(failed.roles).toEqual(["primary", "escalation"])
})
test("environment failures and primary failures never escalate", async () => {
  const h = harness("cascade", { codes: [-1] })
  expect((await h.done(h.run().runId)).state).toBe("blocked")
  expect(h.roles).toEqual(["primary"])
  const primary = harness("cascade", { primaryFailure: true })
  expect((await primary.done(primary.run().runId)).state).toBe("failed")
  expect(primary.roles).toEqual(["primary"])
})
test("critic accepts immutable evidence in a separate session", async () => {
  const h = harness("critic")
  const run = await h.done(h.run().runId)
  expect(run.state).toBe("accepted")
  expect(h.roles).toEqual(["primary", "critic"])
  expect(run.legs[0]!.sessionId).not.toBe(run.legs[1]!.sessionId)
  expect(run.review?.verdict).toBe("accept")
})
test("critic permits one revision with dispositions but never claims independent re-review", async () => {
  const h = harness("critic", { critic: '{"verdict":"revise","findings":[{"path":"parser.ts","line":1,"message":"empty input"}],"summary":"repair"}' })
  const run = await h.done(h.run().runId)
  expect(run.state).toBe("unreviewed-revision")
  expect(run.reason).toContain("not independently reviewed")
  expect(h.roles).toEqual(["primary", "critic", "revision"])
  expect(run.validation).toHaveLength(2)
  expect(run.fingerprint).toBe(hash("revised"))
})
test("malformed, uncertain, escaped and changing critic evidence block", async () => {
  for (const critic of ["not JSON", '{"verdict":"uncertain","findings":[],"summary":"missing evidence"}', '{"verdict":"revise","findings":[{"path":"../secret","message":"x"}],"summary":"x"}', '{"verdict":"accept","findings":[],"summary":"x","extra":1}']) {
    const h = harness("critic", { critic })
    expect((await h.done(h.run().runId)).state).toBe("blocked")
    expect(h.roles).toEqual(["primary", "critic"])
  }
  const changed = harness("critic", { mutateReview: true })
  expect((await changed.done(changed.run().runId)).reason).toContain("changed during")
})
test("critic cannot accept failing checks or omit finding dispositions", async () => {
  const h = harness("critic", { codes: [1] })
  expect((await h.done(h.run().runId)).reason).toContain("failing deterministic")
  const missing = harness("critic", { critic: '{"verdict":"revise","findings":[{"path":"parser.ts","message":"repair"}],"summary":"x"}', revision: "done" })
  expect((await missing.done(missing.run().runId)).reason).toContain("dispositions")
})
test("disabled, overlapping and invalid-check runs are refused before dispatch", async () => {
  const h = harness("single", { hang: true })
  const run = h.run()
  expect(() => h.run()).toThrow("already active")
  h.host.cancel(run.runId)
  expect((await h.done(run.runId)).state).toBe("cancelled")
  const report = h.host.report(h.dir)
  h.host.configure(config("single", false), report.configHash)
  expect(() => h.run()).toThrow("disabled")
  h.host.configure(config("single"), h.host.report(h.dir).configHash)
  expect(() => h.host.start({ ...startInput(h.dir), checks: [{ id: "bad", command: "curl example.org" }] })).toThrow("validation")
})
test("unknown dispatch stays charged and restart never replays saved running receipts", async () => {
  const h = harness("single", { failProvider: true })
  const run = await h.done(h.run().runId)
  expect(run.state).toBe("blocked")
  expect(run.ledger.requests[0]!.state).toBe("unknown")
  run.state = "running"
  run.ledger.requests[0]!.state = "running"
  writeFileSync(path.join(h.dir, "compound-runs", `${run.runId}.json`), JSON.stringify(run))
  const restarted = createCompoundHost({ dir: h.dir, catalog, supported: true, roles: () => ({}), createSession: () => { throw new Error("must not replay") }, cancel: () => {}, execute: async () => { throw new Error("must not replay") } })
  cleanups.push(() => restarted.dispose())
  expect(restarted.report(h.dir, run.runId).activeRun).toMatchObject({ state: "blocked", ledger: { requests: [{ state: "unknown" }] } })
})
test("daemon + typed client executes native compound and preserves the origin model", async () => {
  const dir = temp()
  let candidate = ""
  const seen: string[] = []
  const p: ModelProvider = { id: "fake", model: "small", async *stream(request) { seen.push(request.model!); candidate = "native candidate"; yield { type: "text", delta: "completed" }; yield { type: "usage", usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }; yield { type: "finish", reason: "stop" } } }
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), info: { engine: "native" }, models: catalog,
    compoundHost: { workspace: async () => ({ path: dir, base: "b".repeat(40) }), snapshot: async () => snapshot(candidate), check: async () => ({ exitCode: 0, output: "pass" }) },
    engine: ({ compound }) => createNativeEngine({ provider: p, history: memoryHistory(), tools: [], cwdFor: () => dir, system: () => "system", compactionPrompt: "summarize", compound }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b24" })
  await client.connect()
  cleanups.push(() => client.close())
  const current = await client.compound(dir)
  expect(current.ok && current.report.config.orchestration.enabled).toBe(false)
  if (!current.ok) throw new Error("missing config")
  expect(await client.startCompound(startInput(dir))).toMatchObject({ ok: false })
  expect(await client.configureCompound(config("single"), current.report.configHash)).toMatchObject({ ok: true })
  expect(await client.configureCompound(config("critic"), current.report.configHash)).toMatchObject({ ok: false })
  const origin = await client.send({ type: "session.create", directory: dir, choice: { model: "big", effort: "high" } })
  expect(origin.ok).toBe(true)
  const started = await client.startCompound({ ...startInput(dir), originSessionId: origin.ok ? origin.result?.sessionId as CompoundRunInput["originSessionId"] : undefined } as CompoundRunInput)
  expect(started).toMatchObject({ ok: true })
  let run: CompoundRun | undefined
  for (let i = 0; i < 300; i++) { const result = await client.compound(dir); if (result.ok) run = result.report.activeRun; if (run && run.state !== "running") break; await Bun.sleep(1) }
  expect(run?.state).toBe("accepted")
  expect(run?.ledger.requests).toHaveLength(1)
  expect(seen).toEqual(["small"])
  if (origin.ok) expect(await client.send({ type: "models.list", sessionId: origin.result?.sessionId as SessionId })).toMatchObject({ result: { session: { model: "big", effort: "high" } } })
})
