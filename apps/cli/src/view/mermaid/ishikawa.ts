// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, parseMermaidIndentedEntries, renderCompactBox, blankRow, writeVisual } from "./legacy-shared"

export function renderIshikawaDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^ishikawa-beta$/i.test(lines[0]!?.trim() ?? "")) return undefined
  const entries = parseMermaidIndentedEntries(input, /^ishikawa-beta$/i)
  if (!entries || entries.length === 0) return undefined
  const effect = entries[0]!.label
  const groups: Array<{ label: string; children: string[] }> = []
  for (const entry of entries.slice(1)) {
    if (entry.depth === 1) groups.push({ label: entry.label, children: [] })
    else if (groups.length > 0) groups.at(-1)?.children.push(entry.label)
  }
  if (groups.length === 0) return undefined
  const effectBox = renderCompactBox(effect, 16)
  const effectWidth = Math.max(...effectBox.map((line) => Bun.stringWidth(line)))
  const spineRow = 9
  const spineStart = 2
  const spineEnd = Math.max(62, groups.length * 16)
  const canvasWidth = spineEnd + effectWidth + 3
  const canvasHeight = 19
  const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
  for (let column = spineStart; column < spineEnd; column++) canvas[spineRow]![column]! = "═"
  canvas[spineRow]![spineEnd - 1]! = "▶"
  effectBox.forEach((line, row) => writeVisual(canvas[spineRow - 1 + row]!, spineEnd + 1, line))
  groups.forEach((group, index) => {
    const x = Math.min(spineEnd - 6, 10 + index * Math.max(10, Math.floor((spineEnd - 18) / Math.max(1, groups.length - 1))))
    const above = index % 2 === 0
    const endpointX = Math.max(1, x - 6)
    const endpointY = above ? 2 : 16
    const steps = Math.abs(spineRow - endpointY)
    for (let step = 0; step <= steps; step++) {
      const row = Math.round(spineRow + (endpointY - spineRow) * step / steps)
      const column = Math.round(x + (endpointX - x) * step / steps)
      canvas[row]![column]! = above ? "╱" : "╲"
    }
    const labelRow = above ? 0 : 17
    writeVisual(canvas[labelRow]!, Math.max(0, endpointX - Math.floor(Bun.stringWidth(group.label) / 2)), group.label)
    group.children.slice(0, 3).forEach((child, childIndex) => {
      const row = above ? 3 + childIndex : 15 - childIndex
      writeVisual(canvas[row]!, Math.max(0, endpointX + 2), `• ${child}`)
    })
  })
  return ["Ishikawa · causes feed the effect", ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}
