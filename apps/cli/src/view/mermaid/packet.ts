// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, centerVisual } from "./legacy-shared"
import { wrap } from "../wrap"

export function renderPacketDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^packet(?:-beta)?$/i.test(lines[0]! ?? "")) return undefined

  const fields: Array<{ start: number; end: number; label: string }> = []
  for (const line of lines.slice(1)) {
    const field = /^(\+?[0-9]+(?:-[0-9]+)?)\s*:\s*"?([^"%]+)"?(?:\s+%%.*)?$/.exec(line)
    if (!field) continue
    const relative = field[1]!.startsWith("+")
    const range = field[1]!.replace(/^\+/, "").split("-").map(Number)
    const previousEnd = fields.at(-1)?.end ?? -1
    const start = relative ? previousEnd + 1 : range[0]! ?? previousEnd + 1
    const end = range.length > 1 ? range[1]! ?? start : relative ? start + (range[0]! ?? 1) - 1 : start
    if (end < start || end > 4095 || start <= previousEnd) return undefined
    fields.push({ start, end, label: cleanLabel(field[2]!) })
  }
  if (fields.length === 0) return undefined
  const output = ["Packet layout"]
  const groups = new Map<number, typeof fields>()
  for (const field of fields) {
    for (let start = field.start; start <= field.end;) {
      const word = Math.floor(start / 32)
      const end = Math.min(field.end, word * 32 + 31)
      groups.set(word, [...(groups.get(word) ?? []), { ...field, start, end }])
      start = end + 1
    }
  }
  for (const [word, wordFields] of groups) {
    if (output.length > 1) output.push("")
    output.push(`word ${word} · bits ${word * 32}–${word * 32 + 31}`)
    const available = Math.min(96, width) - wordFields.length - 1
    const minimum = wordFields.map((field) => Math.max(4, Bun.stringWidth(`${field.start}–${field.end}`)))
    const used = minimum.reduce((sum, value) => sum + value, 0)
    if (used > available) return undefined
    const widths = wordFields.map((field, i) => minimum[i]! + Math.floor((available - used) * (field.end - field.start + 1) / 32))
    const labels = wordFields.map((field, i) => wrap(field.label, widths[i]!))
    output.push(" " + wordFields.map((field, index) => centerVisual(`${field.start}–${field.end}`, widths[index]!)).join(" "))
    output.push(`┌${widths.map((fieldWidth) => "─".repeat(fieldWidth)).join("┬")}┐`)
    for (let row = 0; row < Math.max(...labels.map((label) => label.length)); row++) output.push(`│${labels.map((label, i) => centerVisual(label[row] ?? "", widths[i]!)).join("│")}│`)
    output.push(`└${widths.map((fieldWidth) => "─".repeat(fieldWidth)).join("┴")}┘`)
  }
  return output.join("\n")
}
