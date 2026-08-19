import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { routeReturnTarget, useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { CommandDeck, CommandDeckContext, commandDeckLayout } from "@tui/component/command-deck"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import * as Model from "../../util/model"

export type LoopWorkflow = {
  id: string
  projectID?: string
  workspaceID?: string
  project?: { id: string; name?: string; worktree: string; directory?: string }
  name?: string
  objective?: string
  ownerSessionID?: string
  rootSessionID?: string
  state: string
  phase?: string
  nextWakeup?: number
  spec?: {
    trigger?: { mode?: string; intervalMs?: number; dailyAt?: string; timezone?: string }
    model?: { providerID?: string; modelID?: string; variant?: string }
    agent?: string
    budgetMode?: string
    completionCriteria?: string[]
    successChecks?: string[]
    validationChecks?: { id?: string; command?: string }[]
    stopWhen?: string[]
    gates?: string[]
    strategy?: { targetTurns?: number; reserveTurns?: number; notifyOwnerOnComplete?: boolean }
    evaluation?: { mode?: string; confirmation?: string; evaluatorAgent?: string }
    rubric?: { criteria?: { description?: string }[] }
    workspace?: { mode?: string }
    costBudget?: { maxCost?: number; maxTokens?: number }
    approvalPolicy?: { requireApprovalFor?: string[]; approvedActions?: string[] }
    memory?: { enabled?: boolean; sections?: string[] }
    retention?: { maxArtifacts?: number; maxAgeMs?: number; maxBytes?: number }
  }
  policy?: { maxTurns?: number; maxRuntimeMs?: number; maxChildren?: number; maxDepth?: number; requireApprovalFor?: string[]; approvedActions?: string[] }
  metrics?: {
    turns?: number
    failures?: number
    cost?: number
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  memory?: { entries?: { section?: string; summary?: string }[] }
  scheduler?: {
    lastWakeAttempt?: number
    nextWakeup?: number
    lastError?: string
    lastRunID?: string
    lastRunState?: string
    lastResult?: string
    degraded?: boolean
  }
  evaluatorReason?: string
  time?: { created?: number; updated?: number; activated?: number }
}

export type LoopRun = {
  id: string
  state: string
  trigger?: string
  phase?: string
  nextWakeup?: number
  evaluatorReason?: string
  failureClass?: string
  checkpoint?: { status?: string; summary?: string; evidence?: string[]; nextAction?: string; confidence?: string }
  judgment?: { status?: string; summary?: string; evidence?: string[]; recommendedNextAction?: string; confidence?: string; failureClass?: string }
  rubricResult?: {
    status: string
    score: number
    threshold: number
    blockers?: { id: string; present: boolean; reason: string }[]
  }
  usage?: {
    cost?: number
    durationMs?: number
    tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
  }
  gateResults?: { id: string; status: string; summary?: string; failureClass?: string; waiver?: { action: string; actor: string; reason: string; time: number } }[]
  completion?: {
    status: string
    generation: number
    auditAttempts: number
    summary?: string
    failedCriteria?: string[]
  }
  time?: { created?: number; started?: number; ended?: number; updated?: number }
}

export type LoopEvent = {
  id: string
  type: string
  title: string
  summary: string
  level?: string
  sequence?: number
  sessionID?: string
  runID?: string
  time?: { created?: number; updated?: number }
}

export type LoopArtifact = {
  id: string
  kind: string
  title: string
  summary: string
  source?: string
  status?: string
  evidence?: string[]
  runID?: string
  time?: { created?: number; updated?: number }
}

export type LoopSnapshot = {
  workflow: LoopWorkflow
  runs?: LoopRun[]
  events?: LoopEvent[]
  artifacts?: LoopArtifact[]
  rootSession?: {
    id: string
    title: string
    model?: {
      providerID: string
      modelID: string
      variant?: string
    }
  }
}

export type LoopSummary = {
  workflowID: string
  state: string
  phase?: string
  objective?: string
  nextWakeup?: number
  runID?: string
  runState?: string
  verdict?: string
  verdictSummary?: string
  checkpointStatus?: string
  judgmentStatus?: string
  gateSummary?: {
    total?: number
    pass?: number
    fail?: number
    blocked?: number
    awaitingApproval?: number
    skip?: number
    blocking?: string
  }
  evidenceSummary?: string[]
  nextAction?: string
  memorySummary?: { total?: number; open?: number; latest?: string[] }
  costSummary?: { cost?: number; tokens?: number }
}

type LoopView = "active" | "history"
type LoopScope = "project" | "all"

export type LoopHistoryPage<T> = {
  items: T[]
  page: number
  pageCount: number
  start: number
  end: number
  total: number
}

export type LoopGlobalPage = {
  active: LoopWorkflow[]
  history: LoopWorkflow[]
  page: {
    offset: number
    limit: number
    total: number
  }
}

const ACTIVE_STATES = new Set(["active", "sleeping", "working", "needs_input", "blocked"])
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"])
const REPORT_ONLY_APPROVAL_GATES = ["edit", "write", "apply_patch", "shell", "subagent"]
const NORMAL_APPROVAL_GATES = ["push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"]
const LOOP_EVENT_LIMIT = 50
export const LOOP_HISTORY_PAGE_SIZE = 50
const loopWorkflowListCache = new Map<string, LoopGlobalPage>()
export const LOOP_WORKFLOW_GLOBAL_CACHE_KEY = "global"
export const LOOP_WORKFLOW_PROJECT_CACHE_KEY = "project"

export function loopGlobalPageCacheKey(input: { offset: number; limit?: number; scope?: LoopScope }) {
  const scope = input.scope === "project" ? LOOP_WORKFLOW_PROJECT_CACHE_KEY : LOOP_WORKFLOW_GLOBAL_CACHE_KEY
  return `${scope}:${Math.max(0, input.offset)}:${Math.max(1, input.limit ?? LOOP_HISTORY_PAGE_SIZE)}`
}

export function loopSnapshotResourceKey(workflow?: Pick<LoopWorkflow, "id" | "time">) {
  if (!workflow) return ""
  return `${workflow.id}:${workflow.time?.updated ?? 0}`
}

export function loopHistoryPage<T>(input: { items: readonly T[]; page: number; pageSize?: number }): LoopHistoryPage<T> {
  const pageSize = Math.max(1, input.pageSize ?? LOOP_HISTORY_PAGE_SIZE)
  const total = input.items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, input.page), pageCount - 1)
  const start = page * pageSize
  const end = Math.min(total, start + pageSize)
  return { items: input.items.slice(start, end), page, pageCount, start, end, total }
}

export function loopHistoryPageFromContract<T>(input: { items: readonly T[]; page: LoopGlobalPage["page"] }): LoopHistoryPage<T> {
  const limit = Math.max(1, input.page.limit)
  const total = Math.max(0, input.page.total)
  const offset = Math.min(Math.max(0, input.page.offset), Math.max(0, Math.ceil(total / limit) - 1) * limit)
  return {
    items: input.items.slice(),
    page: Math.floor(offset / limit),
    pageCount: Math.max(1, Math.ceil(total / limit)),
    start: offset,
    end: Math.min(offset + input.items.length, total),
    total,
  }
}

export function shouldKeepRouteLoopSelection(input: { requestedID?: string; loading: boolean; items: readonly Pick<LoopWorkflow, "id">[] }) {
  return Boolean(input.requestedID && input.loading && !input.items.some((item) => item.id === input.requestedID))
}

export function loopRouteFrameLayout(terminalWidth: number) {
  const stacked = terminalWidth < 96
  const compact = terminalWidth < 72 || stacked
  const paddingX = terminalWidth < 56 ? 0 : compact ? 1 : 2
  const contentWidth = Math.max(24, terminalWidth - paddingX * 2)
  return {
    compact,
    paddingX,
    width: contentWidth,
    narrow: terminalWidth < 118,
    stacked,
  }
}

export function loopRouteColumns(input: { width: number; stacked: boolean }) {
  if (input.stacked) return { listWidth: input.width, detailWidth: input.width }
  const listWidth = Math.max(30, Math.min(56, Math.floor(input.width * 0.32)))
  return {
    listWidth,
    detailWidth: Math.max(30, input.width - listWidth - 3),
  }
}

export function loopRouteSelectionOffset(key: string) {
  if (key === "j" || key === "down") return 1
  if (key === "k" || key === "up") return -1
}

export function loopRouteStackedListHeight(itemCount: number, compact: boolean, terminalHeight?: number) {
  const rowHeight = compact ? 2 : 4
  const preferred = Math.min(compact ? 10 : 16, Math.max(compact ? 5 : 7, itemCount * rowHeight + 4))
  if (typeof terminalHeight !== "number") return preferred
  const viewportCap = Math.max(compact ? 4 : 6, terminalHeight - (compact ? 8 : 12))
  return Math.min(preferred, viewportCap)
}

