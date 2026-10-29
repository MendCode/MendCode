// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel, mermaidIndentWidth, renderBox, blankRow, writeVisual } from "./legacy-shared"

type VennDefinition = { kind: "set" | "union" | "text"; members: string[]; label: string; size?: string | undefined; depth: number }

export function renderVennDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^venn-beta$/i.test(lines[0]!?.trim() ?? "")) return undefined
  let title = "Venn"
  const definitions: VennDefinition[] = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]!) || title
      continue
    }
    const declaration = /^(set|union|text)\s+(.+)$/i.exec(line)
    if (!declaration) {
      if (/^(?:style|classDef)\b/i.test(line)) continue
      continue
    }
    const kind = declaration[1]!.toLowerCase() as VennDefinition["kind"]
    let rest = declaration[2]!.trim()
    const sizeMatch = /:\s*([0-9.]+)\s*$/.exec(rest)
    const size = sizeMatch?.[1]!
    if (sizeMatch) rest = rest.slice(0, sizeMatch.index).trim()
    const labelMatch = /\[\s*\"?([^\]]+)\"?\s*\]/.exec(rest)
    const label = cleanMermaidLabel((labelMatch?.[1]! || rest).replace(/^['"]|['"]$/g, ""))
    const memberSource = labelMatch ? rest.slice(0, labelMatch.index).trim() : rest
    const members = kind === "union" ? memberSource.split(",").map((member) => cleanMermaidLabel(member.replace(/^['"]|['"]$/g, ""))).filter(Boolean) : [cleanMermaidLabel(memberSource.replace(/^['"]|['"]$/g, ""))]
    const definition = { kind, members, label, size, depth: mermaidIndentWidth(raw) }
    definitions.push(definition)
  }
  if (definitions.length === 0) return undefined
  const sets = definitions.filter((definition) => definition.kind === "set")
  const unions = definitions.filter((definition) => definition.kind === "union")
  if (sets.length < 2) return [title, ...sets.flatMap((set) => renderBox(`${set.label}${set.size ? ` · ${set.size}` : ""}`))].join("\n")
  const canvasWidth = 62
  const canvasHeight = 19
  const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
  const circles = [
    { x: 23, y: 9, rx: 18, ry: 8 },
    { x: 39, y: 9, rx: 18, ry: 8 },
  ]
  circles.forEach((circle) => {
    for (let row = 0; row < canvasHeight; row++) {
      for (let column = 0; column < canvasWidth; column++) {
        const distance = ((column - circle.x) / circle.rx) ** 2 + ((row - circle.y) / circle.ry) ** 2
        if (Math.abs(distance - 1) < 0.12) canvas[row]![column]! = "·"
      }
    }
  })
  const left = sets[0]!
  const right = sets[1]!
  writeVisual(canvas[8]!, 8, `${left.label}${left.size ? ` (${left.size})` : ""}`)
  writeVisual(canvas[8]!, Math.max(42, canvasWidth - Bun.stringWidth(right.label) - 8), `${right.label}${right.size ? ` (${right.size})` : ""}`)
  const overlap = unions[0]!
  if (overlap) writeVisual(canvas[10]!, Math.max(22, 31 - Math.floor(Bun.stringWidth(overlap.label) / 2)), `${overlap.label}${overlap.size ? ` (${overlap.size})` : ""}`)
  const textNodes = definitions.filter((definition) => definition.kind === "text")
  textNodes.slice(0, 4).forEach((node, index) => writeVisual(canvas[12 + index]!, 10 + index * 3, `• ${node.label}`))
  return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}
