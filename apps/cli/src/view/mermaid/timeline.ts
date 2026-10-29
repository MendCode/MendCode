// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { assertCanvas } from "./core"
import { preparedMermaidSourceLines, cleanMermaidLabel, splitMermaidTopLevel, renderCompactBox, blankRow, renderBox, writeVisual } from "./legacy-shared"

export function renderTimelineDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  const head = /^(timeline)(?:\s+(LR|TD))?$/i.exec(lines[0]!?.trim() ?? "")
  if (!head) return undefined

  let title = "Timeline"
  let section = "Timeline"
  let period = ""
  const events: Array<{ section: string; period: string; event: string }> = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]!) || title
      continue
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(line)
    if (sectionMatch) {
      section = cleanMermaidLabel(sectionMatch[1]!) || section
      period = ""
      continue
    }
    const parts = splitMermaidTopLevel(line, ":").map(cleanMermaidLabel)
    if (parts.length < 2) continue
    if (parts[0]!) period = parts.shift() ?? period
    for (const event of parts.filter(Boolean)) events.push({ section, period, event })
  }
  if (events.length === 0) return undefined
  const boxes = events.map((event) => renderCompactBox(`${event.event} · ${event.section}`, 16))
  const boxWidth = Math.max(...boxes.flatMap((box) => box.map((line) => Bun.stringWidth(line))), 16)
  if (head[2]!?.toUpperCase() === "TD") {
    const gap = 8
    const axisColumn = boxWidth + gap
    const canvasWidth = boxWidth * 2 + gap * 2 + 1
    const canvasHeight = events.length * 5
    assertCanvas(canvasWidth, canvasHeight)
    const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
    for (let row = 0; row < canvasHeight; row++) canvas[row]![axisColumn]! = "│"
    events.forEach((event, index) => {
      const box = boxes[index]! ?? renderBox(event.event)
      const leftSide = index % 2 === 0
      const top = index * 5
      const left = leftSide ? 0 : axisColumn + gap
      box.forEach((line, offset) => writeVisual(canvas[top + offset]!, left, line))
      const pointRow = top + 1
      canvas[pointRow]![axisColumn]! = "●"
      if (leftSide) {
        for (let column = Bun.stringWidth(box[1]! ?? ""); column < axisColumn; column++) canvas[pointRow]![column]! = "─"
        writeVisual(canvas[pointRow - 1]!, Math.max(0, axisColumn - Bun.stringWidth(event.period)), event.period)
      } else {
        for (let column = axisColumn + 1; column < left; column++) canvas[pointRow]![column]! = "─"
        writeVisual(canvas[pointRow - 1]!, axisColumn + 2, event.period)
      }
    })
    canvas[canvasHeight - 1]![axisColumn]! = "▼"
    return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
  }
  const stride = boxWidth + 6
  const canvasWidth = events.length * stride
  const axisRow = 5
  const rowCount = 11
  assertCanvas(canvasWidth, rowCount)
  const canvas = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  for (let column = Math.floor(boxWidth / 2); column < canvasWidth; column++) canvas[axisRow]![column]! = "─"
  events.forEach((event, index) => {
    const box = boxes[index]! ?? renderBox(event.event)
    const left = index * stride
    const above = index % 2 === 0
    const top = above ? 0 : 7
    box.forEach((line, offset) => writeVisual(canvas[top + offset]!, left, line))
    const center = left + Math.floor(Bun.stringWidth(box[0]! ?? "") / 2)
    if (above) {
      for (let row = 3; row < axisRow; row++) canvas[row]![center]! = "│"
      canvas[axisRow]![center]! = "●"
      writeVisual(canvas[axisRow + 1]!, Math.max(0, center - Math.floor(Bun.stringWidth(event.period) / 2)), event.period)
    } else {
      canvas[axisRow]![center]! = "●"
      for (let row = axisRow + 1; row < top; row++) canvas[row]![center]! = "│"
      writeVisual(canvas[axisRow - 1]!, Math.max(0, center - Math.floor(Bun.stringWidth(event.period) / 2)), event.period)
    }
  })
  canvas[axisRow]![canvasWidth - 1]! = "▶"
  return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}
