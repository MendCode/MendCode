import type { TaskRecord } from "@mendcode/protocol"
import type { Line, Span } from "../ui/theme"
import { runSpans } from "./agents-strip"
import { panelGrid } from "./deck"
import { appearancePage } from "./appearance-layout"
import { compact } from "./format"
import { truncateEnd, wrap } from "./wrap"

/** `12.4K in · 1,204 out · $0.04`: what a child spent over all its runs; the cost only when every call had a price. */
export function taskUsage(stats: NonNullable<TaskRecord["stats"]>): string {
  return [`${compact(stats.input)} in`, `${compact(stats.output)} out`, ...(stats.costMicros ? [`$${(stats.costMicros / 1e6).toFixed(2)}`] : [])].join(" · ")
}

/**
 * What the opened child adds under its name, one fact a line, each only when known: what it ran on, what it spent, the files
 * it wrote (or the branch an isolated child left them on). The row in the list stays short; this is where the detail is, so the
 * `[worktree]` line the parent's model reads at the end of the result is not shown twice.
 */
export function taskFacts(task: TaskRecord, width: number): Line[] {
  const label = (text: string): Span => ({ text: `${text.padEnd(9)}`, fg: "muted" })
  const room = Math.max(4, width - 9)
  const files = task.worktree?.changed?.length ? task.worktree.changed : task.stats?.files ?? []
  const shownFiles = files.length ? `${files.length}${files.length >= 20 ? "+" : ""} file${files.length === 1 ? "" : "s"} · ${files.join(", ")}` : ""
  return [
    ...(task.run ? [[label("Model"), ...runSpans(task.run, () => task.run!.name ?? task.run!.model, "·")]] : []),
    ...(task.stats ? [[label("Usage"), { text: taskUsage(task.stats), fg: "body" as const }]] : []),
    ...(shownFiles ? [[label("Files"), { text: truncateEnd(shownFiles, room), fg: "body" as const }]] : []),
    ...(task.worktree ? [[label("Worktree"), { text: truncateEnd(task.worktree.path, room), fg: "body" as const }], ...(task.worktree.branch ? [[label("Branch"), { text: truncateEnd(`${task.worktree.branch}${task.worktree.commit ? ` @ ${task.worktree.commit}` : ""} · not merged`, room), fg: "body" as const }]] : [])] : []),
  ]
}

export function renderTasksPage(input: { tasks: TaskRecord[]; selected: number; width: number; height: number; scroll?: number; error?: string }): Line[] {
  const { tasks, selected, width, height } = input
  const hints = width < 70 ? "↑↓ · enter · x · b · w · r · esc" : width < 110 ? "↑↓ · enter · x cancel · b detach · w wait · pgup/dn · r · esc" : "↑↓ select · enter chat · x cancel · b detach · w wait · pgup/dn result · r refresh · esc back"
  const room = Math.max(0, height - 2)
  const task = tasks[Math.min(selected, Math.max(0, tasks.length - 1))]
  const row = (text: string): Line => [{ text, fg: "text" }]
  const list: Line[] = tasks.length ? tasks.map((task, index) => [{ text: `${index === selected ? "›" : " "} ${task.state} · ${task.description}`, fg: index === selected ? "primary" as const : "text" as const }]) : [[{ text: input.error || "No child sessions", fg: input.error ? "error" : "muted" }]]
  const detail = (w: number): Line[] => task ? [...(width < 70 ? [] : [row(task.taskId), row(`Parent ${task.parentId}`)]), row(`${task.agent} · run ${task.generation} · ${task.background ? "background" : "foreground"}`), ...taskFacts(task, w), ...(input.error ? [[{ text: input.error, fg: "error" as const }]] : []), ...(width < 70 ? [] : [[]]), ...wrap(task.worktree ? task.result.replace(/\n\n\[worktree\] [^\n]*$/, "") : task.result, w).map(row)] : []
  const panelHeight = width < 110 ? Math.max(4, Math.floor((room - 1) / 2)) : room
  const active = tasks.filter((task) => ["queued", "running", "needs_input"].includes(task.state)).length
  return appearancePage({ title: "Tasks", subtitle: `${tasks.length} children · ${active} active`, hints, width, height, body: panelGrid({ width: Math.max(1, width - 4), heights: [panelHeight, Math.max(4, room - panelHeight - 1)], padding: true, maxColumns: width < 110 ? 1 : 2, compact: false, rows: [[{ title: "Child sessions", body: list, scroll: Math.max(0, selected - panelHeight + 5) }, { title: task?.description ?? "Result", body: detail, scroll: input.scroll ?? 0 }]] }) })
}
