import { wrap } from "../wrap"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, blankRow, writeVisual, padVisual } from "./legacy-shared"

type GanttTask = {
  section: string
  label: string
  id?: string | undefined
  start?: number | undefined
  end?: number | undefined
  after?: string | undefined
  duration: number
  marker?: "milestone" | "crit" | "done" | "active" | undefined
}

const DAY_MS = 24 * 60 * 60 * 1000

function parseGanttDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const time = Date.UTC(Number(match[1]!), Number(match[2]!) - 1, Number(match[3]!))
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? undefined : Math.floor(time / DAY_MS)
}

function formatGanttDate(day: number) {
  const date = new Date(day * DAY_MS)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

function parseGanttDuration(value: string) {
  const match = /^(\d+)\s*d(?:ays?)?$/i.exec(value)
  return match ? Math.max(1, Number(match[1]!)) : undefined
}

export function renderGanttChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^gantt$/i.test(lines[0]! ?? "")) return undefined

  let title = "Gantt"
  let dateFormat = ""
  let section = "Tasks"
  const tasks: GanttTask[] = []

  for (const line of lines.slice(1)) {
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]!) || title
      continue
    }
    const dateFormatMatch = /^dateFormat\s+(.+)$/i.exec(line)
    if (dateFormatMatch) {
      dateFormat = cleanLabel(dateFormatMatch[1]!)
      continue
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(line)
    if (sectionMatch) {
      section = cleanLabel(sectionMatch[1]!) || section
      continue
    }
    if (/^(axisFormat|tickInterval|todayMarker|excludes|inclusiveEndDates)\b/i.test(line)) continue

    const task = /^(.+?)\s*:\s*(.+)$/.exec(line)
    if (!task) continue
    const parts = task[2]!
      .split(",")
      .map(cleanLabel)
      .filter(Boolean)
    let id: string | undefined
    let start: number | undefined
    let end: number | undefined
    let after: string | undefined
    let duration = 1
    let marker: GanttTask["marker"]

    for (const part of parts) {
      const lower = part.toLowerCase()
      if (/^(active|done|crit|milestone)$/.test(lower)) {
        marker = lower as GanttTask["marker"]
        continue
      }
      const parsedDate = parseGanttDate(part)
      if (/^\d{4}-\d{2}-\d{2}$/.test(part) && parsedDate === undefined) return undefined
      if (parsedDate !== undefined) {
        if (start === undefined) start = parsedDate
        else end = parsedDate
        continue
      }
      const parsedDuration = parseGanttDuration(part)
      if (parsedDuration !== undefined) {
        duration = parsedDuration
        continue
      }
      const afterMatch = /^after\s+(.+)$/i.exec(part)
      if (afterMatch) {
        after = cleanLabel(afterMatch[1]!).split(/\s+/)[0]!
        continue
      }
      if (!id) id = part.split(/\s+/)[0]!
    }

    tasks.push({ section, label: cleanLabel(task[1]!), id, start, end, after, duration, marker })
  }

  if (tasks.length === 0 || (dateFormat && dateFormat !== "YYYY-MM-DD")) return undefined

  const byID = new Map<string, GanttTask>()
  let cursor = tasks.find((task) => task.start !== undefined)?.start ?? Math.floor(Date.now() / DAY_MS)
  for (const task of tasks) {
    if (task.after && !byID.has(task.after)) return undefined
    if (task.after && byID.has(task.after)) {
      const dependency = byID.get(task.after)
      if (dependency?.end !== undefined) task.start = dependency.end + 1
    }
    if (task.start === undefined) task.start = cursor
    if (task.end === undefined) task.end = task.start + task.duration - 1
    if (task.end < task.start) return undefined
    task.duration = Math.max(1, task.end - task.start + 1)
    cursor = task.end + 1
    if (task.id) byID.set(task.id, task)
  }

  const resolved = tasks.filter((task): task is GanttTask & { start: number; end: number } => task.start !== undefined && task.end !== undefined)
  if (resolved.length === 0) return undefined

  const start = Math.min(...resolved.map((task) => task.start))
  const end = Math.max(...resolved.map((task) => task.end))
  const totalDays = Math.max(1, end - start + 1)
  const available = Math.max(40, Math.min(140, width - 18))
  const nameWidth = Math.min(24, Math.max(10, ...resolved.map((task) => Bun.stringWidth(task.label))))
  const timelineWidth = Math.max(24, available - nameWidth - 5)
  const scale = timelineWidth / totalDays
  const dateRow = blankRow(timelineWidth)
  const tickRow = blankRow(timelineWidth)
  const tickEvery = Math.max(1, Math.ceil(totalDays / 6))
  const tickDays = [0, totalDays - 1]
  for (let day = tickEvery; day < totalDays - 1; day += tickEvery) {
    const column = Math.min(timelineWidth - 1, Math.max(0, Math.round(day * scale)))
    if (tickDays.every((selected) => Math.abs(column - Math.round(selected * scale)) >= 7)) tickDays.push(day)
  }
  for (const day of tickDays.sort((left, right) => left - right)) {
    const column = Math.min(timelineWidth - 1, Math.max(0, Math.round(day * scale)))
    const label = formatGanttDate(start + day)
    writeVisual(dateRow, Math.max(0, Math.min(timelineWidth - Bun.stringWidth(label), column - Math.floor(Bun.stringWidth(label) / 2))), label)
    tickRow[column]! = "┬"
  }

  const output: string[] = [title]
  if (dateFormat) output.push(`Time scale · ${dateFormat}`)
  output.push(`${" ".repeat(nameWidth + 3)}${dateRow.join("").trimEnd()}`)
  output.push(`${" ".repeat(nameWidth + 2)}┌${tickRow.map((cell) => cell === "┬" ? "┬" : "─").join("")}▶`)

  let previousSection = ""
  for (const task of resolved.slice(0)) {
    if (task.section !== previousSection) {
      previousSection = task.section
      output.push(`── ${task.section} ${"─".repeat(Math.max(1, nameWidth + timelineWidth - Bun.stringWidth(task.section)))} `)
    }
    const barStart = Math.max(0, Math.floor((task.start - start) * scale))
    const barEnd = Math.min(timelineWidth - 1, Math.max(barStart, Math.ceil((task.end - start + 1) * scale) - 1))
    const bar = Array.from({ length: timelineWidth }, (_, index) => {
      if (task.marker === "milestone") return index === barStart ? "◆" : " "
      if (index < barStart || index > barEnd) return " "
      if (task.marker === "crit") return "▓"
      if (task.marker === "done") return "█"
      if (task.marker === "active") return "▒"
      return index === barStart ? "█" : "▓"
    }).join("")
    const labels = wrap(task.label, nameWidth)
    output.push(`${padVisual(labels[0]!, nameWidth)}  │${bar}│  ${formatGanttDate(task.start)}–${formatGanttDate(task.end)}`)
    for (const label of labels.slice(1)) output.push(`${padVisual(label, nameWidth)}  │${" ".repeat(timelineWidth)}│`)
  }
  return output.join("\n")
}
