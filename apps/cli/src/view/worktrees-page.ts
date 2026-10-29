import type { WorktreeReport, WorktreePreview, WorktreeRecord } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid, fit } from "./deck"
import { wrap } from "./wrap"
import { worktreePreviewText } from "../worktree-output"

export type WarpRow = { id: string; name: string; type: string; branch: string | null; directory: string; status?: string }
export type WorktreesPageState = {
  mode: "manager" | "warp"
  selected: number
  scroll: number
  readOnly: boolean
  detailsFocused?: boolean
  report?: WorktreeReport
  preview?: WorktreePreview | undefined
  form?: { selected: number; values: string[]; cursors: number[] } | undefined
  error?: string
  busy?: boolean
  /** Warp mode: workspaces from project.rest, the project root, the directory the session is in and the id armed for removal. */
  workspaces?: WarpRow[]
  projectPath?: string
  currentDirectory?: string
  confirmRemove?: string | undefined
  /** Warp mode inside the Git page: the directories `worktree.query` found with uncommitted changes. Absent elsewhere. */
  dirty?: ReadonlySet<string>
}
const lines = (values: string[], width: number): Line[] => values.flatMap((value) => wrap(value, Math.max(1, width)).map((text): Line => [{ text }]))
function details(record: WorktreeRecord | undefined, width: number): Line[] {
  return lines(record ? [record.path, `Branch: ${record.branch ?? "detached"}`, `ID: ${record.id}`, `Ownership: ${record.ownership}`, `Changes: ${record.dirty.summary}`, `Sessions: ${record.sessions.length}`, `Cleanup: ${record.cleanupPolicy}`, ...record.drift] : ["No worktree selected"], width)
}
export function renderWorktreesPage(input: { state: WorktreesPageState; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const report = state.report
  const inner = Math.max(1, width - 4)
  const room = Math.max(6, height - 2)
  const compact = width < 70
  const warp = state.mode === "warp"
  const title = warp ? "Workspaces" : "Worktrees"
  let hints = state.mode === "warp" ? compact ? "↑↓ · tab pane · c · ↵ · esc" : "↑↓ · tab pane · c new · ↵ move · x remove · r refresh · esc" : compact ? "↑↓ · tab pane · c · ↵ · esc" : "↑↓ · tab pane · c new · ↵ open · a adopt · x remove · z reset · d doctor · r · esc"
  let body: Line[]
  const message = state.error || (state.busy ? warp ? "Working…" : "Reading worktrees…" : warp ? "" : report?.failures.join("; ") || (report?.truncated ? "Results truncated" : ""))
  if (state.form) {
    hints = warp ? "tab field · ↵ create & move · esc" : "tab field · ↵ preview · esc"
    const form = state.form
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: warp ? "New workspace" : "New worktree · preview", body: (contentWidth) => {
      const labels = warp ? ["Name", "Directory"] : ["Name", "Branch", "Base", "Path", "Focus"]
      return [...labels.map((label, index): Line => {
        const value = form.values[index] ?? ""
        const selected = index === form.selected
        const cursor = form.cursors[index] ?? value.length
        const prefix = `${selected ? "›" : " "} ${label}: `
        const available = Math.max(1, contentWidth - prefix.length)
        const offset = selected ? Math.max(0, cursor - available + 1) : 0
        return fit([{ text: prefix, fg: selected ? "primary" : "muted" }, { text: selected ? value.slice(offset, cursor) + "▏" + value.slice(cursor) : value, fg: "text" }], contentWidth)
      }), [], ...lines([warp ? "Creates a Git worktree, or adds Directory as a local workspace, then moves this session there" : "Saves a plan; does not run Git", ...(message ? [message] : [])], contentWidth)]
    } }]] })
  } else if (state.preview) {
    hints = "↑↓ scroll · esc back"
    const preview = state.preview
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: `${preview.action} · ${preview.blocked ? "blocked" : "preview"}`, scroll: state.scroll, body: (contentWidth) => lines([...worktreePreviewText(preview), ...(preview.action === "open" ? ["Session switching blocked: workspace contract undecided"] : []), ...(message ? [message] : [])], contentWidth) }]] })
  } else {
    const records = report?.records ?? []
    const workspaces = state.workspaces ?? []
    const active = (directory: string) => directory === state.currentDirectory
    const options = warp
      ? ["New workspace", `Local project${state.projectPath && active(state.projectPath) ? " · current" : ""}${state.projectPath && state.dirty?.has(state.projectPath) ? " · dirty" : ""}`, ...workspaces.map((item) => `${item.name} · ${item.branch ?? item.type}${active(item.directory) ? " · current" : ""}${item.status === "disconnected" ? " · missing" : ""}${state.dirty?.has(item.directory) ? " · dirty" : ""}`)]
      : records.map((record) => `${record.branch ?? "detached"} · ${record.ownership} · ${record.dirty.clean ? "clean" : "dirty"}`)
    const selected = records[state.selected - (warp ? 2 : 0)]
    const chosen = warp ? workspaces[state.selected - 2] : undefined
    const list = { title: warp ? `Available workspaces · ${workspaces.length}` : `Worktrees · ${records.length}`, body: (contentWidth: number): Line[] => options.length ? options.map((text, index) => fit([{ text: `${index === state.selected ? "›" : " "} ${text}`, fg: index === state.selected ? "primary" : "text", bold: index === state.selected }], contentWidth)) : lines([message || "No Git worktrees available"], contentWidth), scroll: Math.max(0, state.selected - (compact ? Math.floor(room / 2) - 5 : room - 5)), active: !state.detailsFocused }
    const info = { title: report?.operation === "doctor" ? "Doctor" : "Workspace", scroll: state.scroll, active: state.detailsFocused ?? false, body: (contentWidth: number) => {
      if (warp) {
        const shown = state.selected === 0 ? ["Create a workspace", "Git worktree on a new branch, or a local directory", "↵ creates it and moves this session"] : state.selected === 1 ? [state.projectPath ?? "Project unavailable", active(state.projectPath ?? "") ? "Session is already here" : "↵ moves this session back"] : chosen ? [chosen.directory, `Type: ${chosen.type}`, `Branch: ${chosen.branch ?? "none"}`, `ID: ${chosen.id}`, `Status: ${chosen.status ?? "unknown"}`, active(chosen.directory) ? "Session is already here" : "↵ moves this session and its children"] : ["No workspace selected"]
        return lines([...(message ? [message] : []), ...(state.confirmRemove && chosen?.id === state.confirmRemove ? ["x again removes this workspace"] : []), ...(state.readOnly ? ["Read-only: workspaces unavailable"] : []), ...shown, ...(state.projectPath ? ["", `Project: ${state.projectPath}`] : [])], contentWidth)
      }
      return [
        ...lines([...(message ? [message] : []), ...(state.readOnly ? ["Registry: read-only"] : [])], contentWidth),
        ...details(selected, contentWidth), [],
        ...lines([...(report ? [`Project: ${report.workspace.currentPath}`, `Branch: ${report.workspace.currentBranch ?? "detached"}`, `Plans: ${report.plans.length}`, ...report.plans.map((plan) => `${plan.id} · ${plan.preview.target.branch} · ${plan.focus}`), ...(report.operation === "doctor" ? [`Git checkout: ${report.ok ? "available" : "unavailable"}`, `Registry: ${report.registryPath}`, ...report.warnings] : [])] : [])], contentWidth),
      ]
    } }
    const first = Math.max(6, Math.floor((room - 1) * 0.45))
    body = panelGrid({ width: inner, compact: false, padding: true, maxColumns: compact ? 1 : 2, heights: compact ? [first, room - first - 1] : [room], rows: compact ? [[list], [info]] : [[list, info]] })
  }
  return appearancePage({ title, hints, body, width, height })
}
