import type { Line } from "../ui/theme"
import { fit, spread } from "./deck"

export const pluginChrome = 5

/** Plugin pages use the same cell grid with their actionable hints in the header. */
export function pluginFrame(input: { title: string; hints: string; body: Line[]; width: number; height: number; scroll?: number }): Line[] {
  const inner = Math.max(1, input.width - 2)
  const header = spread([{ text: input.title, fg: "accent", bold: true }], [{ text: input.hints, fg: "muted" }], inner)
  const room = Math.max(0, input.height - pluginChrome)
  const start = Math.max(0, Math.min(input.scroll ?? 0, Math.max(0, input.body.length - room)))
  const rows: Line[] = [[], header, [{ text: "─".repeat(inner), fg: "border" }], [], ...input.body.slice(start, start + room)]
  while (rows.length < input.height - 1) rows.push([])
  rows.push([{ text: "esc back", fg: "muted" }])
  return Array.from({ length: input.height }, (_, row) => fit([{ text: " " }, ...fit(rows[row] ?? [], inner)], input.width))
}
