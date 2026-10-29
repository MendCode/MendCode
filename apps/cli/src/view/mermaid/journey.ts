// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel, centerVisual, padVisual } from "./legacy-shared"

export function renderJourneyDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^journey$/i.test(lines[0]!?.trim() ?? "")) return undefined
  let title = "Journey"
  let section = "Journey"
  const tasks: Array<{ section: string; label: string; score: number; actors: string }> = []
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
      continue
    }
    const task = /^(.+?)\s*:\s*([1-5])(?:\s*:\s*(.+))?$/.exec(line)
    if (task) tasks.push({
      section,
      label: cleanMermaidLabel(task[1]!),
      score: Number(task[2]!),
      actors: cleanMermaidLabel(task[3]!) || "—",
    })
  }
  if (tasks.length === 0) return undefined

  const output: string[] = [title]
  const grouped = new Map<string, typeof tasks>()
  for (const task of tasks) grouped.set(task.section, [...(grouped.get(task.section) ?? []), task])
  for (const [sectionName, sectionTasks] of grouped) {
    if (output.length > 1) output.push("")
    const cellWidth = Math.max(
      16,
      ...sectionTasks.map((task) => Bun.stringWidth(task.label) + 4),
      ...sectionTasks.map((task) => Bun.stringWidth(task.actors) + 6),
    )
    const availableWidth = Math.max(40, Math.floor(width) - 12)
    const perRow = Math.max(1, Math.min(5, Math.floor(availableWidth / (cellWidth + 5))))
    for (let start = 0; start < sectionTasks.length; start += perRow) {
      const rowTasks = sectionTasks.slice(start, start + perRow)
      const sectionWidth = rowTasks.length * cellWidth + Math.max(0, rowTasks.length - 1) * 5
      output.push(`╭─ ${sectionName} ${"─".repeat(Math.max(1, sectionWidth - Bun.stringWidth(sectionName) - 3))}╮`)
      const taskBoxes = rowTasks.map((task) => {
        const innerWidth = cellWidth - 2
        const stars = `${"★".repeat(task.score)}${"☆".repeat(5 - task.score)}  ${task.score}/5`
        return [
          `╭${"─".repeat(innerWidth)}╮`,
          `│${centerVisual(task.label, innerWidth)}│`,
          `│${centerVisual(stars, innerWidth)}│`,
          `│${centerVisual(`● ${task.actors}`, innerWidth)}│`,
          `╰${"─".repeat(innerWidth)}╯`,
        ]
      })
      for (let row = 0; row < 5; row++) {
        const content = taskBoxes.map((box, index) => `${box[row]! ?? ""}${index < taskBoxes.length - 1 ? row === 2 ? "───▶ " : "     " : ""}`).join("")
        output.push(`│${padVisual(content, sectionWidth)}│`)
      }
      output.push(`╰${"─".repeat(sectionWidth)}╯`)
    }
  }
  return output.join("\n")
}
