import type { MflowReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { fit, panelGrid, type GridPanel } from "./deck"
import { wrap } from "./wrap"
import { mflowText } from "../mflow-output"

export const MFLOW_ACTIONS = ["Configure and turn on", "Start coordination", "Stop coordination", "Turn off", "Remove local config", "Show details", "Scan relays", "Relay guide", "Plan", "Doctor", "Legacy status"] as const
export type MflowPageState = {
  selected: number
  scroll: number
  details: boolean
  report?: MflowReport
  error?: string
  busy?: boolean
  readOnly: boolean
  confirm?: boolean
  form?: { selected: number; values: string[]; cursors: number[] } | undefined
}
const lines = (values: string[], width: number): Line[] => values.flatMap((value) => wrap(value, Math.max(1, width)).map((text) => [{ text }]))
export function renderMflowPage(input: { state: MflowPageState; width: number; height: number; now: number }): Line[] {
  const { state, width, height, now } = input
  const inner = Math.max(1, width - 4), room = Math.max(1, height - 2), compact = width < 70
  const report = state.report
  const error = state.error || (state.busy ? "Reading Mflow…" : report?.failures.join("; "))
  let hints = compact ? "↑↓ · tab · ↵ · r · esc" : "↑↓ select · tab details · ↵ run · r refresh · esc"
  let body: Line[]
  if (state.form) {
    hints = "tab field · ↵ activate · esc"
    const form = state.form
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: "Configure and turn on", body: (contentWidth) => [
      ...["Room", "Relay", "Token file", "Priority"].map((label, index) => {
        const value = form.values[index] ?? "", cursor = form.cursors[index] ?? value.length
        const prefix = `${index === form.selected ? "›" : " "} ${label}: `
        const offset = Math.max(0, cursor - Math.max(1, contentWidth - prefix.length) + 1)
        return fit([{ text: prefix, fg: index === form.selected ? "primary" : "muted" }, { text: index === form.selected ? value.slice(offset, cursor) + "▏" + value.slice(cursor) : value, fg: "text" }], contentWidth)
      }), [], ...lines(["embedded = this daemon", "HTTP/WS relay: literal loopback + private token", "Activation saves config; start is explicit", ...(error ? [error] : [])], contentWidth),
    ] }]] })
  } else if (state.confirm) {
    hints = "y remove · n cancel · esc"
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: "Remove Mflow config?", body: (contentWidth) => lines(["Stops coordination and moves local config to data-dir Trash.", "Project files and the external relay are preserved.", ...(error ? [error] : [])], contentWidth) }]] })
  } else if (state.details) {
    hints = compact ? "↑↓ scroll · tab · r · esc" : "↑↓ scroll · tab manager · r refresh · esc"
    const title = report?.operation === "status" ? "Details" : report?.operation ?? "Details"
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title, scroll: state.scroll, body: (contentWidth) => lines([...(error ? [error] : []), ...(report ? mflowText(report).trimEnd().split("\n") : [])], contentWidth) }]] })
  } else {
    const mode = report?.mode ?? (state.busy ? "loading" : "unavailable")
    const summary: GridPanel = { title: "State", body: (contentWidth) => lines([mode, ...(error ? [error] : []), ...(state.readOnly ? ["Read-only peer; Mflow unavailable"] : [])], contentWidth) }
    const connection: GridPanel = { title: "Connection", body: (contentWidth) => lines(report ? [report.config.room, report.config.signaling, `Priority ${report.config.hookPriority} · token ${report.config.tokenConfigured ? "configured" : report.config.signaling === "embedded" ? "local socket" : "missing"}`] : [], contentWidth) }
    const actions: GridPanel = { title: "Actions", active: true, scroll: Math.max(0, state.selected - Math.max(1, (compact ? room : room - 8) - 6)), body: (contentWidth) => MFLOW_ACTIONS.map((text, index) => fit([{ text: `${state.selected === index ? "›" : " "} ${text}`, fg: state.selected === index ? "primary" : "text", bold: state.selected === index }], contentWidth)) }
    const remaining = (expiresAt: number) => `${Math.max(0, Math.ceil((expiresAt - now) / 1000))}s`
    const locks: GridPanel = { title: `Locks · ${report?.locks.length ?? "?"}`, body: (contentWidth) => lines(report?.locks.length ? report.locks.flatMap((lock) => [`${lock.mode} · ${remaining(lock.expiresAt)} · ${lock.owner}`, ...lock.files]) : [report ? "No active file leases" : "Unavailable"], contentWidth) }
    const peers: GridPanel = { title: `Peers · ${report?.peers.length ?? "?"}`, body: (contentWidth) => lines(report?.peers.length ? report.peers.map((peer) => `${peer.owner} · ${remaining(peer.expiresAt)}`) : [report ? "No active room peers" : "Unavailable"], contentWidth) }
    body = compact
      ? panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ ...actions, title: `Actions · ${mode}`, body: (contentWidth) => [...lines(error ? [error] : [], contentWidth), ...(actions.body as (width: number) => Line[])(contentWidth)] }]] })
      : panelGrid({ width: inner, compact: false, padding: true, maxColumns: width >= 150 ? 3 : 2, heights: [7, Math.max(1, room - 8)], rows: [[summary, connection], width >= 150 ? [actions, locks, peers] : [actions, { title: "Room leases", body: (contentWidth) => [...(peers.body as (width: number) => Line[])(contentWidth), [], ...(locks.body as (width: number) => Line[])(contentWidth)] }]] })
  }
  return appearancePage({ title: "Mflow", hints, body, width, height })
}
