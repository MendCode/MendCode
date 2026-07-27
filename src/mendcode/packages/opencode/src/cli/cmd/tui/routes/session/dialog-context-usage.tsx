import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { AssistantMessage, Message, Part, Provider } from "@mendcode/sdk/v2"
import { createMemo, For, Show } from "solid-js"
import { compactionThresholdPercent } from "@/session/overflow"
import { Locale } from "@/util/locale"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import {
  formatAssistantUsage,
  formatAssistantLiveUsage,
  formatAssistantUsageTotal,
  type AssistantUsageSummary,
} from "../../util/usage"

type ProviderIndex = Provider[] | ReadonlyMap<string, Provider>

type ContextUsageDialogProps = {
  messages: Message[]
  partsByMessageID: Record<string, Part[] | undefined>
  providers?: ProviderIndex
  mainAgentNames?: Set<string>
  config?: unknown
}

const BAR_CELLS = 48
const GRID_COLUMNS = 8

type ContextUsageGridLayout = {
  cells: number
  columns: number
  compactLegend: boolean
}

type ContextUsageGridKind = "prompt" | "tool" | "cache" | "reasoning" | "output" | "free"

export type ContextUsageGridCell = {
  kind: ContextUsageGridKind
  symbol: string
  label: string
}

const CONTEXT_GRID_SYMBOLS: Record<ContextUsageGridKind, { symbol: string; label: string; shortLabel: string }> = {
  prompt: { symbol: "▣", label: "system/messages/memory", shortLabel: "input" },
  tool: { symbol: "⚙", label: "tool context", shortLabel: "tools" },
  cache: { symbol: "◇", label: "cache", shortLabel: "cache" },
  reasoning: { symbol: "✦", label: "reasoning", shortLabel: "think" },
  output: { symbol: "▼", label: "assistant output", shortLabel: "output" },
  free: { symbol: "·", label: "free", shortLabel: "free" },
}

function contextGridCell(kind: ContextUsageGridKind): ContextUsageGridCell {
  return { kind, ...CONTEXT_GRID_SYMBOLS[kind] }
}

function percentLabel(usage: AssistantUsageSummary | undefined) {
  if (!usage?.contextLimit) return
  const value = (usage.context / usage.contextLimit) * 100
  if (value < 1) return `${Math.round(value * 100) / 100}%`
  if (value < 10) return `${Math.round(value * 10) / 10}%`
  return `${Math.round(value)}%`
}

function contextLabel(usage: AssistantUsageSummary | undefined) {
  if (!usage) return "No token usage yet"
  const limit = usage.contextLimit ? ` / ${Locale.number(usage.contextLimit)}` : ""
  const percent = percentLabel(usage)
  return `${Locale.number(usage.context)}${limit} tokens${percent ? ` (${percent})` : ""}`
}

function freeTokens(usage: AssistantUsageSummary | undefined) {
  if (!usage?.contextLimit) return undefined
  return Math.max(0, usage.contextLimit - usage.context)
}

export function contextAutoCompactLabel(input: {
  usage?: Pick<AssistantUsageSummary, "context" | "contextLimit">
  thresholdPercent: number
}) {
  const usage = input.usage
  if (!usage?.contextLimit) return "Auto-compact threshold unavailable"
  const threshold = Math.floor(usage.contextLimit * (input.thresholdPercent / 100))
  const remaining = Math.max(0, threshold - usage.context)
  return `Auto-compact at ${Locale.number(input.thresholdPercent)}% · ~${Locale.number(remaining)} tokens remaining`
}

export function contextUsageBarCells(usage: Pick<AssistantUsageSummary, "context" | "contextLimit"> | undefined) {
  const ratio = usage?.contextLimit ? Math.max(0, Math.min(1, usage.context / usage.contextLimit)) : 0
  const used = Math.max(usage && usage.context > 0 ? 1 : 0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)))
  return Array.from({ length: BAR_CELLS }, (_, index) => index < used)
}

