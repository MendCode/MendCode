import type { ColorName, Line } from "../ui/theme"
import { beside, clip, fit, boxPanel } from "./deck"
import { formatElapsed } from "./time"
import { textWidth } from "./wrap"
import { editorRows } from "./editor"

/**
 * v1's session widgets dock (`ctrl+t`, util/session-bottom-dock.ts, routes/session/index.tsx:5402-5880): a row of
 * bordered panels above the prompt. Todos (from the latest `todo` tool result), Subagents (when any), and Info; MendCode adds
 * Questions (pending approvals and questions), Jobs (background shell tasks) and a per-project Scratchpad.
 */
export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled"
export type TodoItem = { text: string; status: TodoStatus; priority?: "high" | "medium" | "low" }
export type DockSubagent = { label: string; status: string; tone: ColorName }
export type DockInfo = { branch?: string; cwd: string; context?: string; permission: string; model?: string; activity: string }

export const DOCK_HEIGHT = 10
/** Rows under a panel's header: the height minus the header and the bottom padding. */
export const DOCK_BODY_ROWS = DOCK_HEIGHT - 5
const BODY_ROWS = DOCK_BODY_ROWS
const TODO_MARK: Record<TodoStatus, { glyph: string; fg: ColorName }> = {
  done: { glyph: "✓", fg: "muted" },
  in_progress: { glyph: "▸", fg: "warning" },
  cancelled: { glyph: "×", fg: "error" },
  pending: { glyph: "□", fg: "text" },
}

/** The `todo` tool's checklist text (`[x] done`, `[~] in progress`, `[ ] pending`, `[-] cancelled`) as items. */
export function parseTodoText(text: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*\[([ xX~-])\]\s+(.*)$/.exec(line)
    if (!match) continue
    const mark = match[1]!.toLowerCase()
    const priority = /^\((high|medium|low)\) (.*)$/.exec(match[2]!)
    items.push({ text: (priority?.[2] ?? match[2]!).trim(), status: mark === "x" ? "done" : mark === "~" ? "in_progress" : mark === "-" ? "cancelled" : "pending", ...(priority ? { priority: priority[1] as NonNullable<TodoItem["priority"]> } : {}) })
  }
  return items
}

const header = (title: string, right: string, width: number): Line => {
  const room = Math.max(0, width - textWidth(title) - textWidth(right))
  return [{ text: title, fg: "heading", bold: true }, { text: " ".repeat(room) }, { text: right, fg: "muted" }]
}

/** Rows that fit, with `+N more` replacing the last row when they do not. */
function bounded(rows: Line[], room: number): Line[] {
  if (rows.length <= room) return rows
  const kept = rows.slice(0, Math.max(0, room - 1))
  return [...kept, [{ text: `+${rows.length - kept.length} more`, fg: "muted" }]]
}

function todosBody(todos: readonly TodoItem[], width: number): Line[] {
  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
  const rows = todos.length
    ? todos.map((todo): Line => {
        const mark = TODO_MARK[todo.status]
        return clip([{ text: `${mark.glyph} `, fg: mark.fg }, ...(todo.priority ? [{ text: `${todo.priority} · `, fg: todo.priority === "high" ? "warning" as const : "muted" as const }] : []), { text: todo.text, fg: todo.status === "done" ? "muted" : mark.fg === "text" ? "text" : mark.fg }], width)
      })
    : [[{ text: "□ No todo items.", fg: "muted" }] satisfies Line]
  return [header("Todos", `${open} open`, width), ...bounded(rows, BODY_ROWS)]
}

function subagentsBody(subagents: readonly DockSubagent[], width: number): Line[] {
  const rows = subagents.map((agent): Line => {
    const status = agent.status
    const room = Math.max(1, width - 2 - textWidth(status) - 2)
    return [{ text: "• ", fg: agent.tone }, ...fit([{ text: agent.label, fg: "text" }], room), { text: "  " }, { text: status, fg: agent.tone }]
  })
  return [header("Subagents", String(subagents.length), width), ...bounded(rows, BODY_ROWS)]
}

