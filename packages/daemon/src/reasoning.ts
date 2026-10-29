import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, closeSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ReasoningPolicy, type ModelRole, type ReasoningPolicy as Policy, type ReasoningReport, type SessionId } from "@mendcode/protocol"
import { featureOn, findModel } from "@mendcode/protocol/wire"
import { createReasoningController, type ReasoningEvaluator } from "@mendcode/engine-native"
import type { Store } from "@mendcode/store"
import { resolveModel, type ModelCatalog } from "./models"
import { rolesFor } from "./profiles"
import type { BudgetPort } from "./budgets"

const defaults: Policy = { version: 1, mode: "off", remoteProcessing: false, provider: "openrouter", maxLeaseSteps: 2, maxDecisionsPerTurn: 8, failureMode: "pause" }
const stored = z.strictObject({ revision: z.string().uuid(), config: ReasoningPolicy })
const restriction = ReasoningPolicy.pick({ mode: true, remoteProcessing: true, maxLeaseSteps: true, maxDecisionsPerTurn: true }).partial()
const ranks = { off: 0, shadow: 1, adaptive: 2 }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function read(file: string): string | undefined {
  try { lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > 65536) throw new Error("Invalid reasoning policy")
    const bytes = Buffer.alloc(65537)
    let count = 0
    for (;;) {
      const size = readSync(descriptor, bytes, count, bytes.length - count, null)
      count += size
      if (count > 65536) throw new Error("Invalid reasoning policy")
      if (!size) return bytes.subarray(0, count).toString("utf8")
    }
  } finally { closeSync(descriptor) }
}

export function createReasoningService(input: { safeMode?: boolean; dir: string; store: Store; catalog: ModelCatalog; engine: string; evaluator?: ReasoningEvaluator; budget: BudgetPort }) {
  const location = (directory: string) => {
    const root = realpathSync(directory)
    const folder = path.join(input.dir, "reasoning", digest(root))
    return { root, folder, file: path.join(folder, "consent.json"), restriction: path.join(root, ".mendcode", "adaptive-reasoning.json") }
  }
  function report(directory: string, sessionId?: SessionId): ReasoningReport {
    // JEV is the `jev` feature: on in the `full` tier, or by its own flag, unless `features.jev` says otherwise (docs/tiers.md).
    const reasoningAuto = featureOn(input.store.settings.get(), "jev", { safeMode: input.safeMode })
    try {
      const files = location(directory)
      for (const folder of [path.dirname(files.folder), files.folder, path.dirname(files.restriction)]) {
        try { if (lstatSync(folder).isSymbolicLink()) throw new Error("Unsafe reasoning policy directory") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
      const raw = read(files.file)
      const rawRestriction = read(files.restriction)
      const consent = raw === undefined ? { ...defaults } : stored.parse(JSON.parse(raw)).config
      const limits = rawRestriction === undefined ? {} : restriction.parse(JSON.parse(rawRestriction))
      const config = { ...consent }
      if (limits.mode && ranks[limits.mode] < ranks[config.mode]) config.mode = limits.mode
      if (limits.remoteProcessing === false) config.remoteProcessing = false
      if (limits.maxLeaseSteps) config.maxLeaseSteps = Math.min(config.maxLeaseSteps, limits.maxLeaseSteps) as Policy["maxLeaseSteps"]
      if (limits.maxDecisionsPerTurn) config.maxDecisionsPerTurn = Math.min(config.maxDecisionsPerTurn, limits.maxDecisionsPerTurn)
      const receipt = sessionId ? port.receipt(sessionId) : undefined
      return { config, consent, revision: digest(JSON.stringify([raw ?? null, rawRestriction ?? null, reasoningAuto])), valid: true, evaluatorReady: !!input.evaluator && input.engine === "native" && input.catalog.selectable, reasoningAuto, ...(receipt ? { receipt } : {}) }
    } catch { return { config: { ...defaults }, consent: { ...defaults }, revision: "invalid", valid: false, evaluatorReady: false, reasoningAuto } }
  }
  const snapshot = (sessionId: SessionId, role: ModelRole) => {
    const directory = input.store.sessionInfo(sessionId)?.directory
    if (!directory) throw new Error("Unknown reasoning session")
    const roles = rolesFor(input.store.settings.get(), directory)
    const session = input.store.sessionModel(sessionId)
    const choice = resolveModel({ role, session, roles, catalog: input.catalog })
    const info = findModel(input.catalog.list(true), choice.model)
    const selected = role === "main" ? session ?? roles.main : roles[role] ?? session ?? roles.main
    return { report: report(directory), choice, binding: JSON.stringify([directory, role, choice, selected]), efforts: info?.engine ? [] : info?.efforts ?? [], manual: !!(selected?.effort || selected?.variant || selected?.parameters) }
  }
  const evaluate: ReasoningEvaluator | undefined = input.evaluator ? async (request) => {
    const model = request.policy.provider === "openrouter" ? "typesafe/jev-1.13" : "typesafe-ai/jev"
    await input.budget.guard({ model, signal: request.signal })
    try {
      const decision = await input.evaluator!(request)
      input.budget.record({ provider: request.policy.provider, model, input: decision.inputTokens ?? 0, output: decision.outputTokens ?? 0, ...(decision.costMicros === undefined ? {} : { costMicros: decision.costMicros }) })
      return decision
    } catch (error) {
      input.budget.record()
      throw error
    }
  } : undefined
  const port = createReasoningController({ snapshot, ...(evaluate ? { evaluate } : {}) })
  function configure(directory: string, config: Policy, expectedRevision: string) {
    const parsed = ReasoningPolicy.parse(config)
    const current = report(directory)
    if (!current.valid || current.revision !== expectedRevision) throw new Error("Reasoning policy changed; reload before saving")
    const files = location(directory)
    for (const folder of [input.dir, path.join(input.dir, "reasoning"), files.folder]) {
      if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())) throw new Error("Unsafe reasoning policy directory")
      mkdirSync(folder, { recursive: true, mode: 0o700 })
    }
    const temporary = path.join(files.folder, `${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify({ revision: randomUUID(), config: parsed }) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temporary, files.file)
    port.invalidate()
    return report(directory)
  }
  return { report, configure, port }
}