export function contextUsageGridCells(input: {
  usage: Pick<AssistantUsageSummary, "context" | "contextLimit" | "rawInput" | "cacheRead" | "cacheWrite" | "rawOutput" | "reasoning"> | undefined
  messages: number
  toolCalls: number
  cellCount?: number
}) {
  const usage = input.usage
  const cellCount = Math.max(1, Math.floor(input.cellCount ?? BAR_CELLS))
  const used = usage?.contextLimit
    ? Math.max(usage.context > 0 ? 1 : 0, Math.min(cellCount, Math.round((usage.context / usage.contextLimit) * cellCount)))
    : 0
  if (!usage || used === 0) return Array.from({ length: cellCount }, () => contextGridCell("free"))
  const toolTokens = input.toolCalls > 0 && usage.rawInput > 0
    ? Math.max(1, Math.round(usage.rawInput * Math.min(0.35, input.toolCalls / Math.max(1, input.messages + input.toolCalls))))
    : 0
  const buckets = [
    { kind: "prompt" as const, tokens: Math.max(0, usage.rawInput - toolTokens), order: 0 },
    { kind: "tool" as const, tokens: toolTokens, order: 1 },
    { kind: "cache" as const, tokens: usage.cacheRead + usage.cacheWrite, order: 2 },
    { kind: "reasoning" as const, tokens: usage.reasoning, order: 3 },
    { kind: "output" as const, tokens: usage.rawOutput, order: 4 },
  ].filter((bucket) => bucket.tokens > 0)
  const counted = used <= buckets.length
    ? buckets
      .map((bucket) => ({ ...bucket, count: [...buckets].sort((a, b) => b.tokens - a.tokens || a.order - b.order).slice(0, used).some((item) => item.kind === bucket.kind) ? 1 : 0 }))
    : (() => {
      const initial = buckets.map((bucket) => {
        const exact = (bucket.tokens / Math.max(1, usage.context)) * used
        return { ...bucket, exact, count: Math.max(1, Math.floor(exact)) }
      })
      const remaining = used - initial.reduce((sum, bucket) => sum + bucket.count, 0)
      if (remaining < 0) {
        let overflow = Math.abs(remaining)
        const reduceOrder = [...initial].sort((a, b) => b.count - a.count || a.order - b.order).map((bucket) => bucket.kind)
        return initial.map((bucket) => {
          const drop = reduceOrder.includes(bucket.kind) ? Math.min(Math.max(0, bucket.count - 1), overflow) : 0
          overflow -= drop
          return { ...bucket, count: bucket.count - drop }
        })
      }
      const ranked = [...initial].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.order - b.order).slice(0, Math.max(0, remaining)).map((bucket) => bucket.kind)
      return initial.map((bucket) => ({ ...bucket, count: bucket.count + (ranked.includes(bucket.kind) ? 1 : 0) }))
    })()
  const filled = counted.flatMap((bucket) => Array.from({ length: bucket.count }, () => contextGridCell(bucket.kind))).slice(0, used)
  return [...filled, ...Array.from({ length: Math.max(0, cellCount - filled.length) }, () => contextGridCell("free"))]
}

export function contextUsageGridLegend(compact = false) {
  return (["prompt", "tool", "cache", "reasoning", "output", "free"] as const).map((kind) => ({
    ...contextGridCell(kind),
    label: compact ? CONTEXT_GRID_SYMBOLS[kind].shortLabel : CONTEXT_GRID_SYMBOLS[kind].label,
  }))
}

export function contextUsageGridRows(cells: ContextUsageGridCell[], columns = GRID_COLUMNS) {
  const size = Math.max(1, Math.floor(columns))
  return Array.from({ length: Math.ceil(cells.length / size) }, (_, index) => cells.slice(index * size, index * size + size))
}

export function contextUsageGridLayout(width: number): ContextUsageGridLayout {
  if (width >= 160) return { cells: 240, columns: 24, compactLegend: false }
  if (width >= 120) return { cells: 128, columns: 16, compactLegend: false }
  if (width >= 96) return { cells: 96, columns: 12, compactLegend: false }
  return { cells: BAR_CELLS, columns: GRID_COLUMNS, compactLegend: true }
}

export function contextInventoryRows(input: {
  messages: number
  turns: number
  textParts: number
  toolCalls: number
  reasoningParts: number
  compactions: number
}) {
  return [
    { label: "Messages", value: Locale.number(input.messages) },
    { label: "Turns", value: Locale.number(input.turns) },
    { label: "Text", value: Locale.number(input.textParts) },
    { label: "Tools", value: Locale.number(input.toolCalls) },
    { label: "Reasoning", value: Locale.number(input.reasoningParts) },
    { label: "Compactions", value: Locale.number(input.compactions) },
  ]
}

function row(label: string, value: number | undefined, percent?: string) {
  return {
    label,
    value: value === undefined ? "unknown" : `${Locale.number(value)} tokens`,
    percent,
  }
}