function infoBody(info: DockInfo, width: number): Line[] {
  const pairs: Array<[string, string | undefined]> = [
    ["git", info.branch],
    ["cwd", info.cwd],
    ["ctx", info.context],
    ["perm", info.permission],
    ["model", info.model],
  ]
  const rows = pairs.filter((pair): pair is [string, string] => Boolean(pair[1])).map(([key, value]): Line => clip([{ text: key.padEnd(6), fg: "muted" }, { text: value, fg: "text" }], width))
  return [header("Info", info.activity, width), ...bounded(rows, BODY_ROWS)]
}

export type DockQuestion = { kind: "approval" | "question"; title: string }
export type DockJob = { command: string; status: "running" | "exited" | "killed" | "queued" | "completed" | "failed" | "cancelled" | "interrupted"; exitCode?: number; startedAt: number; endedAt?: number }
/** The project note and its own editor while the tray has focus. */
export type DockScratch = { lines: readonly string[]; editing: boolean; editor?: ReturnType<typeof import("./editor").createEditor> }

export type DockPanelKind = "todos" | "questions" | "subagents" | "jobs" | "scratch" | "info"

/** Narrowest useful width of each panel. */
const PANEL_MIN: Record<DockPanelKind, number> = { todos: 24, questions: 28, subagents: 32, jobs: 28, scratch: 28, info: 24 }
/** Left to right. */
const PANEL_ORDER: readonly DockPanelKind[] = ["todos", "questions", "subagents", "jobs", "scratch", "info"]
/** Which panel gives way first when the width cannot hold them all; Info never does. */
const DROP_ORDER: readonly DockPanelKind[] = ["scratch", "jobs", "subagents", "todos", "questions"]

type DockInput = {
  width: number
  todos: readonly TodoItem[]
  subagents: readonly DockSubagent[]
  info: DockInfo
  /** Pending approvals and questions of the session; the panel shows only while there are some. */
  questions?: readonly DockQuestion[]
  /** Background shell tasks; the panel shows only while there are some. */
  jobs?: readonly DockJob[]
  now?: number
  /** The project note; an empty panel can still receive focus. */
  scratch?: DockScratch
  onScratch?(area: { left: number; width: number; rows: number; first: number; cursor?: { row: number; col: number } }): void
}

/** The panels that fit `input.width`, left to right: the applicable ones, dropping by `DROP_ORDER` until they fit. */
export function dockPanels(input: DockInput): DockPanelKind[] {
  if (input.width < 70 && !input.scratch?.editing) return input.width >= 48 && input.todos.length ? ["todos"] : ["info"]
  const wanted = new Set<DockPanelKind>(["todos", "info"])
  if (input.questions?.length) wanted.add("questions")
  if (input.subagents.length) wanted.add("subagents")
  if (input.jobs?.length) wanted.add("jobs")
  if (input.scratch) wanted.add("scratch")
  const need = () => [...wanted].reduce((sum, kind) => sum + PANEL_MIN[kind], 0) + wanted.size - 1
  if (need() > input.width && input.todos.length === 0 && wanted.size > 2) wanted.delete("todos")
  for (const kind of DROP_ORDER) {
    if (need() <= input.width) break
    if (kind !== "scratch" || !input.scratch?.editing) wanted.delete(kind)
  }
  if (need() > input.width && input.scratch?.editing) return ["scratch"]
  return PANEL_ORDER.filter((kind) => wanted.has(kind))
}

function questionsBody(questions: readonly DockQuestion[], width: number): Line[] {
  const rows = questions.map((question): Line => clip([{ text: question.kind === "approval" ? "! " : "? ", fg: "warning" }, { text: question.title.replace(/\s+/g, " ").trim(), fg: "text" }], width))
  return [header("Questions", String(questions.length), width), ...bounded(rows, BODY_ROWS)]
}

function jobRow(job: DockJob, width: number, now: number | undefined): Line {
  const end = job.endedAt ?? now
  const elapsed = end === undefined ? "" : formatElapsed(Math.max(0, end - job.startedAt))
  const status = job.status === "running" ? elapsed : job.status === "exited" ? `exit ${job.exitCode ?? 0}` : job.status
  const active = job.status === "running" || job.status === "queued"
  const ok = job.status === "completed" || job.status === "exited" && (job.exitCode ?? 0) === 0
  const tone: ColorName = active ? "warning" : ok ? "muted" : "error"
  const room = Math.max(1, width - 2 - textWidth(status) - 2)
  return [{ text: active ? "• " : ok ? "✓ " : "× ", fg: tone }, ...fit([{ text: job.command.replace(/\s+/g, " ").trim(), fg: "text" }], room), { text: "  " }, { text: status, fg: tone }]
}

