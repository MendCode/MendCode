// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { splitMermaidTopLevel, cleanLabel, renderCompactBox, padVisual, centerVisual } from "./legacy-shared"

export function renderSankeyDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^sankey(?:-beta)?$/i.test(lines[0]! ?? "")) return undefined

  const links: Array<{ from: string; to: string; value: number }> = []
  for (const line of lines.slice(1)) {
    const parts = splitMermaidTopLevel(line, ",").map(cleanLabel).filter(Boolean)
    const value = Number(parts[2]!)
    if (parts.length >= 3 && Number.isFinite(value)) links.push({ from: parts[0]!, to: parts[1]!, value })
  }
  if (links.length === 0) return undefined
  const maximum = Math.max(...links.map((link) => Math.abs(link.value)), 1)
  const output = ["Sankey · flow width = value"]
  for (const [index, link] of links.entries()) {
    if (index > 0) output.push("")
    const bandWidth = Math.max(6, Math.round(Math.abs(link.value) / maximum * Math.max(12, Math.min(36, width - 34))))
    const left = renderCompactBox(link.from, 12)
    const right = renderCompactBox(link.to, 12)
    const gap = Math.max(bandWidth + 3, Bun.stringWidth(String(link.value)) + 4)
    output.push(
      `${padVisual(left[0]!, Bun.stringWidth(left[0]!))}${centerVisual(String(link.value), gap)}${right[0]!}`,
      `${left[1]!}${centerVisual(`${"█".repeat(bandWidth)}▶`, gap)}${right[1]!}`,
      `${left[2]!}${" ".repeat(gap)}${right[2]!}`,
    )
  }
  return output.join("\n")
}
