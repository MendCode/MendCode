export function sessionPromptVisible(input: {
  isChildSession: boolean
  permissionCount: number
  questionCount: number
  planReviewCount: number
}) {
  void input.isChildSession
  return input.permissionCount === 0 && input.questionCount === 0 && input.planReviewCount === 0
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
