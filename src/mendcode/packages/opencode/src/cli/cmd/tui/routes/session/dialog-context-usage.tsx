import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { AssistantMessage, Message, Part, Provider } from "@mendcode/sdk/v2"
import { createMemo, For, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import {
  formatAssistantLiveUsage,
  formatAssistantUsageTotal,
  formatLatestAssistantContextUsage,
  type AssistantUsageSummary,
} from "../../util/usage"

type ProviderIndex = Provider[] | ReadonlyMap<string, Provider>

type ContextUsageDialogProps = {
  messages: Message[]
  partsByMessageID: Record<string, Part[] | undefined>
  providers?: ProviderIndex
  mainAgentNames?: Set<string>
}

const AUTO_COMPACT_RATIO = 0.85
const BAR_CELLS = 32

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

function autoCompactLabel(usage: AssistantUsageSummary | undefined) {
  if (!usage?.contextLimit) return "Auto-compact threshold unavailable"
  const threshold = Math.floor(usage.contextLimit * AUTO_COMPACT_RATIO)
  const remaining = Math.max(0, threshold - usage.context)
  return `Auto-compact at 85% · ~${Locale.number(remaining)} tokens remaining`
}

function usageCells(usage: AssistantUsageSummary | undefined) {
  const ratio = usage?.contextLimit ? Math.max(0, Math.min(1, usage.context / usage.contextLimit)) : 0
  const used = Math.max(usage && usage.context > 0 ? 1 : 0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)))
  return Array.from({ length: BAR_CELLS }, (_, index) => index < used)
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
  const usage = createMemo(() => {
    const latest = latestAssistant()
    const live = latest && !latest.time.completed ? formatAssistantLiveUsage(latest, props.providers) : undefined
    if (live) return live
    const main = formatLatestAssistantContextUsage(assistantMessages(), props.providers, {
      include: (message) => props.mainAgentNames?.has(message.agent) ?? true,
    })
    return main ?? formatLatestAssistantContextUsage(assistantMessages(), props.providers)
  })
  const total = createMemo(() => formatAssistantUsageTotal(assistantMessages(), props.providers))
  const allParts = createMemo(() => props.messages.flatMap((message) => props.partsByMessageID[message.id] ?? []))
  const toolCalls = createMemo(() => allParts().filter((part) => part.type === "tool").length)
  const compactions = createMemo(() => allParts().filter((part) => part.type === "compaction").length)
  const turns = createMemo(() => props.messages.filter((message) => message.role === "user").length)
  const cells = createMemo(() => usageCells(usage()))
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

      <box>
        <text fg={theme.text}>{contextLabel(usage())}</text>
        <text fg={theme.textMuted}>{usage()?.model ?? latestAssistant()?.modelID ?? "No model usage yet"}</text>
      </box>

      <box gap={0}>
        <For each={[0, 1, 2, 3]}>
          {(rowIndex) => (
            <box flexDirection="row" gap={1}>
              <For each={cells().slice(rowIndex * 8, rowIndex * 8 + 8)}>
                {(used) => <text fg={used ? theme.primary : theme.textMuted}>{used ? "◆" : "◇"}</text>}
              </For>
            </box>
          )}
        </For>
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

      <box paddingTop={1}>
        <text fg={theme.textMuted}>{autoCompactLabel(usage())}</text>
        <text fg={theme.textMuted}>
          Turns: {Locale.number(turns())} · Tool calls: {Locale.number(toolCalls())} · Compactions:{" "}
          {Locale.number(compactions())}
        </text>
        <Show when={total()}>
          {(value) => <text fg={theme.textMuted}>Session total: {value().contextLabel}</text>}
        </Show>
      </box>
    </box>
  )
}