function jobsBody(jobs: readonly DockJob[], width: number, now: number | undefined): Line[] {
  const running = jobs.filter((job) => job.status === "running").length
  return [header("Jobs", `${running} running`, width), ...bounded(jobs.map((job) => jobRow(job, width, now)), BODY_ROWS)]
}

function scratchBody(scratch: DockScratch, width: number, at: { left: number; input: DockInput }): Line[] {
  const editor = scratch.editing ? scratch.editor : undefined
  const room = Math.max(1, width - 1)
  editor?.setVisualWidth(room)
  const lines = editor?.visualLines() ?? editorRows(scratch.lines.join("\n"), room, true)
  const cursor = editor ? Math.max(0, lines.findLastIndex((line) => line.start <= editor.cursorOffset)) : 0
  const first = Math.max(0, cursor - BODY_ROWS + 1)
  const selected = editor?.selection
  const rows = lines.slice(first, first + BODY_ROWS).map((line, index): Line => {
    const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.text)].map((s) => s.segment)
    const from = selected ? Math.max(0, selected.start - line.start) : 0
    const to = selected ? Math.max(0, Math.min(chars.length, selected.end - line.start)) : 0
    const spans: Line = selected && to > from ? [{ text: chars.slice(0, from).join(""), fg: "text" }, { text: chars.slice(from, to).join(""), fg: "background", bg: "primary" }, { text: chars.slice(to).join(""), fg: "text" }] : [{ text: line.text, fg: "text" }]
    return [...fit(spans, room), { text: lines.length > BODY_ROWS ? index === Math.round(first / Math.max(1, lines.length - BODY_ROWS) * (BODY_ROWS - 1)) ? "┃" : "│" : " ", fg: "border" }]
  })
  const current = lines[cursor]
  at.input.onScratch?.({ left: at.left, width: room, rows: BODY_ROWS, first, ...(editor && current ? { cursor: { row: 3 + cursor - first, col: at.left + textWidth([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current.text)].slice(0, editor.cursorOffset - current.start).map((s) => s.segment).join("")) } } : {}) })
  return [header("Scratchpad", scratch.editing ? "esc prompt" : "/scratch", width), ...rows]
}

/**
 * The dock, `DOCK_HEIGHT` rows by `width` cells: panels side by side (Todos, Questions and Subagents and Jobs and
 * Scratchpad when there is something for them, Info), dropping the least urgent when the width cannot hold them
 * (see `dockPanels`; Info always stays).
 */
export function renderDock(input: DockInput): Line[] {
  const { width } = input
  const plan = dockPanels(input)
  const gaps = plan.length - 1
  const base = Math.floor((width - gaps) / plan.length)
  let left = 0
  const blocks = plan.map((kind, index) => {
    const panelWidth = index === plan.length - 1 ? width - gaps - base * (plan.length - 1) : base
    const inner = Math.max(1, panelWidth - 2 * PAD_X)
    const body =
      kind === "todos"
        ? todosBody(input.todos, inner)
        : kind === "questions"
          ? questionsBody(input.questions ?? [], inner)
          : kind === "subagents"
            ? subagentsBody(input.subagents, inner)
            : kind === "jobs"
              ? jobsBody(input.jobs ?? [], inner, input.now)
              : kind === "scratch"
                ? scratchBody(input.scratch ?? { lines: [], editing: false }, inner, { left: left + 2, input })
                : infoBody(input.info, inner)
    left += panelWidth + 1
    return { lines: boxPanel({ body, width: panelWidth, height: DOCK_HEIGHT, active: kind === "scratch" && input.scratch?.editing === true }), width: panelWidth }
  })
  return beside(blocks, 1).slice(0, DOCK_HEIGHT)
}

const PAD_X = 2