export function DialogContextUsage(props: ContextUsageDialogProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  useKeyboard((evt) => {
    if (evt.name !== "return") return
    evt.preventDefault()
    evt.stopPropagation()
    dialog.clear()
  })

  const assistantMessages = createMemo(() =>
    props.messages.filter((message): message is AssistantMessage => message.role === "assistant"),
  )
  const latestAssistant = createMemo(() => assistantMessages().at(-1))
  const usageMessage = createMemo(() => {
    for (const message of assistantMessages().toReversed()) {
      if (props.mainAgentNames && !props.mainAgentNames.has(message.agent)) continue
      if (formatAssistantUsage(message, props.providers, { config: props.config })) return message
    }
    for (const message of assistantMessages().toReversed()) {
      if (formatAssistantUsage(message, props.providers, { config: props.config })) return message
    }
  })
  const usage = createMemo(() => {
    const latest = latestAssistant()
    const live = latest && !latest.time.completed ? formatAssistantLiveUsage(latest, props.providers, { config: props.config }) : undefined
    if (live) return live
    const message = usageMessage()
    return message ? formatAssistantUsage(message, props.providers, { config: props.config }) : undefined
  })
  const total = createMemo(() => formatAssistantUsageTotal(assistantMessages(), props.providers))
  const allParts = createMemo(() => props.messages.flatMap((message) => props.partsByMessageID[message.id] ?? []))
  const toolCalls = createMemo(() => allParts().filter((part) => part.type === "tool").length)
  const compactions = createMemo(() => allParts().filter((part) => part.type === "compaction").length)
  const textParts = createMemo(() => allParts().filter((part) => part.type === "text").length)
  const reasoningParts = createMemo(() => allParts().filter((part) => part.type === "reasoning").length)
  const turns = createMemo(() => props.messages.filter((message) => message.role === "user").length)
  const thresholdPercent = createMemo(() => {
    const message = usageMessage() ?? latestAssistant()
    return compactionThresholdPercent({
      cfg: props.config,
      model: message ? { id: message.modelID, providerID: message.providerID } : undefined,
    })
  })
  const gridLayout = createMemo(() => contextUsageGridLayout(dimensions().width))
  const cells = createMemo(() => contextUsageGridCells({ usage: usage(), messages: props.messages.length, toolCalls: toolCalls(), cellCount: gridLayout().cells }))
  const gridRows = createMemo(() => contextUsageGridRows(cells(), gridLayout().columns))
  const free = createMemo(() => freeTokens(usage()))
  const rows = createMemo(() => {
    const current = usage()
    const limit = current?.contextLimit
    const pct = (value: number | undefined) => {
      if (!limit || value === undefined) return undefined
      return `(${Math.round((value / limit) * 1000) / 10}%)`
    }
    return [
      row("Prompt input", current?.rawInput, pct(current?.rawInput)),
      row("Cache read", current?.cacheRead, pct(current?.cacheRead)),
      row("Cache write", current?.cacheWrite, pct(current?.cacheWrite)),
      row("Output", current?.rawOutput, pct(current?.rawOutput)),
      row("Reasoning", current?.reasoning, pct(current?.reasoning)),
      row("Free", free(), pct(free())),
    ]
  })
  const inventoryRows = createMemo(() => contextInventoryRows({
    messages: props.messages.length,
    turns: turns(),
    textParts: textParts(),
    toolCalls: toolCalls(),
    reasoningParts: reasoningParts(),
    compactions: compactions(),
  }))
  const cellColor = (kind: ContextUsageGridKind) => {
    if (kind === "tool") return theme.warning
    if (kind === "cache") return theme.primary
    if (kind === "reasoning") return theme.success
    if (kind === "output") return theme.text
    if (kind === "free") return theme.textMuted
    return theme.primary
  }

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box flexDirection="row" gap={4}>
        <box flexGrow={1}>
          <text fg={theme.text}>{contextLabel(usage())}</text>
          <text fg={theme.textMuted}>{usage()?.model ?? latestAssistant()?.modelID ?? "No model usage yet"}</text>
        </box>
        <box gap={0} minWidth={28}>
          <For each={inventoryRows()}>
            {(item) => (
              <box flexDirection="row" justifyContent="space-between" gap={2}>
                <text fg={theme.textMuted}>{item.label}</text>
                <text fg={theme.text}>{item.value}</text>
              </box>
            )}
          </For>
        </box>
      </box>

      <box flexDirection="row" gap={3}>
        <box flexDirection="column" gap={0}>
          <For each={gridRows()}>
            {(row) => (
              <box flexDirection="row" gap={0}>
                <For each={row}>
                  {(cell) => <text fg={cellColor(cell.kind)}>{cell.symbol}</text>}
                </For>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="column" gap={0}>
          <For each={contextUsageGridLegend(gridLayout().compactLegend)}>
            {(item) => <text fg={cellColor(item.kind)} wrapMode="none">{item.symbol} {Locale.truncate(item.label, 30)}</text>}
          </For>
        </box>
      </box>

      <box gap={0} paddingTop={1}>
        <For each={rows()}>
          {(item) => (
            <box flexDirection="row" justifyContent="space-between" gap={2}>
              <text fg={theme.text}>{item.label}</text>
              <text fg={item.label === "Free" ? theme.textMuted : theme.text}>
                {item.value}
                <Show when={item.percent}>
                  {(value) => <span style={{ fg: theme.textMuted }}> {value()}</span>}
                </Show>
              </text>
            </box>
          )}
        </For>
      </box>

      <box paddingTop={1} gap={0}>
        <text fg={theme.textMuted}>{contextAutoCompactLabel({ usage: usage(), thresholdPercent: thresholdPercent() })}</text>
        <text fg={theme.textMuted}>Reserved/output window is already excluded from the usable context limit.</text>
      </box>

      <box paddingTop={1}>
        <text fg={theme.textMuted}>
          Per-tool token attribution is not persisted yet; detailed rows use assistant token totals available locally.
        </text>
        <Show when={total()}>
          {(value) => <text fg={theme.textMuted}>Session total: {value().contextLabel}</text>}
        </Show>
      </box>
    </box>
  )
}
