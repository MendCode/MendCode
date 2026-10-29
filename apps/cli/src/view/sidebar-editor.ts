import type { SidebarWidget } from "@mendcode/protocol"
import { boxPanel, fit, spread } from "./deck"
import { wrap } from "./wrap"
import type { Line } from "../ui/theme"
import { WIDGET_TYPES } from "./sidebar-spec"

export function renderSidebarEditor(widgets: SidebarWidget[], state: { selected: number; adding: boolean; type: number; draft?: string | undefined }, width: number, height: number): Line[] {
  const hints = state.draft !== undefined ? "Enter save · Esc cancel" : state.adding ? "←→ type · Enter add · Esc cancel" : width < 80 ? "a add d del J/K move e edit Esc" : "a add · d remove · J/K move · e edit · Esc back"
  const rows: Line[] = [spread([{ text: "Session panel", fg: "primary" }], [{ text: hints, fg: "muted" }], width), []]
  const body: Line[] = []
  if (state.draft !== undefined) body.push(...wrap(state.draft + "▏", width - 8).map((text): Line => [{ text, fg: "text" }]))
  else if (state.adding) body.push([{ text: `Add: ${[...WIDGET_TYPES, "extension"][state.type]}`, fg: "primary" }])
  else if (!widgets.length) body.push([{ text: "Ask the agent to build it, or press a to add a widget", fg: "muted" }])
  else {
    const capacity = Math.max(1, height - 10)
    const start = Math.max(0, state.selected - capacity + 1)
    for (let i = start; i < Math.min(widgets.length, start + capacity); i++) body.push([{ text: `${i === state.selected ? "›" : " "} ${i + 1}. ${widgets[i]!.title ?? widgets[i]!.type}`, fg: i === state.selected ? "primary" : "text" }])
  }
  rows.push(...boxPanel({ title: state.draft !== undefined ? "Widget JSON" : "Widgets", body, width, height: height - 2 }))
  return rows.slice(0, height).map((line) => fit(line, width))
}
