export function sessionPromptVisible(input: {
  isChildSession: boolean
  permissionCount: number
  questionCount: number
  planReviewCount: number
}) {
  void input.isChildSession
  return input.permissionCount === 0 && input.questionCount === 0 && input.planReviewCount === 0
}

export function sessionPendingInputSessionIDs(input: {
  sessionID: string
  parentID?: string
  visibleSessionIDs: string[]
}) {
  if (input.parentID) return [input.sessionID]
  return input.visibleSessionIDs
}

const SESSION_SIDE_PADDING = 2
const SESSION_USAGE_BAR_CELLS = 8

export type SessionUsageBarLayout = {
  context: number
  contextLimit?: number
  contextPercent?: number
}

export type SessionGitDiffStatsLayout = {
  added: number
  removed: number
}

export function sessionHorizontalInset(edgeToEdge: boolean) {
  return edgeToEdge ? 0 : SESSION_SIDE_PADDING * 2
}

export function sessionContentWidth(terminalWidth: number, edgeToEdge: boolean) {
  return Math.max(1, terminalWidth - sessionHorizontalInset(edgeToEdge))
}

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".0", "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(".0", "")}K`
  return value.toString()
}

export function sessionUsageBarLabels(input: SessionUsageBarLayout) {
  const context = Math.max(0, input.context)
  const percent = input.contextPercent === undefined ? undefined : Math.max(0, Math.min(100, input.contextPercent))
  const detailLabel = input.contextLimit
    ? `${compactNumber(context)} / ${compactNumber(input.contextLimit)}`
    : compactNumber(context)
  const compactLabel = (() => {
    if (input.contextLimit) {
      const rawPercent = input.contextLimit <= 0 ? 0 : (context / input.contextLimit) * 100
      if (rawPercent >= 100) return ">99%"
      return `${Math.max(1, Math.min(99, Math.round(rawPercent)))}%`
    }
    if (percent === undefined) return compactNumber(context)
    return `${Math.max(1, Math.min(99, percent))}%`
  })()
  const barWidth =
    percent === undefined ? Bun.stringWidth(compactLabel) : SESSION_USAGE_BAR_CELLS + 1 + Bun.stringWidth(compactLabel)
  const displayWidth = Math.max(barWidth, Bun.stringWidth(detailLabel))

  return {
    compactLabel,
    detailLabel,
    displayWidth,
    barWidth,
    percent,
  }
}

export function sessionUsageBarDisplayWidth(input: SessionUsageBarLayout) {
  return sessionUsageBarLabels(input).displayWidth
}

export function sessionDiffStatsLabel(input: SessionGitDiffStatsLayout) {
  return `+${compactNumber(input.added)} -${compactNumber(input.removed)}`
}

export function sessionTopMetricsWidth(input: { diff?: SessionGitDiffStatsLayout; usage?: SessionUsageBarLayout }) {
  const diffWidth = input.diff ? Bun.stringWidth(sessionDiffStatsLabel(input.diff)) : 0
  const usageWidth = input.usage ? sessionUsageBarDisplayWidth(input.usage) : 0
  const separatorWidth = input.diff && input.usage ? 3 : 0

  return diffWidth + separatorWidth + usageWidth
}

export function sessionTopbarLeftWidth(input: { contentWidth: number; metricsWidth: number }) {
  if (input.metricsWidth <= 0) return Math.max(0, input.contentWidth)
  return Math.max(0, input.contentWidth - input.metricsWidth - 1)
}

export type SessionHeaderTitleAlign = "left" | "center" | "right"

export type SessionTopbarLayout = {
  pathWidth: number
  navWidth: number
  leftWidth: number
  titleWidth: number
  metricsWidth: number
}

export function sessionTopbarLayout(input: {
  contentWidth: number
  metricsWidth: number
  navWidth?: number
  titleVisible?: boolean
}): SessionTopbarLayout {
  const contentWidth = Math.max(1, Math.floor(input.contentWidth))
  const metricsWidth = Math.min(Math.max(0, Math.floor(input.metricsWidth)), Math.floor(contentWidth * 0.3))
  const titleWidth = input.titleVisible
    ? Math.min(Math.max(12, Math.floor(contentWidth * 0.34)), Math.max(0, contentWidth - metricsWidth))
    : 0
  const leftWidth = input.titleVisible
    ? Math.min(Math.floor(contentWidth * 0.38), Math.max(0, contentWidth - titleWidth - metricsWidth))
    : Math.max(0, contentWidth - metricsWidth)
  const navWidth = Math.min(Math.max(0, Math.floor(input.navWidth ?? 0)), Math.floor(leftWidth * 0.6))
  const pathWidth = Math.max(0, leftWidth - navWidth - (navWidth > 0 ? 1 : 0))

  return {
    pathWidth,
    navWidth,
    leftWidth,
    titleWidth,
    metricsWidth,
  }
}

export function sessionTopbarLeftWidthWithTitle(input: { contentWidth: number; metricsWidth: number; titleVisible?: boolean }) {
  const base = sessionTopbarLeftWidth(input)
  if (!input.titleVisible) return base
  return Math.max(12, Math.min(base, Math.floor(input.contentWidth * 0.42)))
}

export function sessionHeaderTitleAlign(value: unknown): SessionHeaderTitleAlign {
  if (value === "left" || value === "center" || value === "right") return value
  return "right"
}

export function sessionHeaderTitleJustify(align: SessionHeaderTitleAlign) {
  if (align === "left") return "flex-start"
  if (align === "center") return "center"
  return "flex-end"
}

