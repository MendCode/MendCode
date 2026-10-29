import type { Line } from "../ui/theme"
import { fit, spread } from "./deck"
import { textWidth } from "./wrap"

/** Full-width appearance pages: hints stay in the header, body owns its scrolling. */
export function appearancePage(input: { title: string; hints: string; body: Line[]; width: number; height: number; subtitle?: string }): Line[] {
  const inner = Math.max(0, input.width - 4)
  const title: Line = [{ text: input.title, fg: "primary", bold: true }]
  const hint: Line = [{ text: input.hints, fg: "muted" }]
  const header = spread(title, textWidth(input.hints) + input.title.length + 2 <= inner ? hint : [{ text: "esc back", fg: "muted" }], inner)
  const rows: Line[] = [header, input.subtitle ? [{ text: input.subtitle, fg: "muted" }] : [], ...input.body]
  return Array.from({ length: Math.max(0, input.height) }, (_, y) => [{ text: "  " }, ...fit(rows[y] ?? [], inner), { text: "  " }])
}

export function focusedWindow(rows: Line[], focus: number, height: number): Line[] {
  const start = Math.max(0, Math.min(focus - height + 2, rows.length - height))
  return rows.slice(start, start + Math.max(0, height))
}
