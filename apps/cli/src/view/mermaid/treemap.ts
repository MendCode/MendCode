// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { parseMermaidIndentedEntries, cleanMermaidLabel, renderBoxedHierarchy, centerVisual } from "./legacy-shared"

export function renderTreemapDiagram(input: string): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^treemap-beta$/i)
  if (!entries) return undefined
  const root = entries.find((entry) => entry.depth === 0)?.label ?? "Treemap"
  const leaves = entries.slice(0).flatMap((entry) => {
    const value = /^\s*\"?(.+?)\"?\s*:\s*([0-9.]+)\s*$/.exec(entry.raw)
    return value ? [{ label: cleanMermaidLabel(value[1]!), value: Number(value[2]!) }] : []
  })
  if (leaves.length === 0) return renderBoxedHierarchy("Treemap", entries)
  const total = leaves.reduce((sum, leaf) => sum + leaf.value, 0) || 1
  if (leaves.some((leaf) => !Number.isFinite(leaf.value) || leaf.value < 0)) return undefined
  const innerWidth = Math.max(54, ...leaves.map((leaf) => Bun.stringWidth(leaf.label) + 4))
  const widths = leaves.map((leaf) => Math.max(Bun.stringWidth(leaf.label) + 2, Math.round(leaf.value / total * innerWidth)))
  const currentWidth = widths.reduce((sum, value) => sum + value, 0)
  if (currentWidth < innerWidth) widths[widths.length - 1]! = (widths.at(-1) ?? 0) + innerWidth - currentWidth
  const contentWidth = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, leaves.length - 1)
  return [
    "Treemap",
    `╭─ ${root} ${"─".repeat(Math.max(1, contentWidth - Bun.stringWidth(root) - 1))}╮`,
    `│┌${widths.map((value) => "─".repeat(value)).join("┬")}┐│`,
    `││${leaves.map((leaf, index) => centerVisual(leaf.label, widths[index]! ?? 1)).join("│")}││`,
    `││${leaves.map((leaf, index) => centerVisual(String(leaf.value), widths[index]! ?? 1)).join("│")}││`,
    `│└${widths.map((value) => "─".repeat(value)).join("┴")}┘│`,
    `╰${"─".repeat(contentWidth + 2)}╯`,
  ].join("\n")
}