export function truncateMiddleDisplay(value: string, maxWidth: number) {
  if (maxWidth <= 0) return ""
  if (Bun.stringWidth(value) <= maxWidth) return value

  const ellipsis = "…"
  const ellipsisWidth = Bun.stringWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) return ellipsis

  const chars = [...value]
  let left = 0
  let right = chars.length - 1
  let start = ""
  let end = ""
  let startWidth = 0
  let endWidth = 0
  let takeStart = true

  while (left <= right) {
    const budget = maxWidth - ellipsisWidth - startWidth - endWidth
    if (budget <= 0) break

    if (takeStart) {
      const char = chars[left]
      const width = Bun.stringWidth(char)
      if (width > budget) break
      start += char
      startWidth += width
      left++
    } else {
      const char = chars[right]
      const width = Bun.stringWidth(char)
      if (width > budget) break
      end = char + end
      endWidth += width
      right--
    }
    takeStart = !takeStart
  }

  return `${start}${ellipsis}${end}`
}

export function sessionTopbarLeftLabel(input: {
  branch: string
  path: string
  maxWidth: number
  isChildSession?: boolean
}) {
  const sessionKind = input.isChildSession ? "Subagent | " : ""
  return truncateMiddleDisplay(`${sessionKind} ${input.branch || "git"} ${input.path}`, input.maxWidth)
}

export type SessionLoopReceiptTone = "active" | "danger" | "info" | "muted" | "success" | "warning"

export type SessionTaskContinuationEntry = {
  callID: string
  sessionID?: string
  taskID?: string
  status?: string
}

export function sessionTaskContinuation(input: {
  entries: SessionTaskContinuationEntry[]
  callID: string
  sessionID?: string
  taskID?: string
}) {
  const current = input.entries.find((entry) => entry.callID === input.callID)
  const target = input.sessionID ?? input.taskID ?? current?.sessionID ?? current?.taskID
  if (!target) return { duplicate: false, activeResume: false, resumed: false, resumeCount: 0 }

  const sameSession = input.entries.filter((entry) => (entry.sessionID ?? entry.taskID) === target)
  const currentIndex = sameSession.findIndex((entry) => entry.callID === input.callID)
  const latest = sameSession.at(-1)
  const resumed = currentIndex > 0

  return {
    duplicate: latest ? latest.callID !== input.callID : false,
    activeResume: resumed && current?.status === "running",
    resumed,
    resumeCount: Math.max(0, sameSession.length - 1),
  }
}

export function sessionLoopReceipt(input: {
  action?: string
  toolStatus?: string
  workflowState?: string
  workflowPhase?: string
}): { label: string; tone: SessionLoopReceiptTone } {
  const action = input.action?.toLowerCase().replace(/-/g, "_")
  const toolStatus = input.toolStatus?.toLowerCase()
  const state = input.workflowState?.toLowerCase()
  const phase = input.workflowPhase?.toLowerCase()
  const stateReceipt = () => {
    if (state === "failed" || phase === "failed") return { label: "failed", tone: "danger" as const }
    if (state === "blocked") {
      if (phase === "budget_exhausted") return { label: "budget reached", tone: "warning" as const }
      return { label: "blocked", tone: "danger" as const }
    }
    if (state === "stopped") return { label: "stopped", tone: "danger" as const }
    if (state === "paused") return { label: "paused", tone: "warning" as const }
    if (state === "needs_input" || phase === "needs_input") return { label: "needs input", tone: "warning" as const }
    if (state === "completed") return { label: "complete", tone: "success" as const }
    if (state === "draft" || phase === "draft") return { label: "draft", tone: "info" as const }
    if (state === "working" || phase === "executing") return { label: "running", tone: "active" as const }
    if (phase === "monitor") return { label: "monitoring", tone: "active" as const }
    if (state === "sleeping" || phase === "waiting") return { label: "waiting", tone: "warning" as const }
    if (state === "active" || phase === "ready") return { label: "ready", tone: "info" as const }
    if (state === "queued") return { label: "queued", tone: "info" as const }
    return undefined
  }
  if (toolStatus === "error") return { label: "failed", tone: "danger" }
  if (toolStatus === "running") {
    if (action === "activate") return { label: "starting", tone: "active" }
    if (action === "draft") return { label: "drafting", tone: "info" }
    if (action === "show" || action === "list") return { label: "searching", tone: "info" }
    if (action === "pause") return { label: "pausing", tone: "warning" }
    if (action === "resume") return { label: "resuming", tone: "active" }
    if (action === "stop") return { label: "stopping", tone: "danger" }
    if (action === "delete") return { label: "deleting", tone: "danger" }
    if (action === "run_once") return { label: "running", tone: "active" }
    if (action === "update_agent") return { label: "updating", tone: "warning" }
    return { label: "running", tone: "active" }
  }
  const currentState = stateReceipt()
  if (currentState && (action === "show" || action === "list" || state === "failed" || state === "blocked" || state === "needs_input")) return currentState
  if (action === "activate") return { label: "started", tone: "success" }
  if (action === "draft") return { label: "drafted", tone: "info" }
  if (action === "show" || action === "list") return { label: "searched", tone: "muted" }
  if (action === "pause") return { label: "paused", tone: "warning" }
  if (action === "resume") return { label: "resumed", tone: "success" }
  if (action === "stop") return { label: "stopped", tone: "danger" }
  if (action === "delete") return { label: "deleted", tone: "danger" }
  if (action === "run_once") return { label: "ran", tone: "success" }
  if (action === "update_agent") return { label: "updated", tone: "success" }

  if (currentState) return currentState
  return { label: "ready", tone: "info" }
}
