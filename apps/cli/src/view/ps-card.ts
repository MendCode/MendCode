import type { InfoCard } from "./rewind-card"
import { backgroundName } from "./background-row"
import { formatDuration } from "./exit-summary"

/** The `/ps` card: what runs in the background of the open session, one row selected. */
export type PsCardState = { selected: number }

export type PsItem = { id: string; command: string; kind?: "agent" | "command" | undefined; startedAt: number }

export type PsKeyResult = { state: PsCardState | undefined; stop?: { taskId?: string } }

const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const CLOSE = new Set(["\x1b", "q"])

/** The card's rows: each item with its kind and run time, the selected one marked. */
export function psCard(input: { state: PsCardState; items: readonly PsItem[]; now: number }): InfoCard {
  const { items } = input
  if (!items.length) return { title: "Background", body: [{ text: "Nothing runs in the background of this session.", fg: "muted" }], hint: "esc close" }
  const selected = Math.min(input.state.selected, items.length - 1)
  return {
    title: `Background · ${items.length} running`,
    body: items.map((item, index) => ({
      label: index === selected ? "›" : "",
      text: `${backgroundName(item.command, 60)} · ${item.kind ?? "command"} · ${formatDuration(Math.max(0, input.now - item.startedAt))}`,
      fg: index === selected ? "accent" as const : "text" as const,
    })),
    hint: items.length > 1 ? "↑↓ select · x stop · a stop all · esc close" : "x stop · esc close",
  }
}

/** One key on the open card: arrows move, `x` stops the selected item, `a` stops all, Esc or `q` closes; other keys are the card's too. */
export function psKey(state: PsCardState, key: string, items: readonly PsItem[]): PsKeyResult {
  if (CLOSE.has(key)) return { state: undefined }
  if (!items.length) return { state: undefined }
  const selected = Math.min(state.selected, items.length - 1)
  if (UP.has(key)) return { state: { selected: Math.max(0, selected - 1) } }
  if (DOWN.has(key)) return { state: { selected: Math.min(items.length - 1, selected + 1) } }
  if (key === "x") return { state: { selected }, stop: { taskId: items[selected]!.id } }
  if (key === "a") return { state: { selected: 0 }, stop: {} }
  return { state: { selected } }
}
