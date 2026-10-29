import type { TsmReport, TsmChange } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid, fit } from "./deck"
import { wrap } from "./wrap"
import { TSM_ACTIONS } from "../tsm-actions"
import { tsmDetails, tsmPlanText, tsmPreviewText } from "../tsm-output"

export type TsmPageState = {
  selected: number
  scroll: number
  detailsFocused: boolean
  section: "status" | "workspace" | "details" | "plan" | "doctor" | "preview"
  mux: NonNullable<Extract<TsmChange, { operation: "activate" }>["muxBackend"]>
  readOnly: boolean
  report?: TsmReport
  error?: string
  busy?: boolean
  confirmRemove?: boolean
}
const lines = (values: string[], width: number): Line[] => values.flatMap((value) => wrap(value, Math.max(1, width)).map((text): Line => [{ text }]))
export function renderTsmPage(input: { state: TsmPageState; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const report = state.report
  const compact = width < 70
  const wide = width >= 150 && height >= 30
  const inner = Math.max(1, width - 4), room = Math.max(1, height - 2)
  const hints = state.confirmRemove ? "y recycle · n cancel · esc" : state.detailsFocused ? "↑↓ scroll · tab actions · esc" : compact ? "↑↓ · ↵ · tab · m mux · r · esc" : "↑↓ actions · ↵ select · tab pane · m mux · r refresh · esc"
  const action = TSM_ACTIONS[state.selected] ?? TSM_ACTIONS[0]
  const menu = { title: report ? `TSM · ${report.lifecycle}` : "TSM", weight: 1, active: !state.detailsFocused, scroll: Math.max(0, state.selected - (compact ? Math.min(TSM_ACTIONS.length, room - 4) : room - 4) + 1), body: (contentWidth: number): Line[] => [
    ...(compact && (state.error || state.busy || state.readOnly) ? [...lines([state.error || (state.readOnly ? "Read-only: probes disabled" : "Reading TSM…")], contentWidth), []] : []),
    ...TSM_ACTIONS.map((item, index): Line => {
    const disabled = state.readOnly || item.id === "activate" && !report?.worktreeCapable || item.id === "deactivate" && !report?.enabled
    return fit([{ text: `${index === state.selected ? "›" : " "} ${item.title}${disabled ? " · unavailable" : ""}`, fg: index === state.selected ? "primary" : disabled ? "muted" : "text", bold: index === state.selected }], contentWidth)
    }),
  ] }
  const info = { title: state.confirmRemove ? "Remove scaffold?" : state.section === "plan" ? "Setup plan" : state.section === "doctor" ? "Doctor" : state.section === "preview" ? "Workspace preview" : state.section === "workspace" ? "Workspace" : "Adapter", weight: 2, active: state.detailsFocused, scroll: state.scroll, body: (contentWidth: number): Line[] => {
    const message = state.error || (state.busy ? "Reading TSM…" : "")
    const values = state.confirmRemove
      ? ["Recycle MendCode's TSM state and setup plan?", ...(report ? [report.managedFiles.state, report.managedFiles.plan] : []), "External TSM, sessions, worktrees and sync policy stay in place"]
      : !report ? []
      : state.section === "plan" ? tsmPlanText(report)
      : state.section === "preview" ? tsmPreviewText(report)
      : state.section === "workspace" ? [`${report.workspace.isLinkedWorktree ? "Linked worktree" : "Base checkout"}: ${report.workspace.currentPath}`, `Branch: ${report.workspace.currentBranch ?? "detached"}`, `Repository: ${report.workspace.repoRoot ?? "unavailable"}`, `State: ${report.managedFiles.state}`]
      : tsmDetails(report)
    return [
      ...lines([...(message ? [message] : []), ...(state.readOnly ? ["TSM probes and changes unavailable in read-only mode"] : []), ...(!state.confirmRemove ? [action.note, ...(action.id === "activate" ? [`Selected mux: ${state.mux}`] : [])] : [])], contentWidth), [],
      ...lines(wide && ["status", "details"].includes(state.section) ? values.slice(0, 5 + (report?.failures.length ?? 0) + (report?.warnings.length ?? 0)) : values, contentWidth), ...(report?.archivedTo ? [[], ...lines([`Scaffold recycled: ${report.archivedTo}`], contentWidth)] : []),
    ]
  } }
  const workspace = { title: "Workspace", body: (contentWidth: number) => lines(report ? [`Project: ${report.workspace.currentPath}`, `Branch: ${report.workspace.currentBranch ?? "detached"}`, `Repository: ${report.workspace.repoRoot ?? "unavailable"}`, `Checkout: ${report.workspace.isLinkedWorktree ? "linked worktree" : "base"}`, `Git: ${report.rootGit ? report.gitHead ? "committed" : "no commits" : "unavailable"}`] : [], contentWidth) }
  const policy = { title: "Policy & scaffold", body: (contentWidth: number) => lines(report ? [`Mode: ${report.policy.mode}`, `Live sync: ${report.policy.liveSync ? "on" : "off"}`, ...report.policy.neverSync.map((value) => `Never sync: ${value}`), `State: ${report.managedFiles.state}`, `Plan: ${report.managedFiles.plan}`, `Policy: ${report.managedFiles.policy}`, "Install: off", "Session launch: off", "Worktree removal: off"] : [], contentWidth) }
  const setup = { title: state.section === "plan" ? "Adapter capabilities" : "Setup plan", body: (contentWidth: number) => lines(report ? [...(state.section === "plan" ? [] : tsmPlanText(report)), `Source: ${report.repository}`, `Supported: ${report.supportedRange}`, `Recommended in v1: ${report.recommendedVersion}`, report.capabilities.join(" · ")] : [], contentWidth) }
  const first = Math.max(14, Math.floor((room - 1) * 0.52))
  const rows = compact ? [[state.detailsFocused || state.confirmRemove ? info : menu]] : wide ? [[menu, info], [workspace, policy, setup]] : [[menu, info]]
  const body = panelGrid({ width: inner, compact: false, padding: true, heights: wide ? [first, room - first - 1] : [room], rows })
  return appearancePage({ title: "TSM", hints, body, width, height })
}
