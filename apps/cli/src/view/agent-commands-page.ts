import type { AgentCommandRecord, AgentCommandPolicyReport, AgentCommandsReport, SessionId } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread } from "./deck"
import { tabsRow } from "./page"
import { wrap } from "./wrap"

export type AgentCommandsPageState = { tab: number; selected?: string | undefined; scroll: number }
export const activeCommand = (command: AgentCommandRecord) => ["pending", "accepted", "running"].includes(command.state)
export const commandRows = (report: AgentCommandsReport | undefined, tab: number) => (report?.commands ?? []).filter((command) => tab === 1 ? !activeCommand(command) : activeCommand(command))

const line = (text: string, fg: "text" | "muted" | "primary" | "error" | "warning" = "text"): Line => [{ text, fg }]
const label = (command: AgentCommandRecord) => command.request.kind.replaceAll("_", " ")

export function renderAgentCommandsPage(input: {
  report?: AgentCommandsReport | undefined
  policy?: AgentCommandPolicyReport | undefined
  state: AgentCommandsPageState
  sessionId: SessionId
  titles: Record<string, string>
  loading: boolean
  error: string
  width: number
  height: number
}): Line[] {
  const { width, height, state, report } = input
  const inner = Math.max(1, width - 2)
  const rows = commandRows(report, state.tab)
  const index = Math.max(0, rows.findIndex((command) => command.commandId === state.selected))
  const selected = rows[index]
  const incoming = selected?.targetSessionId === input.sessionId
  const control = selected?.request.kind === "pause_after_turn" ? "Accepting pauses this session after its running turn; resume it from Agent View (p)." : selected?.request.kind === "stop" ? "Accepting stops this session's running turn and its sub-agents." : ""
  const reviewing = state.tab !== 2 && incoming && selected?.state === "pending"
  const hints = width < 70 ? `${reviewing ? "a/x · " : ""}↑↓ · pgup/dn · r · esc` : `${reviewing ? "a accept · x reject · " : ""}${state.tab !== 2 ? "↑↓ select · enter open · " : ""}pgup/dn · r refresh · esc back`
  const head: Line[] = [spread(line("Commands", "primary"), line(hints, "muted"), inner), tabsRow([{ key: "1", label: "Active" }, { key: "2", label: "History" }, { key: "3", label: "Policy" }], state.tab, inner), []]
  if (input.error) head.push(...wrap(input.error, inner).slice(0, 2).map((text) => line(text, "error")))
  const room = Math.max(0, height - head.length)
  const paragraphs = (text: string, w: number) => wrap(text, w).map((text) => line(text))
  const name = (id: string) => report?.metadata.find((entry) => entry.sessionId === id)?.title ?? input.titles[id] ?? id
  const detail = (w: number): Line[] => {
    if (!selected) return [line(input.loading ? "Loading commands…" : "No commands", "muted")]
    const request = selected.request
    const value = request.kind === "rename" ? request.title : request.kind === "tag" ? request.tags.join(", ") || "No tags" : request.kind === "request_summary" ? request.instructions ?? "" : request.kind === "send_message" || request.kind === "peer_message" ? request.text : request.reason ?? ""
    return [line(`${label(selected)} · ${selected.state}`, "primary"), ...paragraphs(`From: ${name(selected.sourceSessionId)}`, w), ...paragraphs(`To: ${name(selected.targetSessionId)}`, w), ...paragraphs(selected.commandId, w), [], ...paragraphs(value, w), ...(selected.result ? [[], line("Result", "primary"), ...paragraphs(selected.result, w)] : []), ...(selected.error ? [[], ...wrap(selected.error, w).map((text) => line(text, "error"))] : []), ...(control && incoming && selected.state === "pending" ? [[], ...wrap(control, w).map((text) => line(text, "warning"))] : [])]
  }
  const list = (w: number): Line[] => rows.length ? rows.flatMap((command) => [
    fit(line(`${command.commandId === selected?.commandId ? "›" : " "} ${command.targetSessionId === input.sessionId ? "←" : "→"} ${name(command.targetSessionId === input.sessionId ? command.sourceSessionId : command.targetSessionId)}`, command.commandId === selected?.commandId ? "primary" : "text"), w),
    fit(line(`    ${label(command)} · ${command.state}`, "muted"), w),
  ]) : [line(input.loading ? "Loading commands…" : state.tab === 1 ? "No command history" : "No active commands", "muted")]
  let body: Line[]
  if (state.tab === 2) {
    body = panelGrid({ width: inner, padding: true, compact: false, maxColumns: width < 70 ? 1 : 2, heights: [room], rows: [[
      { title: "Local policy", body: (w) => (input.policy?.matrix ?? []).flatMap((entry) => [line(entry.kind.replaceAll("_", " "), "primary"), ...paragraphs(entry.decision, w), ...paragraphs(entry.permissions.join(", "), w), []]), scroll: state.scroll },
      { title: "Authority", body: (w) => [line("Target review", "primary"), ...paragraphs("Accept or reject from the target session. Metadata changes affect Agent View only.", w), [], line("Control", "primary"), ...paragraphs("Pause and stop run only after the target accepts, inside one project. Remote command authority stays off.", w), [], ...paragraphs("Summary/message requests queue behind active work. No history, files or permissions are transferred.", w)] },
    ]] })
  } else if (width < 70) {
    body = panelGrid({ width: inner, padding: true, compact: false, maxColumns: 1, heights: [Math.max(5, room - 6), 5], rows: [[{ title: "Selected command", body: detail, scroll: state.scroll }], [{ title: `${rows.length} ${state.tab === 1 ? "past" : "active"}`, body: list, scroll: index * 2 }]] })
  } else {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: `${rows.length} ${state.tab === 1 ? "past" : "active"}`, weight: 2, body: list, scroll: Math.max(0, index * 2 + 2 - Math.max(0, room - 4)) },
      { title: "Selected command", weight: 3, body: detail, scroll: state.scroll },
      ...(width >= 150 && selected ? [{ title: "Policy", weight: 2, body: (w: number) => [line(selected.policy.decision, "primary"), ...paragraphs(selected.policy.reason, w), [], ...paragraphs(selected.policy.permissions.join(", "), w), [], ...paragraphs(`Expires: ${new Date(selected.expiresAt).toISOString()}`, w)] }] : []),
    ]] })
  }
  const frame = [...head, ...body].slice(0, height)
  while (frame.length < height) frame.push([])
  return frame.map((row) => [{ text: " " }, ...fit(row, inner), { text: " " }])
}
