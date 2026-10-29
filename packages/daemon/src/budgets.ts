import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BudgetPolicy, type BudgetReport, type Settings } from "@mendcode/protocol"
import type { TurnInput } from "@mendcode/kernel"

export type BudgetUsage = { provider: string; model: string; input: number; output: number; reasoning?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined; costMicros?: number | undefined }
export type BudgetPort = {
  guard(input: { model: string; signal: AbortSignal; ask?: TurnInput["ask"] }): Promise<void>
  record(usage?: BudgetUsage): void
  price(usage: BudgetUsage): number | undefined
}
type Ledger = { version: 1; costMicros: number; knownCalls: number; unknownCalls: number }

/** Lifetime spend for this daemon data dir, including helper calls and deleted sessions. */
export function createBudgets(input: { dir: string; settings(): Settings; seed(): Omit<Ledger, "version"> }) {
  const file = path.join(input.dir, "budget", "spend.json")
  const initial = input.seed()
  const policy = () => BudgetPolicy.parse(input.settings().budgets ?? {})
  function ledger(): Ledger {
    const value = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, ...initial }
    if (value.version !== 1 || ![value.costMicros, value.knownCalls, value.unknownCalls].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid budget spend ledger")
    return value
  }
  function save(value: Ledger) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 })
    renameSync(file + ".tmp", file)
  }
  function price(usage: BudgetUsage): number | undefined {
    if (usage.costMicros !== undefined) return Number.isSafeInteger(usage.costMicros) && usage.costMicros >= 0 ? usage.costMicros : undefined
    if (![usage.input, usage.output, usage.reasoning ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0)) return undefined
    const rates = policy().prices[usage.model] ?? policy().prices[`${usage.provider}:${usage.model}`]
    if (!rates || usage.cacheRead && rates.cacheRead === undefined || usage.cacheWrite && rates.cacheWrite === undefined) return undefined
    const micros = Math.round(usage.input * rates.input + (usage.output + (usage.reasoning ?? 0)) * rates.output + (usage.cacheRead ?? 0) * (rates.cacheRead ?? 0) + (usage.cacheWrite ?? 0) * (rates.cacheWrite ?? 0))
    return Number.isSafeInteger(micros) && micros >= 0 ? micros : undefined
  }
  function record(usage?: BudgetUsage) {
    const value = ledger()
    const micros = usage ? price(usage) : undefined
    if (micros === undefined) value.unknownCalls++
    else { value.knownCalls++; value.costMicros += micros }
    save(value)
  }
  function report(model: string): BudgetReport {
    const config = policy()
    const value = ledger()
    const pricingKnown = config.prices[model] !== undefined
    const enforced = config.mode === "api-usage" && pricingKnown
    const currentKnownUsd = value.costMicros / 1_000_000 + (config.suppliedUsd ?? 0)
    const warnings: string[] = []
    const blockers: string[] = []
    let state: BudgetReport["enforcement"]["state"] = enforced ? "ok" : "not-enforced"
    if (config.mode === "api-usage" && !pricingKnown) warnings.push("Pricing unavailable for selected model; USD limits are not enforced")
    if (config.mode === "api-usage" && value.unknownCalls) warnings.push(`${value.unknownCalls} calls have unknown cost`)
    if (enforced && config.warnUsd !== null && currentKnownUsd >= config.warnUsd) {
      state = "warn"
      warnings.push(`Known spend $${currentKnownUsd.toFixed(6)} reached warnUsd $${config.warnUsd}`)
    }
    if (enforced && config.stopUsd !== null && currentKnownUsd >= config.stopUsd) {
      state = "stop"
      blockers.push(`Budget stop reached: $${currentKnownUsd.toFixed(6)} >= $${config.stopUsd}`)
    }
    return { policy: config, enforcement: { model, pricingKnown, enforced, state, currentKnownUsd, warnings, blockers }, telemetry: { recordedUsd: value.costMicros / 1_000_000, suppliedUsd: config.suppliedUsd, knownCalls: value.knownCalls, unknownCalls: value.unknownCalls } }
  }
  function doctor(model: string) {
    try {
      const status = report(model)
      return { ok: true, failures: [] as string[], warnings: status.enforcement.warnings, enforcement: status.enforcement }
    } catch (error) {
      return { ok: false, failures: [(error as Error).message], warnings: [] as string[] }
    }
  }
  async function guard(request: Parameters<BudgetPort["guard"]>[0]) {
    if (request.signal.aborted) throw new Error("Budget check cancelled")
    const status = report(request.model)
    if (status.enforcement.blockers.length) throw new Error(status.enforcement.blockers.join("; "))
    if (status.enforcement.enforced && status.policy.expensiveModelRequiresConfirm && status.policy.prices[request.model]?.expensive) {
      if (!request.ask) throw new Error(`Expensive model ${request.model} requires foreground confirmation`)
      const answer = await request.ask({ kind: "approval", title: "Expensive API model", detail: `${request.model}\nKnown spend: $${status.enforcement.currentKnownUsd.toFixed(6)}\nApprove this model call?` })
      if (request.signal.aborted || answer.kind !== "approve") throw new Error("Expensive model call was not approved")
      const after = report(request.model)
      if (after.enforcement.blockers.length) throw new Error(after.enforcement.blockers.join("; "))
    }
  }
  return { report, doctor, guard, record, price, policy }
}
