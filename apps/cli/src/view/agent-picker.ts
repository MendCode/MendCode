import type { AgentInfo, AgentsReport } from "@mendcode/protocol"
import type { Glyphs, Line } from "../ui/theme"
import { agentColor } from "./agent-color"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"

export type AgentPickerState = { selected: number }
export type AgentPickerAction = { type: "none" } | { type: "close" } | { type: "choose"; name: string }

const HINTS = "↑↓ select · enter choose · esc back"
const choices = (report: AgentsReport | undefined): AgentInfo[] => report?.agents.filter((agent) => agent.trusted && !agent.disable && !agent.hidden && agent.mode !== "subagent") ?? []

export function createAgentPickerState(report?: AgentsReport): AgentPickerState {
  return { selected: Math.max(0, choices(report).findIndex((agent) => agent.name === report?.current)) }
}

/** Same bounded list navigation as the pet picker; only primary agents can be chosen. */
export function agentPickerKey(state: AgentPickerState, key: string, report: AgentsReport | undefined): { state: AgentPickerState; action: AgentPickerAction } {
  const rows = choices(report)
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  const move = (by: number) => ({ state: { selected: Math.max(0, Math.min(state.selected + by, rows.length - 1)) }, action: { type: "none" } as const })
  if (["\x1b[A", "\x1bOA", "\x10", "k"].includes(key)) return move(-1)
  if (key === "\x1b[Z" && rows.length) return { state: { selected: (state.selected + 1) % rows.length }, action: { type: "none" } }
  if (["\x1b[B", "\x1bOB", "\x0e", "j"].includes(key)) return move(1)
  const selected = rows[state.selected]
  return { state, action: key === "\r" && selected ? { type: "choose", name: selected.name } : { type: "none" } }
}

export function renderAgentPicker(input: { report: AgentsReport | undefined; error: string; state: AgentPickerState; width: number; height: number; glyphs: Glyphs }): Line[] {
  const { report, error, state, width, height, glyphs } = input
  const rows = choices(report)
  const inner = Math.max(1, width - 2)
  const room = Math.max(1, height - 6)
  const first = Math.max(0, state.selected - room + 1)
  const body: Line[] = error ? [[{ text: error, fg: "error" }]] : !report ? [[{ text: "loading agents…", fg: "muted" }]] : !rows.length ? [[{ text: "no primary agents", fg: "muted" }]] : rows.slice(first, first + room).map((agent, index): Line => {
    const selected = first + index === state.selected
    return clip([
      { text: selected ? `${glyphs.user} ` : "  ", fg: "primary" },
      { text: agent.name, ...agentColor(agent), bold: selected },
      ...(agent.name === report.current ? [{ text: " (current)", fg: "success" as const }] : []),
      { text: `  ${agent.description.replace(/\s+/g, " ")}`, fg: "muted" },
    ], inner)
  })
  return pickerFrame("Agent", HINTS, width, height, panelGrid({ width, compact: width < 70, maxColumns: width < 70 ? 1 : 2, padding: true, heights: [height - 2], rows: [[{ title: "Primary agents", body }]] }))
}
