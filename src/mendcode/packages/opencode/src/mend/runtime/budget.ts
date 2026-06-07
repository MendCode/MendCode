import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { modelPresets, resolveModelRoles } from "../config/models"

type BudgetSpendState = {
  version: 0
  telemetry: { available: boolean; source: string | null; currentUsd: number | null; updatedAt: string | null }
  notes?: string[]
}

const defaultSpendState: BudgetSpendState = {
  version: 0,
  telemetry: { available: false, source: null, currentUsd: null, updatedAt: null },
  notes: ["Spend telemetry state file has not been initialized yet."],
}

async function readJsonIfExists<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readLines(file: string) {
  if (!existsSync(file)) return []
  return (await readFile(file, "utf8")).split("\n").filter(Boolean)
}

export async function readBudgetSpendState(root?: string) {
  return readJsonIfExists(mendPaths(root).budgetSpendState, defaultSpendState)
}

export function validateBudgetSpendState(state: BudgetSpendState) {
  const failures: string[] = []
  const warnings: string[] = []
  if (state.version !== 0) failures.push("budget spend-state version must be 0")
  if (typeof state.telemetry?.available !== "boolean") failures.push("budget telemetry.available must be boolean")
  if (state.telemetry?.available === false) {
    if (state.telemetry.currentUsd !== null) failures.push("budget telemetry.currentUsd must be null when available=false")
    if (state.telemetry.source !== null) failures.push("budget telemetry.source must be null when available=false")
  }
  if (state.telemetry?.available === true) {
    if (typeof state.telemetry.source !== "string" || !state.telemetry.source) failures.push("budget telemetry.source is required when available=true")
    if (typeof state.telemetry.currentUsd !== "number" || state.telemetry.currentUsd < 0) failures.push("budget telemetry.currentUsd must be a non-negative number when available=true")
  }
  return { failures, warnings }
}