export function loopRouteKeyHint(input: { width: number; narrow: boolean; compact: boolean }) {
  if (input.width < 48) return "↑↓ select · c/g · a/h · i · o · q"
  if (input.compact) return "↑↓ select · c project · g all · a/h view · i inspect · pgup/dn page · o chat · O parent · q back"
  if (input.narrow) return "↑↓ select · c project · g all · a active · h history · i inspect · pgup/dn page · e agent · o open · O parent · q back"
  return "↑↓ or j/k select · c project · g all · a active · h history · i inspect · pgup/dn page · r refresh · o open chat · O parent chat · e edit agent · p pause · u resume · s stop · q back"
}

export function loopRouteHeaderLayout(narrow: boolean) {
  return {
    flexDirection: narrow ? "column" as const : "row" as const,
    height: narrow ? 2 : 1,
    flexShrink: 0,
  }
}

export function loopDetailRowLayout(width: number) {
  const labelWidth = 11
  const gap = 1
  return {
    labelWidth,
    gap,
    valueWidth: Math.max(8, width - labelWidth - gap),
  }
}

export function loopDetailHeaderLayout(width: number, idLength: number) {
  const available = Math.max(24, width)
  const idWidth = available < 56
    ? Math.min(12, idLength)
    : Math.min(idLength, Math.max(16, Math.min(34, Math.floor(available * 0.28))))
  return {
    idWidth,
    titleWidth: Math.max(12, available - idWidth - 1),
  }
}

function stateLabel(workflow: Pick<LoopWorkflow, "state" | "phase">) {
  return workflow.phase && workflow.phase !== "ready" ? `${workflow.state}: ${workflow.phase}` : workflow.state
}

function sameStringSet(values: Set<string>, expected: string[]) {
  return values.size === expected.length && expected.every((item) => values.has(item))
}

function approvalPolicyFor(workflow: Pick<LoopWorkflow, "policy" | "spec">) {
  return {
    requireApprovalFor: workflow.policy?.requireApprovalFor ?? workflow.spec?.approvalPolicy?.requireApprovalFor,
    approvedActions: workflow.policy?.approvedActions ?? workflow.spec?.approvalPolicy?.approvedActions,
  }
}

function pendingApprovalActions(workflow: Pick<LoopWorkflow, "policy" | "spec">) {
  const policy = approvalPolicyFor(workflow)
  const approved = new Set(policy.approvedActions ?? [])
  return (policy.requireApprovalFor ?? []).filter((item) => !approved.has(item))
}

function loopPermissionMode(workflow: Pick<LoopWorkflow, "policy" | "spec">) {
  if (workflow.spec?.workspace?.mode === "read-only") return "report-only"
  const gates = workflow.spec?.gates ?? []
  if (gates.some((gate) => /report-only|do not edit/i.test(gate))) return "report-only"
  const approvals = new Set(approvalPolicyFor(workflow).requireApprovalFor ?? [])
  if (REPORT_ONLY_APPROVAL_GATES.every((gate) => approvals.has(gate))) return "report-only"
  if (gates.length > 0) return "custom"
  if (!approvals.size || sameStringSet(approvals, NORMAL_APPROVAL_GATES)) return "normal"
  return "custom"
}

function approvalPreview(workflow: Pick<LoopWorkflow, "policy" | "spec">) {
  const approvals = pendingApprovalActions(workflow)
  if (approvals.length) return `Needs approval for ${approvals.join("; ")}.`
  if ((approvalPolicyFor(workflow).requireApprovalFor ?? []).length) return "No additional approval is pending inside the configured permission envelope."
  return "Needs approval for actions outside the permission envelope."
}

function approvalDetail(workflow: Pick<LoopWorkflow, "policy" | "spec">) {
  const approvals = pendingApprovalActions(workflow)
  if (approvals.length) return approvals.join(", ")
  if ((approvalPolicyFor(workflow).requireApprovalFor ?? []).length) return "none pending inside configured envelope"
  return "default safety gates"
}

function hasInvalidZeroBudget(workflow: LoopWorkflow) {
  return workflow.policy?.maxTurns === 0
}

function progressLabel(workflow: LoopWorkflow) {
  const turns = workflow.metrics?.turns ?? 0
  const state = workflow.state.toLowerCase()
  const phase = workflow.phase?.toLowerCase()
  const running = state === "working" || phase === "executing"
  const visible = running ? turns + 1 : turns
  const maxTurns = workflow.policy?.maxTurns
  if (maxTurns === 0) return `${visible}/invalid`
  const current = typeof maxTurns === "number" ? Math.min(visible, maxTurns) : visible
  return typeof maxTurns === "number" ? `${current}/${maxTurns}` : `${current}/open`
}

export function loopWakeupLabel(workflow: LoopWorkflow, now = Date.now()) {
  if (workflow.state === "paused") return "paused"
  if (TERMINAL_STATES.has(workflow.state)) return "ended"
  const triggerMode = workflow.spec?.trigger?.mode
  if (!workflow.nextWakeup) {
    if (!triggerMode || triggerMode === "manual") return "on demand"
    if (workflow.state === "blocked") return "not scheduled (blocked)"
    if (workflow.state === "needs_input") return "waiting for input"
    if (workflow.state === "working") return "running"
    return `waiting for ${triggerMode}`
  }
  const seconds = Math.max(0, Math.round((workflow.nextWakeup - now) / 1000))
  const rel = formatDuration(seconds)
  const timezone = workflow.spec?.trigger?.mode === "daily" ? workflow.spec.trigger.timezone : undefined
  return `${rel || "now"} (${new Date(workflow.nextWakeup).toLocaleTimeString([], timezone ? { timeZone: timezone } : undefined)})`
}

function cadenceLabel(workflow: LoopWorkflow) {
  const trigger = workflow.spec?.trigger
  if (!trigger?.mode || trigger.mode === "manual") return "on demand"
  if (trigger.mode === "daily") return `daily at ${trigger.dailyAt ?? "configured time"}${trigger.timezone ? ` (${trigger.timezone})` : ""}`
  if (trigger.mode !== "interval") return trigger.mode
  const ms = trigger.intervalMs
  return typeof ms === "number" ? `every ${formatDuration(Math.round(ms / 1000))}` : "interval"
}

function displayModel(providers: Parameters<typeof Model.name>[0], model: { providerID: string; modelID: string; variant?: string }) {
  const name = Model.name(providers, model.providerID, model.modelID)
  return model.variant ? `${name}/${model.variant}` : name
}

function optionalModelVariant(model: unknown) {
  if (!model || typeof model !== "object" || !("variant" in model)) return undefined
  return typeof model.variant === "string" ? model.variant : undefined
}

function modelLabel(
  providers: Parameters<typeof Model.name>[0],
  workflow: LoopWorkflow,
  rootSession?: LoopSnapshot["rootSession"],
) {
  const model = workflow.spec?.model
  if (model?.providerID && model.modelID) {
    return displayModel(providers, { providerID: model.providerID, modelID: model.modelID, variant: optionalModelVariant(model) })
  }
  if (rootSession?.model?.providerID && rootSession.model.modelID) {
    return `default: ${displayModel(providers, {
      providerID: rootSession.model.providerID,
      modelID: rootSession.model.modelID,
      variant: optionalModelVariant(rootSession.model),
    })}`
  }
  return "default: current session model"
}

function eventTimeLabel(event: LoopEvent) {
  const created = event.time?.created ?? event.time?.updated
  if (created === undefined) return "event"
  return new Date(created).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })
}

function compact(value: string | undefined, width: number) {
  return Locale.truncateMiddle((value || "").replace(/\s+/g, " ").trim(), Math.max(4, width))
}

function fixedCell(value: string | undefined, width: number) {
  const text = compact(value, width)
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))
}

function timestamp(workflow: LoopWorkflow) {
  return workflow.time?.updated ?? workflow.time?.activated ?? workflow.time?.created ?? 0
}

function timeLabel(value: number | undefined) {
  if (!value) return "unknown"
  const date = new Date(value)
  const now = new Date()
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return clock
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`
}

export function loopSchedulerState(
  workflow: Pick<LoopWorkflow, "state" | "nextWakeup" | "scheduler">,
  now = Date.now(),
) {
  if (workflow.scheduler?.degraded) return "degraded"
  const nextWakeup = workflow.scheduler?.nextWakeup ?? workflow.nextWakeup
  if (
    (workflow.state === "active" || workflow.state === "sleeping") &&
    typeof nextWakeup === "number" &&
    nextWakeup < now - 2 * 60_000
  ) return "overdue"
  return workflow.scheduler ? "ready" : "unknown"
}

function tokenTotal(metrics?: LoopWorkflow["metrics"], usage?: LoopRun["usage"]) {
  const usageTokens = usage?.tokens
    ? (usage.tokens.input ?? 0) + (usage.tokens.output ?? 0) + (usage.tokens.reasoning ?? 0) + (usage.tokens.cacheRead ?? 0) + (usage.tokens.cacheWrite ?? 0)
    : 0
  return usageTokens || (metrics?.inputTokens ?? 0) + (metrics?.outputTokens ?? 0) + (metrics?.reasoningTokens ?? 0) + (metrics?.cacheReadTokens ?? 0) + (metrics?.cacheWriteTokens ?? 0)
}

function currency(value: number | undefined) {
  if (typeof value !== "number") return undefined
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}

function listPreview(values: readonly string[] | undefined, fallback: string) {
  const items = values?.map((item) => item.trim()).filter(Boolean)
  return items?.length ? items.join("; ") : fallback
}

function verificationChecks(workflow: LoopWorkflow) {
  return Array.from(new Set([
    ...(workflow.spec?.successChecks ?? []),
    ...(workflow.spec?.validationChecks?.flatMap((check) => check.command?.trim() ? [check.command.trim()] : []) ?? []),
  ].map((item) => item.trim()).filter(Boolean)))
}

function retentionLabel(workflow: LoopWorkflow) {
  const retention = workflow.spec?.retention
  if (!retention) return "default non-critical artifact cap"
  return [
    retention.maxArtifacts === undefined ? undefined : `${retention.maxArtifacts} non-critical artifacts`,
    retention.maxAgeMs === undefined ? undefined : `${formatDuration(Math.round(retention.maxAgeMs / 1000))} max age`,
    retention.maxBytes === undefined ? undefined : `${retention.maxBytes} estimated bytes`,
  ].filter((item): item is string => Boolean(item)).join(" · ") || "audit-critical artifacts only"
}

function triggerPreview(workflow: LoopWorkflow) {
  const trigger = workflow.spec?.trigger
  if (!trigger?.mode || trigger.mode === "manual") return "on demand / run_once"
  if (trigger.mode === "interval") return trigger.intervalMs ? `every ${formatDuration(Math.round(trigger.intervalMs / 1000))}` : "configured interval"
  if (trigger.mode === "daily") return `daily at ${trigger.dailyAt ?? "configured time"}${trigger.timezone ? ` (${trigger.timezone})` : ""}`
  if (trigger.mode === "external-signal") return "matching external signal"
  if (trigger.mode === "self-paced") return "self-paced checkpoint continuation"
  return "scheduler readiness"
}

function budgetPreview(workflow: LoopWorkflow) {
  const turns = workflow.policy?.maxTurns ? `${workflow.policy.maxTurns} turns` : "unlimited turns"
  const runtime = workflow.policy?.maxRuntimeMs ? `${formatDuration(Math.round(workflow.policy.maxRuntimeMs / 1000))} runtime` : "no runtime cap"
  const cost = workflow.spec?.costBudget?.maxCost !== undefined ? `$${workflow.spec.costBudget.maxCost}` : "no cost cap"
  const tokens = workflow.spec?.costBudget?.maxTokens !== undefined ? `${workflow.spec.costBudget.maxTokens} tokens` : "no token cap"
  return `${workflow.spec?.budgetMode ?? "legacy"} · ${turns} · ${runtime} · ${cost} · ${tokens}`
}

export function loopContractPreviewRows(workflow?: LoopWorkflow) {
  if (!workflow) return []
  const criteria = workflow.spec?.completionCriteria?.length ? workflow.spec.completionCriteria : workflow.spec?.rubric?.criteria?.flatMap((item) => item.description ? [item.description] : [])
  const reportOnly = loopPermissionMode(workflow) === "report-only"
  return [
    ["wake", `I will wake when ${triggerPreview(workflow)}.`],
    ["can do", reportOnly ? "Inspect, summarize, and produce evidence without edits." : `Work on the objective in ${workflow.spec?.workspace?.mode ?? "in-place"} mode.`],
    ["approval", approvalPreview(workflow)],
    ["verify", `Verify by ${listPreview(verificationChecks(workflow), "checkpoint evidence and gate results")}.`],
    ["judge", `${workflow.spec?.evaluation?.mode ?? "legacy"} judge with ${workflow.spec?.evaluation?.confirmation ?? "same-run"} confirmation checks ${listPreview(criteria, "objective evidence and safety gates")}.`],
    ["stop", `Stop when ${listPreview(workflow.spec?.stopWhen, workflow.spec?.budgetMode === "max-goal" ? "goal verified or budget/gates block progress" : "budget exhausted, stopped, or blocked")}.`],
    ["budget", budgetPreview(workflow)],
    ["workspace", workflow.spec?.workspace?.mode ?? "in-place"],
    ["memory", workflow.spec?.memory?.enabled === false ? "disabled" : workflow.spec?.memory?.sections?.join(", ") || (workflow.memory ? "loop-local facts" : "none configured")],
  ]
}

function gateSummaryLabel(summary?: LoopSummary["gateSummary"], gates?: LoopRun["gateResults"]) {
  if (summary?.total) {
    const parts = [
      summary.pass ? `${summary.pass} pass` : undefined,
      summary.fail ? `${summary.fail} fail` : undefined,
      summary.blocked ? `${summary.blocked} blocked` : undefined,
      summary.awaitingApproval ? `${summary.awaitingApproval} approval` : undefined,
      summary.skip ? `${summary.skip} skip` : undefined,
    ].filter(Boolean)
    return `${parts.join(" · ") || `${summary.total} checked`}${summary.blocking ? ` · ${summary.blocking}` : ""}`
  }
  if (gates?.length) {
    return gates.map((gate) => `${gate.id}:${gate.status}`).join(" · ")
  }
  return "no gates recorded"
}

export function latestLoopWakeReason(events: readonly LoopEvent[]) {
  const event =
    events.find((item) => item.type === "wake" || item.type === "signal" || item.type === "monitor") ??
    events.find((item) => item.type === "started")
  if (!event) return undefined
  return `${event.title}: ${event.summary}`
}

export function loopSupervisionRows(input: {
  workflow?: LoopWorkflow
  summary?: LoopSummary
  runs?: readonly LoopRun[]
  events?: readonly LoopEvent[]
  artifacts?: readonly LoopArtifact[]
}) {
  const run = input.runs?.[0]
  const verdict = input.summary?.verdict ?? input.summary?.judgmentStatus ?? run?.judgment?.status ?? run?.checkpoint?.status ?? "pending"
  const verdictSummary = input.summary?.verdictSummary ?? run?.judgment?.summary ?? run?.checkpoint?.summary
  const evidence = input.summary?.evidenceSummary ?? run?.judgment?.evidence ?? run?.checkpoint?.evidence ?? []
  const memory = input.summary?.memorySummary
  const tokens = input.summary?.costSummary?.tokens ?? tokenTotal(input.workflow?.metrics, run?.usage)
  const cost = input.summary?.costSummary?.cost ?? input.workflow?.metrics?.cost ?? run?.usage?.cost
  const changedArtifacts = input.artifacts?.filter((artifact) => artifact.kind === "diff" && (!run?.id || !artifact.runID || artifact.runID === run.id)).length ?? 0
  const rubric = run?.rubricResult
  const waivers = run?.gateResults?.filter((gate) => gate.waiver) ?? []
  return [
    ["wake", latestLoopWakeReason(input.events ?? []) ?? run?.trigger ?? "not started"],
    ["latest run", run ? `${run.state} · ${run.trigger || "run"} · ${run.phase || "ready"}` : "none yet"],
    ["completion", run?.completion ? `${run.completion.status} · gen ${run.completion.generation} · ${run.completion.auditAttempts} audit${run.completion.auditAttempts === 1 ? "" : "s"}${run.completion.failedCriteria?.length ? ` · failed ${run.completion.failedCriteria.join(", ")}` : ""}` : "not proposed"],
    ["verdict", verdictSummary ? `${verdict} · ${verdictSummary}` : verdict],
    ["gates", gateSummaryLabel(input.summary?.gateSummary, run?.gateResults)],
    ["rubric", rubric ? `${rubric.status} · ${Math.round(rubric.score * 100)}% / ${Math.round(rubric.threshold * 100)}%${rubric.blockers?.some((blocker) => blocker.present) ? " · blocker present" : ""}` : "not evaluated"],
    ["overrides", waivers.length ? `${waivers.length} audited · ${waivers[0]?.waiver?.actor ?? "operator"}` : "none"],
    ["evidence", evidence.length ? `${evidence.length} item${evidence.length === 1 ? "" : "s"} · ${evidence[0]}` : "no evidence recorded"],
    ["changed", changedArtifacts ? `${changedArtifacts} diff artifact${changedArtifacts === 1 ? "" : "s"}` : "no diff artifacts"],
    ["memory", memory ? `${memory.total ?? 0} facts · ${memory.open ?? 0} open${memory.latest?.[0] ? ` · ${memory.latest[0]}` : ""}` : `${input.workflow?.memory?.entries?.length ?? 0} facts`],
    ["cost", `${tokens} tokens${currency(cost) ? ` · ${currency(cost)}` : ""}`],
    ["next action", input.summary?.nextAction ?? run?.judgment?.recommendedNextAction ?? run?.checkpoint?.nextAction ?? input.workflow?.evaluatorReason ?? "monitor"],
  ]
}

export function loopSummaryRows(input: {
  detail?: LoopWorkflow
  summary?: LoopSummary
  runs?: readonly LoopRun[]
  now?: number
}) {
  if (!input.detail) return []
  const run = input.runs?.[0]
  const verdict = input.summary?.verdict ?? input.summary?.judgmentStatus ?? run?.judgment?.status ?? run?.checkpoint?.status ?? "pending"
  const verdictSummary = input.summary?.verdictSummary ?? run?.judgment?.summary ?? run?.checkpoint?.summary
  const tokens = input.summary?.costSummary?.tokens ?? tokenTotal(input.detail.metrics, run?.usage)
  const cost = input.summary?.costSummary?.cost ?? input.detail.metrics?.cost ?? run?.usage?.cost
  return [
    ["state", stateLabel(input.detail)],
    ["iteration", progressLabel(input.detail)],
    ["next", loopWakeupLabel(input.detail, input.now)],
    ["cadence", cadenceLabel(input.detail)],
    ["run", run ? `${run.state} · ${run.trigger || "run"} · ${run.phase || "ready"}` : "none yet"],
    ["completion", run?.completion ? `${run.completion.status} · gen ${run.completion.generation} · ${run.completion.auditAttempts} audit${run.completion.auditAttempts === 1 ? "" : "s"}` : "not proposed"],
    ["verdict", verdictSummary ? `${verdict} · ${verdictSummary}` : verdict],
    ["next action", input.summary?.nextAction ?? run?.judgment?.recommendedNextAction ?? run?.checkpoint?.nextAction ?? input.detail.evaluatorReason ?? "monitor"],
    ["usage", `${tokens} tokens${currency(cost) ? ` · ${currency(cost)}` : ""}`],
  ]
}

export function compactLoopDetailLines(input: {
  detail?: LoopWorkflow
  rows?: readonly string[][]
  contractRows?: readonly string[][]
  supervisionRows?: readonly string[][]
}) {
  if (!input.detail) return []
  const rowValue = (label: string) => input.rows?.find((row) => row[0] === label)?.[1]
  const contractValue = (label: string) => input.contractRows?.find((row) => row[0] === label)?.[1]
  const supervisionValue = (label: string) => input.supervisionRows?.find((row) => row[0] === label)?.[1]
  return [
    `${stateLabel(input.detail)} · ${progressLabel(input.detail)} · ${rowValue("chat") ?? "no chat"}`,
    `contract · ${contractValue("wake") ?? rowValue("budget") ?? "budget"}`,
    contractValue("can do") ? `can do · ${contractValue("can do")}` : undefined,
    contractValue("approval") ? `approval · ${contractValue("approval")}` : undefined,
    contractValue("verify") ? `verify · ${contractValue("verify")}` : undefined,
    contractValue("judge") ? `judge · ${contractValue("judge")}` : undefined,
    contractValue("stop") ? `stop · ${contractValue("stop")}` : undefined,
    contractValue("budget") ? `budget · ${contractValue("budget")}` : undefined,
    contractValue("workspace") ? `workspace · ${contractValue("workspace")}` : undefined,
    contractValue("memory") ? `memory plan · ${contractValue("memory")}` : undefined,
    rowValue("checks") ? `checks · ${rowValue("checks")}` : undefined,
    rowValue("retention") ? `retention · ${rowValue("retention")}` : undefined,
    supervisionValue("wake") ? `wake · ${supervisionValue("wake")}` : undefined,
    supervisionValue("latest run") ? `run · ${supervisionValue("latest run")}` : undefined,
    supervisionValue("verdict") ? `verdict · ${supervisionValue("verdict")}` : undefined,
    supervisionValue("gates") ? `gates · ${supervisionValue("gates")}` : undefined,
    supervisionValue("rubric") ? `rubric · ${supervisionValue("rubric")}` : undefined,
    supervisionValue("overrides") ? `overrides · ${supervisionValue("overrides")}` : undefined,
    supervisionValue("evidence") ? `evidence · ${supervisionValue("evidence")}` : undefined,
    supervisionValue("changed") ? `changed · ${supervisionValue("changed")}` : undefined,
    supervisionValue("memory") ? `memory · ${supervisionValue("memory")}` : undefined,
    supervisionValue("cost") ? `cost · ${supervisionValue("cost")}` : undefined,
    supervisionValue("next action") ? `next · ${supervisionValue("next action")}` : undefined,
  ].filter((line): line is string => Boolean(line))
}

export function compactLoopSummaryLines(input: {
  detail?: LoopWorkflow
  summaryRows?: readonly string[][]
}) {
  if (!input.detail) return []
  const value = (label: string) => input.summaryRows?.find((row) => row[0] === label)?.[1]
  return [
    `${stateLabel(input.detail)} · ${progressLabel(input.detail)} · ${value("next") ?? "on demand"}`,
    value("cadence") ? `cadence · ${value("cadence")}` : undefined,
    value("run") ? `run · ${value("run")}` : undefined,
    value("verdict") ? `verdict · ${value("verdict")}` : undefined,
    value("next action") ? `next · ${value("next action")}` : undefined,
    value("usage") ? `usage · ${value("usage")}` : undefined,
  ].filter((line): line is string => Boolean(line))
}

function folderName(value: string | undefined) {
  const clean = (value || "").replace(/[/\\]+$/, "")
  if (!clean) return "current project"
  return clean.split(/[/\\]/).filter(Boolean).at(-1) || clean
}

export function loopWorkflowProjectLabel(workflow: Pick<LoopWorkflow, "project" | "projectID">) {
  const directory = workflow.project?.directory || workflow.project?.worktree
  return workflow.project?.name?.trim() || (directory ? folderName(directory) : workflow.projectID || "unknown project")
}

function isPrimaryLoop(workflow: LoopWorkflow) {
  return ACTIVE_STATES.has(workflow.state)
}

export function loopStateCounts(items: readonly Pick<LoopWorkflow, "state">[]) {
  return {
    scheduled: items.filter((item) => ACTIVE_STATES.has(item.state) && item.state !== "blocked").length,
    blocked: items.filter((item) => item.state === "blocked").length,
  }
}

function sortActiveLoops(a: LoopWorkflow, b: LoopWorkflow) {
  const priority = (item: LoopWorkflow) => {
    if (item.state === "needs_input") return 0
    if (item.state === "working") return 1
    if (item.state === "sleeping") return 2
    if (item.state === "active") return 3
    if (item.state === "blocked") return 4
    if (item.state === "paused") return 5
    if (item.state === "failed") return 6
    if (item.state === "stopped") return 7
    if (item.state === "completed") return 8
    return 9
  }
  const p = priority(a) - priority(b)
  if (p) return p
  return timestamp(b) - timestamp(a)
}

function sortHistoryLoops(a: LoopWorkflow, b: LoopWorkflow) {
  return timestamp(b) - timestamp(a)
}

export function Loops() {
  const route = useRoute()
  const data = useRouteData("loops")
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  const [refresh, setRefresh] = createSignal(0)
  const [view, setView] = createSignal<LoopView>("active")
  const [scope, setScope] = createSignal<LoopScope>("project")
  const [selectedID, setSelectedID] = createSignal(data.selectedID)
  const [historyPage, setHistoryPage] = createSignal(0)
  const [routeSelectedID, setRouteSelectedID] = createSignal(data.selectedID)
  const [inspect, setInspect] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [listError, setListError] = createSignal<string>()
  const listRequests = new Map<string, Promise<{ cacheKey?: string; requestKey?: string; page: LoopGlobalPage }>>()
  const snapshotRequests = new Map<string, Promise<{ id: string; snapshot?: LoopSnapshot; summary?: LoopSummary; error?: string }>>()
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let appliedRouteSelectedID = data.selectedID
  const loopCacheKey = (offset = historyPage() * LOOP_HISTORY_PAGE_SIZE, limit = LOOP_HISTORY_PAGE_SIZE, requestedScope = scope()) =>
    loopGlobalPageCacheKey({ offset, limit, scope: requestedScope })
  const cachedPage = (offset = historyPage() * LOOP_HISTORY_PAGE_SIZE, requestedScope = scope()) => {
    const key = loopCacheKey(offset, LOOP_HISTORY_PAGE_SIZE, requestedScope)
    return loopWorkflowListCache.get(key) ?? { active: [], history: [], page: { offset, limit: LOOP_HISTORY_PAGE_SIZE, total: 0 } }
  }

  function requestHeaders(workflow?: LoopWorkflow) {
    const headers = new Headers(sdk.headers)
    const directory = workflow?.project?.directory || workflow?.project?.worktree || sdk.directory
    if (directory) headers.set("x-mendcode-directory", encodeURIComponent(directory))
    headers.set("accept", "application/json")
    return headers
  }

  async function fetchList(source: { refresh: number; cacheKey?: string; offset: number; selectedID?: string; scope: LoopScope }) {
    const key = `${source.scope}:${source.cacheKey ?? "global"}:${source.refresh}:${source.selectedID ?? ""}`
    const inflight = listRequests.get(key)
    if (inflight) return inflight
    const request = fetchListUncached(source).finally(() => listRequests.delete(key))
    listRequests.set(key, request)
    return request
  }

  async function fetchListUncached(source: { refresh: number; cacheKey?: string; offset: number; selectedID?: string; scope: LoopScope }) {
    const fallback = source.cacheKey ? loopWorkflowListCache.get(source.cacheKey) ?? cachedPage(source.offset, source.scope) : cachedPage(source.offset, source.scope)
    const query = new URLSearchParams({ offset: String(source.offset), limit: String(LOOP_HISTORY_PAGE_SIZE) })
    if (source.selectedID) query.set("selectedID", source.selectedID)
    query.set("scope", source.scope)
    const response = await sdk.fetch(`${sdk.url}/loop/global/page?${query}`, { headers: requestHeaders() }).catch(() => undefined)
    if (!response?.ok) {
      setListError(`Loop list failed: ${response?.status ?? "network error"}`)
      return { cacheKey: source.cacheKey, requestKey: source.cacheKey, page: fallback }
    }
    const data = await response.json().catch(() => undefined)
    if (!data || typeof data !== "object" || !Array.isArray(data.active) || !Array.isArray(data.history) || !data.page || typeof data.page !== "object" || !Number.isFinite(data.page.offset) || !Number.isFinite(data.page.limit) || !Number.isFinite(data.page.total)) {
      setListError("Loop list returned an invalid response.")
      return { cacheKey: source.cacheKey, requestKey: source.cacheKey, page: fallback }
    }
    setListError(undefined)
    const page = data as LoopGlobalPage
    if (source.cacheKey) {
      loopWorkflowListCache.set(loopCacheKey(page.page.offset, page.page.limit, source.scope), page)
    }
    return { cacheKey: loopCacheKey(page.page.offset, page.page.limit, source.scope), requestKey: source.cacheKey, page }
  }

  async function fetchSnapshot(key: string, workflow: LoopWorkflow) {
    const inflight = snapshotRequests.get(key)
    if (inflight) return inflight
    const request = fetchSnapshotUncached(workflow).finally(() => snapshotRequests.delete(key))
    snapshotRequests.set(key, request)
    return request
  }

  async function fetchSnapshotUncached(workflow: LoopWorkflow) {
    const id = workflow.id
    const [response, summary] = await Promise.all([
      sdk.fetch(`${sdk.url}/loop/${id}?limit=${LOOP_EVENT_LIMIT}`, { headers: requestHeaders(workflow) }).catch(() => undefined),
      sdk
        .fetch(`${sdk.url}/loop/${id}/summary?limit=${LOOP_EVENT_LIMIT}`, { headers: requestHeaders(workflow) })
        .then((item) => item.ok ? item.json() as Promise<LoopSummary> : undefined)
        .catch(() => undefined),
    ])
    if (!response?.ok) return { id, error: `Loop snapshot failed: ${response?.status ?? "network error"}` }
    const data = await response.json().catch(() => undefined)
    if (!data || typeof data !== "object") return { id, error: "Loop snapshot returned an invalid response." }
    return { id, snapshot: data as LoopSnapshot, summary }
  }

  const [loops] = createResource(
    () => ({ refresh: refresh(), cacheKey: loopCacheKey(), offset: historyPage() * LOOP_HISTORY_PAGE_SIZE, selectedID: routeSelectedID(), scope: scope() }),
    fetchList,
    { initialValue: { cacheKey: loopCacheKey(), page: cachedPage() } },
  )
  const globalPage = createMemo(() => {
    const latest = loops.latest
    if (latest?.cacheKey === loopCacheKey() || latest?.requestKey === loopCacheKey() || routeSelectedID()) return latest.page
    return cachedPage()
  })
  const allLoops = createMemo(() => [...globalPage().active, ...globalPage().history])
  const primaryLoops = createMemo(() => allLoops().filter(isPrimaryLoop).sort(sortActiveLoops))
  const historyLoops = createMemo(() => globalPage().history.slice().sort(sortHistoryLoops))
  const historyPageData = createMemo(() => loopHistoryPageFromContract({ items: historyLoops(), page: globalPage().page }))
  const visibleLoops = createMemo(() => view() === "active" ? primaryLoops() : historyPageData().items)
  const selected = createMemo(() => {
    const items = visibleLoops()
    if (!items.length) return undefined
    if (shouldKeepRouteLoopSelection({ requestedID: routeSelectedID(), loading: loops.loading, items })) return undefined
    return items.find((item) => item.id === selectedID()) ?? items[0]
  })
  const [snapshot] = createResource(
    () => loopSnapshotResourceKey(selected()),
    (key) => {
      const workflow = selected()
      if (!workflow) return undefined
      return fetchSnapshot(key, workflow)
    },
  )
  const currentSnapshotResult = createMemo(() => {
    const latest = snapshot.latest
    if (!latest) return undefined
    return latest.id === selected()?.id ? latest : undefined
  })
  const currentSnapshot = createMemo(() => currentSnapshotResult()?.snapshot)
  const currentSummary = createMemo(() => currentSnapshotResult()?.summary)
  const snapshotError = createMemo(() => currentSnapshotResult()?.error)
  const detail = createMemo(() => currentSnapshot()?.workflow ?? selected())
  const frame = createMemo(() => loopRouteFrameLayout(dimensions().width))
  const deck = createMemo(() => commandDeckLayout(dimensions()))
  const width = createMemo(() => frame().width)
  const narrow = createMemo(() => frame().narrow)
  const stacked = createMemo(() => frame().stacked)
  const listWidth = createMemo(() => loopRouteColumns({ width: width(), stacked: stacked() }).listWidth)
  const detailWidth = createMemo(() => loopRouteColumns({ width: width(), stacked: stacked() }).detailWidth)
  const activeCounts = createMemo(() => loopStateCounts(primaryLoops()))
  const historyCount = createMemo(() => historyPageData().total)

  function requestRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      setRefresh((value) => value + 1)
    }, 100)
  }

  function refreshNow() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    setRefresh((value) => value + 1)
  }

  createEffect(() => {
    const requestedID = data.selectedID
    if (requestedID !== appliedRouteSelectedID) {
      appliedRouteSelectedID = requestedID
      setSelectedID(requestedID)
      setRouteSelectedID(requestedID)
    }
    const requested = requestedID ? allLoops().find((item) => item.id === requestedID) : undefined
    if (requested && !isPrimaryLoop(requested)) {
      setView("history")
      setHistoryPage(Math.floor(globalPage().page.offset / Math.max(1, globalPage().page.limit)))
    }
    if (requested) setRouteSelectedID(undefined)
    if (requestedID && !requested && !loops.loading) setRouteSelectedID(undefined)
  })

  createEffect(() => {
    const page = historyPageData().page
    if (page !== historyPage()) setHistoryPage(page)
  })

  createEffect(() => {
    const item = selected()
    if (routeSelectedID() && !item) return
    if (item && item.id !== selectedID()) setSelectedID(item.id)
  })

  let inspectedID: string | undefined
  createEffect(() => {
    const id = selected()?.id
    if (id === inspectedID) return
    inspectedID = id
    setInspect(false)
  })

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    const fallback = setInterval(requestRefresh, 10_000)
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = event.payload?.type as string | undefined
      if (!type?.startsWith("loop.")) return
      requestRefresh()
    })
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(fallback)
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribe()
    })
  })

  function switchView(next: LoopView) {
    if (view() === next) return
    setView(next)
    if (next === "history") setHistoryPage(0)
    setSelectedID(undefined)
  }

  function switchScope(next: LoopScope) {
    if (scope() === next) return
    setScope(next)
    setView("active")
    setHistoryPage(0)
    setSelectedID(undefined)
    setRouteSelectedID(undefined)
  }

  function selectHistoryPage(offset: number) {
    if (view() !== "history") return
    const current = historyPageData()
    const next = Math.min(Math.max(0, current.page + offset), current.pageCount - 1)
    if (next === current.page) return
    setHistoryPage(next)
    setSelectedID(undefined)
  }

  function selectOffset(offset: number) {
    const items = visibleLoops()
    if (!items.length) return
    const current = Math.max(0, items.findIndex((item) => item.id === selected()?.id))
    const next = (current + offset + items.length) % items.length
    setSelectedID(items[next]?.id)
  }

  async function workflowAction(action: "pause" | "resume" | "stop") {
    const item = selected()
    if (!item) return
    if (action === "stop") {
      const confirmed = await DialogConfirm.show(dialog, "Stop Loop", `Stop ${item.name || item.id}?`)
      dialog.clear()
      if (!confirmed) return
    }
    const headers = requestHeaders(item)
    headers.set("content-type", "application/json")
    const response = await sdk.fetch(`${sdk.url}/loop/${item.id}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: `TUI ${action}` }),
    })
    if (!response.ok) throw new Error(`${action} failed: ${response.status}`)
    refreshNow()
    toast.show({ variant: "success", message: `Loop ${action} requested.`, duration: 2500 })
  }

  async function editAgent() {
    const item = selected()
    if (!item) return
    const current = detail()?.spec?.agent ?? ""
    const value = await DialogPrompt.show(dialog, "Loop agent", {
      placeholder: current || "build (blank = default)",
      value: current,
    })
    dialog.clear()
    if (value === null) return
    const agent = value.trim() || undefined
    const headers = requestHeaders(item)
    headers.set("content-type", "application/json")
    const response = await sdk.fetch(`${sdk.url}/loop/${item.id}/agent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent, reason: `TUI agent set to ${agent ?? "default"}` }),
    })
    if (!response.ok) throw new Error(`agent update failed: ${response.status}`)
    refreshNow()
    toast.show({ variant: "success", message: `Loop agent: ${agent ?? "default"}.`, duration: 2500 })
  }

  async function openChat() {
    const root = detail()?.rootSessionID
    if (!root) {
      toast.show({ variant: "info", message: "This loop has not created a chat session yet.", duration: 2500 })
      return
    }
    const result = await sdk.client.session.get({ sessionID: root }).catch(() => undefined)
    if (!result?.data) {
      toast.show({ variant: "warning", message: `Loop chat session not found: ${root}.`, duration: 3500 })
      return
    }
    route.navigate({ type: "session", sessionID: root })
  }

  async function openOwnerChat() {
    const owner = detail()?.ownerSessionID
    if (!owner) {
      toast.show({ variant: "info", message: "This loop has no parent chat session.", duration: 2500 })
      return
    }
    const result = await sdk.client.session.get({ sessionID: owner }).catch(() => undefined)
    if (!result?.data) {
      toast.show({ variant: "warning", message: `Parent chat session not found: ${owner}.`, duration: 3500 })
      return
    }
    route.navigate({ type: "session", sessionID: owner })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0 || evt.defaultPrevented) return
    const consume = () => {
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "escape" || evt.name === "q") {
      consume()
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (evt.name === "r") {
      consume()
      refreshNow()
      return
    }
    if (evt.name === "c" || evt.name === "g") {
      consume()
      switchScope(evt.name === "c" ? "project" : "all")
      return
    }
    if (evt.name === "a") {
      consume()
      switchView("active")
      return
    }
    if (evt.name === "h") {
      consume()
      switchView("history")
      return
    }
    if (evt.name === "i") {
      consume()
      setInspect((value) => !value)
      return
    }
    if (evt.name === "pageup" && view() === "history") {
      consume()
      selectHistoryPage(-1)
      return
    }
    if (evt.name === "pagedown" && view() === "history") {
      consume()
      selectHistoryPage(1)
      return
    }
    const selectionOffset = loopRouteSelectionOffset(evt.name)
    if (selectionOffset) {
      consume()
      selectOffset(selectionOffset)
      return
    }
    if (evt.name === "o" && evt.shift) {
      consume()
      void openOwnerChat().catch((error) => toast.error(error))
      return
    }
    if (evt.name === "return" || evt.name === "enter" || evt.name === "o") {
      consume()
      void openChat().catch((error) => toast.error(error))
      return
    }
    if (evt.name === "e") {
      consume()
      void editAgent().catch((error) => toast.error(error))
      return
    }
    if (evt.name === "p") {
      consume()
      void workflowAction("pause").catch((error) => toast.error(error))
      return
    }
    if (evt.name === "u") {
      consume()
      void workflowAction("resume").catch((error) => toast.error(error))
      return
    }
    if (evt.name === "s") {
      consume()
      void workflowAction("stop").catch((error) => toast.error(error))
    }
  })

  const events = createMemo(() => (currentSnapshot()?.events ?? []).slice().reverse())
  const runs = createMemo(() => (currentSnapshot()?.runs ?? []).slice(0, 6))
  const artifacts = createMemo(() => currentSnapshot()?.artifacts ?? [])
  const supervisionRows = createMemo(() => loopSupervisionRows({
    workflow: detail(),
    summary: currentSummary(),
    runs: runs(),
    events: events(),
    artifacts: artifacts(),
  }))
  const summaryRows = createMemo(() => loopSummaryRows({ detail: detail(), summary: currentSummary(), runs: runs(), now: now() }))
  const contractRows = createMemo(() => loopContractPreviewRows(detail()))

  const detailRows = createMemo<string[][]>(() => {
    const item = detail()
    if (!item) return []
    const currentTime = now()
    const successChecks = item.spec?.successChecks?.length ?? 0
    const validationChecks = item.spec?.validationChecks?.length ?? 0
    const checks = successChecks + validationChecks
    return [
      ["state", stateLabel(item)],
      ["iteration", progressLabel(item)],
      ["budget", hasInvalidZeroBudget(item) ? "invalid maxTurns=0; recreate with positive cap or unlimited" : `${item.spec?.budgetMode ?? "budget"} · ${progressLabel(item)}`],
      ["next", loopWakeupLabel(item, currentTime)],
      ["scheduler", `${loopSchedulerState(item, currentTime)} · wake ${typeof item.scheduler?.lastWakeAttempt === "number" ? new Date(item.scheduler.lastWakeAttempt).toLocaleTimeString() : "none"}`],
      ["last result", item.scheduler?.lastResult ?? item.scheduler?.lastError ?? "none"],
      ["cadence", cadenceLabel(item)],
      ["evaluation", item.spec?.evaluation?.mode ?? "legacy"],
      ["workspace", item.spec?.workspace?.mode ?? "in-place"],
      ["checks", checks ? `${checks} configured${validationChecks ? ` · ${validationChecks} executable` : ""}` : "none configured"],
      ["retention", retentionLabel(item)],
      ["approvals", approvalDetail(item)],
      ["model", modelLabel(sync.data.provider, item, currentSnapshot()?.rootSession)],
      ["agent", item.spec?.agent ?? "default"],
      ["chat", item.rootSessionID ?? "none yet"],
      ["updated", item.time?.updated ? new Date(item.time.updated).toLocaleTimeString() : "unknown"],
    ]
  })

  return (
    <Show when={deck().wide} fallback={
      <box flexDirection="column" width="100%" height="100%" paddingLeft={frame().paddingX} paddingRight={frame().paddingX} paddingTop={frame().compact ? 0 : 1} paddingBottom={frame().compact ? 0 : 1} gap={frame().compact ? 0 : 1}>
        <Header scope={scope()} view={view()} scheduledCount={activeCounts().scheduled} blockedCount={activeCounts().blocked} historyCount={historyCount()} width={width()} narrow={narrow()} compact={frame().compact} />

        <Show
          when={allLoops().length}
          fallback={<EmptyState loading={loops.loading} error={listError()} historyCount={historyCount()} view={view()} />}
        >
          <Show
            when={!stacked()}
            fallback={<StackedView scope={scope()} view={view()} items={visibleLoops()} pagination={view() === "history" ? historyPageData() : undefined} selected={selected()} select={setSelectedID} detail={detail()} detailRows={detailRows()} summaryRows={summaryRows()} contractRows={contractRows()} supervisionRows={supervisionRows()} summary={currentSummary()} events={events()} runs={runs()} error={snapshotError()} loading={snapshot.loading} inspect={inspect()} width={width()} now={now()} compact={frame().compact} />}
          >
            <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
              <box width={listWidth()} minHeight={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
                <LoopList scope={scope()} view={view()} items={visibleLoops()} pagination={view() === "history" ? historyPageData() : undefined} selected={selected()} select={setSelectedID} width={listWidth() - 4} now={now()} compact={frame().compact} />
              </box>
              <box flexGrow={1} minHeight={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
                <LoopDetail detail={detail()} rows={detailRows()} summaryRows={summaryRows()} contractRows={contractRows()} supervisionRows={supervisionRows()} summary={currentSummary()} events={events()} runs={runs()} error={snapshotError()} loading={snapshot.loading} inspect={inspect()} width={detailWidth() - 4} />
              </box>
            </box>
          </Show>
        </Show>
      </box>
    }>
      <CommandDeck
        page="loops"
        subtitle={() => `${scope() === "project" ? "current project" : "all projects"} · ${view() === "active" ? "scheduled + blocked" : "history · newest first"}`}
        status={() => listError() ? "ERROR" : loops.loading ? "LOADING" : "LIVE"}
         summary={() => `active ${activeCounts().scheduled} · blocked ${activeCounts().blocked} · history ${historyCount()}`}
        footer="↑↓ Select   Enter Open   O Parent   i Inspect   h History   r Refresh   / Find   ? Help   q Back"
         rail={
          <LoopList
            scope={scope()}
            view={view()}
            items={visibleLoops()}
            pagination={view() === "history" ? historyPageData() : undefined}
            selected={selected()}
            select={setSelectedID}
            width={Math.max(14, deck().railWidth - 4)}
            now={now()}
            compact
          />
        }
        context={
          <CommandDeckContext
            title={detail()?.name || detail()?.objective || detail()?.id || "Selected loop"}
            rows={[
              ["state", detail() ? stateLabel(detail()!) : "none"],
              ["phase", detail()?.phase ?? "none"],
              ["next", detail() ? loopWakeupLabel(detail()!, now()) : "none"],
               ["scheduler", detail() ? `${loopSchedulerState(detail()!, now())} · ${detail()!.scheduler?.lastRunState ?? "idle"}` : "unknown"],
               ["model", detail() ? modelLabel(sync.data.provider, detail()!, currentSnapshot()?.rootSession) : "none"],
               ["agent", detail()?.spec?.agent ?? "default"],
               ["runs", String(runs().length)],
               ["view", inspect() ? "inspect" : "summary"],
            ]}
          >
            <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column" gap={1}>
              <text fg={theme.textMuted} wrapMode="none">ACTIONS</text>
              <text fg={theme.text} wrapMode="none">i {inspect() ? "Summary" : "Inspect"}</text>
              <text fg={theme.text} wrapMode="none">o Open chat</text>
              <text fg={theme.text} wrapMode="none">O Parent chat</text>
              <text fg={theme.text} wrapMode="none">p Pause · u Resume</text>
              <text fg={theme.text} wrapMode="none">s Stop (confirm)</text>
            </box>
          </CommandDeckContext>
        }
      >
        <Show
          when={allLoops().length}
          fallback={<EmptyState loading={loops.loading} error={listError()} historyCount={historyCount()} view={view()} />}
        >
          <box flexDirection="column" minHeight={0} flexGrow={1} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
            <LoopDetail detail={detail()} rows={detailRows()} summaryRows={summaryRows()} contractRows={contractRows()} supervisionRows={supervisionRows()} summary={currentSummary()} events={events()} runs={runs()} error={snapshotError()} loading={snapshot.loading} inspect={inspect()} width={Math.max(30, deck().contentWidth - 4)} />
          </box>
        </Show>
      </CommandDeck>
    </Show>
  )
}

function Header(props: { scope: LoopScope; view: LoopView; scheduledCount: number; blockedCount: number; historyCount: number; width: number; narrow: boolean; compact: boolean }) {
  const { theme } = useTheme()
  const summary = () => `${props.scope === "project" ? "current project" : "all projects"} · scheduled ${props.scheduledCount} · blocked ${props.blockedCount} · history ${props.historyCount} · ${props.view}`
  const layout = createMemo(() => loopRouteHeaderLayout(props.narrow))
  return (
    <box flexDirection={layout().flexDirection} width="100%" height={layout().height} flexShrink={layout().flexShrink} gap={props.narrow ? 0 : 1} overflow="hidden">
      <box flexDirection="row" width={props.narrow ? "100%" : Math.max(36, Math.floor(props.width * 0.42))} overflow="hidden">
        <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none">Loop Workflows</text>
        <Show when={props.width >= 42 && !props.compact}>
          <text fg={theme.textMuted} wrapMode="none"> · {Locale.truncate(summary(), Math.max(14, props.width - 18))}</text>
        </Show>
      </box>
      <Show when={!props.narrow}><box flexGrow={1} /></Show>
      <text fg={theme.textMuted} wrapMode="none">{Locale.truncate(loopRouteKeyHint(props), Math.max(10, props.width - 2))}</text>
    </box>
  )
}

function LoopList(props: {
  scope: LoopScope
  view: LoopView
  items: LoopWorkflow[]
  pagination?: LoopHistoryPage<LoopWorkflow>
  selected?: LoopWorkflow
  select: (id: string) => void
  width: number
  now: number
  compact?: boolean
}) {
  const { theme } = useTheme()
  const title = createMemo(() => props.compact
    ? `${props.scope === "project" ? "project" : "all"} · ${props.view}`
    : `${props.scope === "project" ? "current project" : "all projects"} · ${props.view === "active" ? "scheduled + blocked" : "history · newest first"}`)
  const count = createMemo(() => {
    if (!props.pagination) return `${props.items.length}`
    if (!props.pagination.total) return "0 of 0"
    return `page ${props.pagination.page + 1}/${props.pagination.pageCount} · ${props.pagination.start + 1}-${props.pagination.end} of ${props.pagination.total}`
  })
  return (
    <box flexDirection="column" minHeight={0}>
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">{compact(title(), Math.max(12, props.width - 4))}</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">{compact(count(), Math.max(8, Math.floor(props.width / 2)))}</text>
      </box>
      <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} minHeight={0} flexGrow={1}>
        <scrollbox
          flexGrow={1}
          minHeight={0}
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            visible: props.items.length > 8,
            trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
          }}
        >
          <Show when={props.items.length} fallback={<text fg={theme.textMuted} wrapMode="none">{props.view === "active" ? "No scheduled or blocked loops. Press h for history." : "No archived loops."}</text>}>
            <For each={props.items}>
              {(item, index) => (
                <LoopRow
                  item={item}
                  selected={props.selected?.id === item.id}
                  latest={props.view === "history" && props.pagination?.page === 0 && index() === 0}
                  width={props.width}
                  now={props.now}
                  compact={props.compact}
                  onSelect={() => props.select(item.id)}
                />
              )}
            </For>
          </Show>
        </scrollbox>
      </box>
    </box>
  )
}

function LoopRow(props: {
  item: LoopWorkflow
  selected: boolean
  latest: boolean
  width: number
  now: number
  compact?: boolean
  onSelect: () => void
}) {
  const { theme } = useTheme()
  const color = createMemo(() =>
    props.item.state === "failed" ? theme.error :
      props.item.state === "stopped" || props.item.state === "paused" ? theme.warning :
        isPrimaryLoop(props.item) ? theme.secondary :
          theme.textMuted,
  )
  const titleWidth = createMemo(() => Math.max(8, props.width - (props.compact ? 2 : 10)))
  const detailWidth = createMemo(() => Math.max(8, props.width - 2))
  const detail = createMemo(() => {
    const when = timeLabel(timestamp(props.item))
    const status = isPrimaryLoop(props.item) ? `${stateLabel(props.item)} · next ${loopWakeupLabel(props.item, props.now)}` : stateLabel(props.item)
    const chat = props.item.rootSessionID ? "chat ready" : cadenceLabel(props.item)
    const lead = props.latest ? "latest · " : ""
    if (props.compact) return `${lead}${status} · ${chat}`
    return `${lead}${when} · ${loopWorkflowProjectLabel(props.item)} · ${status} · ${chat}`
  })
  return (
    <box flexDirection="column" height={props.compact ? 2 : 3} overflow="hidden" marginBottom={props.compact ? 0 : 1} onMouseUp={props.onSelect}>
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={props.selected ? theme.primary : color()} attributes={props.selected ? TextAttributes.BOLD : undefined} wrapMode="none">
          {props.selected ? "› " : "  "}{compact(props.item.name || props.item.objective || props.item.id, titleWidth())}
        </text>
        <box flexGrow={1} />
        <Show when={!props.compact}>
          <text fg={color()} wrapMode="none">{compact(progressLabel(props.item), 8)}</text>
        </Show>
      </box>
      <text fg={props.selected ? theme.text : theme.textMuted} wrapMode="none">  {compact(detail(), detailWidth())}</text>
    </box>
  )
}

function LoopDetail(props: {
  detail?: LoopWorkflow
  rows: string[][]
  summaryRows: string[][]
  contractRows: string[][]
  supervisionRows: string[][]
  summary?: LoopSummary
  events: LoopEvent[]
  runs: LoopRun[]
  error?: string
  loading?: boolean
  inspect: boolean
  width: number
}) {
  const { theme } = useTheme()
  const stopMousePropagation = (event?: unknown) => {
    const maybeEvent = event as { stopPropagation?: () => void } | undefined
    maybeEvent?.stopPropagation?.()
  }
  const eventRows = createMemo(() => props.events.length * 3)
  const eventViewportHeight = createMemo(() => Math.min(18, Math.max(3, eventRows())))
  const eventScrollbarVisible = createMemo(() => eventRows() > eventViewportHeight())
  const header = createMemo(() => loopDetailHeaderLayout(props.width, props.detail?.id.length ?? 0))
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1}>
      <Show when={props.detail} fallback={<text fg={theme.textMuted} wrapMode="none">Select a loop.</text>}>
        {(item) => (
          <scrollbox
            flexGrow={1}
            minHeight={0}
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column" gap={1}>
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" height={1} overflow="hidden">
                  <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none" selectable={false}>
                    {compact(item().name || item().objective || item().id, header().titleWidth)}
                  </text>
                  <box flexGrow={1} />
                  <text fg={theme.textMuted} wrapMode="none" selectable={false}>{compact(item().id, header().idWidth)}</text>
                </box>
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>{compact(item().objective, props.width)}</text>
              </box>

              <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <Show when={props.loading && !props.error}>
                  <text fg={theme.textMuted} wrapMode="none" selectable={false}>loading latest snapshot…</text>
                </Show>
                <Show when={props.error}>
                  {(error) => <text fg={theme.warning} wrapMode="none" selectable={false}>snapshot unavailable · {compact(error(), Math.max(12, props.width - 23))}</text>}
                </Show>
                <For each={props.summaryRows}>
                  {(row) => <DetailRow label={row[0]} value={row[1]} width={props.width} emphasize={row[0] === "state" || row[0] === "verdict" || row[0] === "next action"} />}
                </For>
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>{props.inspect ? "i summary" : "i inspect contract, gates, runs, and events"}</text>
                <Show when={props.inspect}>
                  <For each={props.rows}>
                    {(row) => <DetailRow label={row[0]} value={row[1]} width={props.width} emphasize={row[0] === "chat"} />}
                  </For>
                </Show>
              </box>

              <Show when={props.inspect}>
                <box flexDirection="column" gap={1}>
                  <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>contract preview</text>
                <For each={props.contractRows}>
                  {(row) => <DetailRow label={row[0]} value={row[1]} width={props.width} emphasize={row[0] === "approval" || row[0] === "verify"} />}
                </For>
                  </box>

                  <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>supervision</text>
                <For each={props.supervisionRows}>
                  {(row) => <DetailRow label={row[0]} value={row[1]} width={props.width} emphasize={row[0] === "verdict" || row[0] === "next action"} />}
                </For>
                <Show when={props.summary?.evidenceSummary?.slice(1, 4)}>
                  {(items) => (
                    <For each={items()}>
                      {(item) => <text fg={theme.textMuted} wrapMode="none" selectable={false}>  {compact(`evidence · ${item}`, Math.max(12, props.width - 2))}</text>}
                    </For>
                  )}
                </Show>
                <Show when={props.summary?.memorySummary?.latest?.slice(0, 3)}>
                  {(items) => (
                    <For each={items()}>
                      {(item) => <text fg={theme.textMuted} wrapMode="none" selectable={false}>  {compact(`memory · ${item}`, Math.max(12, props.width - 2))}</text>}
                    </For>
                  )}
                </Show>
                  </box>

                  <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>recent runs</text>
                <Show when={props.runs.length} fallback={<text fg={theme.textMuted} wrapMode="none" selectable={false}>no runs yet</text>}>
                  <For each={props.runs}>
                    {(run) => (
                      <text fg={run.state === "failed" ? theme.error : theme.text} wrapMode="none" selectable={false}>
                        {compact(`${run.state} · ${run.trigger || "run"} · ${run.judgment?.status ?? run.checkpoint?.status ?? run.evaluatorReason ?? run.phase ?? ""}`, props.width)}
                      </text>
                    )}
                  </For>
                </Show>
                  </box>

                  <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <box flexDirection="row" height={1} overflow="hidden">
                  <text fg={theme.textMuted} wrapMode="none" selectable={false}>events</text>
                  <box flexGrow={1} />
                  <Show when={props.events.length >= LOOP_EVENT_LIMIT}>
                    <text fg={theme.textMuted} wrapMode="none" selectable={false}>latest {LOOP_EVENT_LIMIT}</text>
                  </Show>
                </box>
                <Show when={props.events.length} fallback={<text fg={theme.textMuted} wrapMode="none" selectable={false}>no events yet</text>}>
                  <Show
                    when={eventScrollbarVisible()}
                    fallback={
                      <For each={props.events}>
                        {(event, index) => <TimelineEvent event={event} width={props.width} last={index() === props.events.length - 1} />}
                      </For>
                    }
                  >
                    <scrollbox
                      height={eventViewportHeight()}
                      horizontalScrollbarOptions={{ visible: false }}
                      onMouseScroll={stopMousePropagation}
                      verticalScrollbarOptions={{
                        visible: true,
                        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                      }}
                    >
                      <For each={props.events}>
                        {(event, index) => <TimelineEvent event={event} width={props.width - 2} last={index() === props.events.length - 1} />}
                      </For>
                    </scrollbox>
                    </Show>
                  </Show>
                  </box>
                </box>
              </Show>
            </box>
          </scrollbox>
        )}
      </Show>
    </box>
  )
}

function TimelineEvent(props: { event: LoopEvent; width: number; last: boolean }) {
  const { theme } = useTheme()
  const color = createMemo(() =>
    props.event.level === "error" || props.event.type === "failed" ? theme.error :
      props.event.type === "paused" || props.event.type === "stopped" ? theme.warning :
        props.event.type === "completed" || props.event.type === "resumed" ? theme.secondary :
          theme.textMuted,
  )
  const titleWidth = createMemo(() => Math.max(12, props.width - 8))
  const summaryWidth = createMemo(() => Math.max(12, props.width - 8))
  return (
    <box flexDirection="row" height={3} overflow="hidden">
      <box flexDirection="column" width={3} alignItems="center">
        <text fg={color()} wrapMode="none" selectable={false}>●</text>
        <text fg={props.last ? theme.textMuted : theme.border} wrapMode="none" selectable={false}>{props.last ? " " : "│"}</text>
      </box>
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={color()} wrapMode="none" selectable={false}>
          {compact(`${eventTimeLabel(props.event)} · ${props.event.type} · ${props.event.title}`, titleWidth())}
        </text>
        <text fg={theme.textMuted} wrapMode="none" selectable={false}>
          {compact(props.event.summary, summaryWidth())}
        </text>
      </box>
    </box>
  )
}

function DetailRow(props: { label: string; value: string; width: number; emphasize?: boolean }) {
  const { theme } = useTheme()
  const layout = createMemo(() => loopDetailRowLayout(props.width))
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={layout().gap}>
      <text fg={theme.textMuted} width={layout().labelWidth} wrapMode="none" selectable={false}>{fixedCell(props.label, layout().labelWidth)}</text>
      <text fg={props.emphasize ? theme.secondary : theme.text} width={layout().valueWidth} wrapMode="none" selectable={false}>{fixedCell(props.value, layout().valueWidth)}</text>
    </box>
  )
}

function StackedView(props: {
  scope: LoopScope
  view: LoopView
  items: LoopWorkflow[]
  pagination?: LoopHistoryPage<LoopWorkflow>
  selected?: LoopWorkflow
  select: (id: string) => void
  detail?: LoopWorkflow
  detailRows: string[][]
  summaryRows: string[][]
  contractRows: string[][]
  supervisionRows: string[][]
  summary?: LoopSummary
  events: LoopEvent[]
  runs: LoopRun[]
  error?: string
  loading?: boolean
  inspect: boolean
  width: number
  now: number
  compact?: boolean
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      horizontalScrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: true,
        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
      }}
    >
      <box flexDirection="column" gap={props.compact ? 0 : 1}>
        <box borderStyle="single" borderColor={theme.border} paddingLeft={props.compact ? 0 : 1} paddingRight={props.compact ? 0 : 1} height={loopRouteStackedListHeight(props.items.length, Boolean(props.compact), dimensions().height)} flexShrink={0}>
          <LoopList
            scope={props.scope}
            view={props.view}
            items={props.items}
            pagination={props.pagination}
            selected={props.selected}
            select={props.select}
            width={Math.max(20, props.width - (props.compact ? 2 : 4))}
            now={props.now}
            compact={props.compact}
          />
        </box>
        <Show
          when={!props.compact}
          fallback={
            <CompactLoopDetail detail={props.detail} rows={props.detailRows} summaryRows={props.summaryRows} contractRows={props.contractRows} supervisionRows={props.supervisionRows} events={props.events} runs={props.runs} error={props.error} loading={props.loading} inspect={props.inspect} width={Math.max(20, props.width - 2)} />
          }
        >
          <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
            <LoopDetail detail={props.detail} rows={props.detailRows} summaryRows={props.summaryRows} contractRows={props.contractRows} supervisionRows={props.supervisionRows} summary={props.summary} events={props.events} runs={props.runs} error={props.error} loading={props.loading} inspect={props.inspect} width={props.width - 4} />
          </box>
        </Show>
      </box>
    </scrollbox>
  )
}

function CompactLoopDetail(props: {
  detail?: LoopWorkflow
  rows: string[][]
  summaryRows: string[][]
  contractRows: string[][]
  supervisionRows: string[][]
  events: LoopEvent[]
  runs: LoopRun[]
  error?: string
  loading?: boolean
  inspect: boolean
  width: number
}) {
  const { theme } = useTheme()
  const lines = createMemo(() => props.inspect
    ? compactLoopDetailLines({
        detail: props.detail,
        rows: props.rows,
        contractRows: props.contractRows,
        supervisionRows: props.supervisionRows,
      })
    : compactLoopSummaryLines({ detail: props.detail, summaryRows: props.summaryRows }))
  return (
    <box borderStyle="single" borderColor={theme.border} paddingLeft={0} paddingRight={0} flexDirection="column">
      <Show when={props.detail} fallback={<text fg={theme.textMuted} wrapMode="none">Select a loop.</text>}>
        {(item) => (
          <box flexDirection="column" overflow="hidden">
            <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none" selectable={false}>
              {compact(item().name || item().objective || item().id, props.width)}
            </text>
            <Show when={props.error}>
              {(error) => <text fg={theme.warning} wrapMode="none" selectable={false}>{compact(`snapshot unavailable · ${error()}`, props.width)}</text>}
            </Show>
            <Show when={props.loading && !props.error}>
              <text fg={theme.textMuted} wrapMode="none" selectable={false}>loading latest snapshot…</text>
            </Show>
            <text fg={theme.textMuted} wrapMode="none" selectable={false}>{props.inspect ? "i summary" : "i inspect details"}</text>
            <For each={lines()}>
              {(line, index) => (
                <text fg={index() === 0 ? theme.text : theme.textMuted} wrapMode="none" selectable={false}>
                  {compact(line, props.width)}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  )
}

function EmptyState(props: { loading: boolean; error?: string; historyCount: number; view: LoopView }) {
  const { theme } = useTheme()
  const empty = () =>
    props.view === "active" && props.historyCount > 0
      ? "No scheduled or blocked loops. Press h to review history."
      : "No loop workflows found."
  return (
    <box flexDirection="column" width="100%" height="100%" alignItems="center" justifyContent="center" gap={1}>
      <text fg={props.error ? theme.warning : theme.secondary} wrapMode="none">
        {props.loading ? "Loading loop workflows..." : props.error ?? empty()}
      </text>
      <text fg={theme.textMuted} wrapMode="none">{props.error ? "Press r to retry." : "Use /loop from a session to create one."}</text>
    </box>
  )
}