export async function runHistoryRecords(root?: string, limit = 1000) {
  const lines = await readLines(mendPaths(root).runHistory)
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

export function summarizeRunHistory(records: any[], root?: string) {
  const paths = mendPaths(root)
  const byProvider: Record<string, any> = {}
  const totals = {
    runs: records.length,
    ok: 0,
    failed: 0,
    estimatedUsd: 0,
    estimatedUsdAvailableRuns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  for (const record of records) {
    if (record.ok) totals.ok++
    else totals.failed++
    const providerID = record.selected?.providerID || "unknown"
    byProvider[providerID] ||= { runs: 0, ok: 0, failed: 0, estimatedUsd: 0, estimatedUsdAvailableRuns: 0, totalTokens: 0 }
    byProvider[providerID].runs++
    if (record.ok) byProvider[providerID].ok++
    else byProvider[providerID].failed++
    const normalized = record.telemetry?.usageNormalized
    if (normalized?.available) {
      totals.inputTokens += normalized.inputTokens || 0
      totals.cachedInputTokens += normalized.cachedInputTokens || 0
      totals.outputTokens += normalized.outputTokens || 0
      totals.reasoningTokens += normalized.reasoningTokens || 0
      totals.totalTokens += normalized.totalTokens || 0
      byProvider[providerID].totalTokens += normalized.totalTokens || 0
    }
    const cost = record.telemetry?.cost
    if (cost?.available && typeof cost.estimatedUsd === "number") {
      totals.estimatedUsd += cost.estimatedUsd
      totals.estimatedUsdAvailableRuns++
      byProvider[providerID].estimatedUsd += cost.estimatedUsd
      byProvider[providerID].estimatedUsdAvailableRuns++
    }
  }
  return {
    path: paths.runHistory.replace(`${paths.root}/`, ""),
    lastRunAt: records.at(-1)?.endedAt || null,
    totals,
    byProvider,
    note: "Local run history is ignored by git. Dollar totals include only runs where provider/API pricing is available; subscription OAuth token usage is counted but not priced.",
  }
}

function knownRunHistoryUsd(summary: ReturnType<typeof summarizeRunHistory>) {
  return summary.totals.estimatedUsdAvailableRuns ? summary.totals.estimatedUsd || 0 : 0
}

function pricingPreset(providerID?: string | null, modelID?: string | null, authMode?: string | null) {
  return Object.values(modelPresets).find((preset) => {
    if (providerID && preset.providerID !== providerID) return false
    if (modelID && preset.modelID !== modelID) return false
    if (authMode && preset.authMode !== authMode) return false
    return true
  })
}

export async function budgetEnforcementStatus(input: { providerID?: string | null; modelID?: string | null; authMode?: string | null } = {}, root?: string) {
  const paths = mendPaths(root)
  const [cfg, spendState, records] = await Promise.all([
    readJsonIfExists<any>(paths.mendConfig, {}),
    readBudgetSpendState(paths.root),
    runHistoryRecords(paths.root),
  ])
  const runSummary = summarizeRunHistory(records, paths.root)
  const preset = pricingPreset(input.providerID, input.modelID, input.authMode)
  const pricing = preset?.pricingPer1MTokens || null
  const resolvedAuthMode = preset?.authMode || input.authMode || "unknown"
  const suppliedUsd = spendState.telemetry?.available === true ? spendState.telemetry.currentUsd || 0 : 0
  const currentUsd = suppliedUsd + knownRunHistoryUsd(runSummary)
  const warnUsd = cfg.budgets?.warnUsd
  const stopUsd = cfg.budgets?.stopUsd
  const enforced = Boolean(pricing)
  const warnings: string[] = []
  const blockers: string[] = []
  let state = "not-enforced"
  let reason = "pricing unavailable for selected provider/model; no USD budget enforcement"
  if (resolvedAuthMode === "chatgpt-subscription-oauth") reason = "subscription OAuth run; tokens are counted but USD budget enforcement does not apply"
  if (enforced) {
    state = "ok"
    reason = "pricing preset available; fail-closed stop gate is active before provider calls"
    if (typeof warnUsd === "number" && currentUsd >= warnUsd) {
      state = "warn"
      warnings.push(`known spend ${currentUsd.toFixed(6)} USD is at or above warnUsd ${warnUsd}`)
    }
    if (typeof stopUsd === "number" && currentUsd >= stopUsd) {
      state = "stop"
      blockers.push(`budget stop reached: known spend ${currentUsd.toFixed(6)} USD >= stopUsd ${stopUsd}`)
    }
  }
  return {
    enforced,
    state,
    reason,
    providerID: input.providerID || null,
    modelID: input.modelID || null,
    authMode: resolvedAuthMode,
    pricingKnown: Boolean(pricing),
    pricingPer1MTokens: pricing,
    warnUsd,
    stopUsd,
    currentKnownUsd: currentUsd,
    sources: {
      spendStateUsd: spendState.telemetry?.available === true ? spendState.telemetry.currentUsd || 0 : null,
      runHistoryEstimatedUsd: knownRunHistoryUsd(runSummary),
      runHistoryEstimatedUsdAvailableRuns: runSummary.totals.estimatedUsdAvailableRuns || 0,
    },
    warnings,
    blockers,
  }
}

export async function budgetStatus(root?: string) {
  const paths = mendPaths(root)
  const [cfg, spendState, resolved, records] = await Promise.all([
    readJsonIfExists<any>(paths.mendConfig, {}),
    readBudgetSpendState(paths.root),
    resolveModelRoles(paths.root),
    runHistoryRecords(paths.root),
  ])
  const validation = validateBudgetSpendState(spendState)
  const defaultRole: any = resolved.roles.default || {}
  const enforcement = await budgetEnforcementStatus({
    providerID: defaultRole.providerID || null,
    modelID: defaultRole.modelID || null,
    authMode: defaultRole.authMode || null,
  }, paths.root)
  return {
    warnUsd: cfg.budgets?.warnUsd,
    stopUsd: cfg.budgets?.stopUsd,
    expensiveModelRequiresConfirm: cfg.budgets?.expensiveModelRequiresConfirm !== false,
    spendState: {
      path: paths.budgetSpendState.replace(`${paths.root}/`, ""),
      ...spendState,
      schemaValid: validation.failures.length === 0,
    },
    spendTelemetry: {
      available: spendState.telemetry?.available === true,
      currentUsd: spendState.telemetry?.available === true ? spendState.telemetry.currentUsd : null,
      note:
        spendState.telemetry?.available === true
          ? "Spend telemetry is locally supplied and included in known USD enforcement when pricing is known."
          : "No spend telemetry source is configured yet; MendCode will not invent usage or cost numbers.",
    },
    enforcement,
    runTelemetry: summarizeRunHistory(records, paths.root),
  }
}

export async function writeBudgetPolicy(input: { warnUsd: number | null; stopUsd: number | null; expensiveModelRequiresConfirm: boolean }, root?: string) {
  if (input.warnUsd !== null && (!Number.isFinite(input.warnUsd) || input.warnUsd < 0)) throw new Error("warnUsd must be a non-negative number or null")
  if (input.stopUsd !== null && (!Number.isFinite(input.stopUsd) || input.stopUsd < 0)) throw new Error("stopUsd must be a non-negative number or null")
  if (input.warnUsd !== null && input.stopUsd !== null && input.stopUsd < input.warnUsd) throw new Error("stopUsd must be greater than or equal to warnUsd")
  const paths = mendPaths(root)
  const cfg = await readJsonIfExists<any>(paths.mendConfig, {})
  cfg.version = cfg.version ?? 0
  cfg.budgets = {
    ...(cfg.budgets || {}),
    warnUsd: input.warnUsd ?? undefined,
    stopUsd: input.stopUsd ?? undefined,
    expensiveModelRequiresConfirm: input.expensiveModelRequiresConfirm,
  }
  await writeJson(paths.mendConfig, cfg)
  return budgetStatus(paths.root)
}

export async function budgetDoctor(root?: string) {
  const paths = mendPaths(root)
  const [spendState, resolved] = await Promise.all([readBudgetSpendState(paths.root), resolveModelRoles(paths.root)])
  const validation = validateBudgetSpendState(spendState)
  const defaultRole: any = resolved.roles.default || {}
  return {
    ok: validation.failures.length === 0,
    path: paths.budgetSpendState.replace(`${paths.root}/`, ""),
    failures: validation.failures,
    warnings: validation.warnings,
    enforcement: await budgetEnforcementStatus({
      providerID: defaultRole.providerID || null,
      modelID: defaultRole.modelID || null,
      authMode: defaultRole.authMode || null,
    }, paths.root),
  }
}
