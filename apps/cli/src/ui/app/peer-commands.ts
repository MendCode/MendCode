import type { AgentCommandRequest, AgentCommandsReport, AgentCommandPolicyReport, CommandId, SessionId, SessionSummary } from "@mendcode/protocol"
import type { AgentCommandsPageState } from "../../view/agent-commands-page"
import { preload, renderAgentCommandsPage } from "../lazy-pages"
import type { AppContext } from "./context"

export function createPeerCommands(ctx: AppContext) {
  const { input, state, requestFrame, fail } = ctx
  let page: AgentCommandsPageState = { tab: 0, scroll: 0 }
  let report: AgentCommandsReport | undefined
  let policy: AgentCommandPolicyReport | undefined
  let loading = false
  let error = ""
  let visit = 0
  let titles: Record<string, string> = {}

  async function load() {
    const sessionId = state.sessionId
    const ticket = ++visit
    loading = true
    error = ""
    requestFrame()
    const [listed, matrix, sessions] = await Promise.all([
      input.send({ type: "session.agent-command.list", sessionId }),
      input.send({ type: "session.agent-command.policy" }),
      input.send({ type: "session.list", directory: input.directory, limit: 100, hideEmpty: true }),
    ])
    if (ticket !== visit || sessionId !== state.sessionId) return
    loading = false
    if (listed.ok) report = listed.result as AgentCommandsReport | undefined
    else error = listed.error.message
    if (matrix.ok) policy = matrix.result as AgentCommandPolicyReport | undefined
    else if (!error) error = matrix.error.message
    if (sessions.ok) titles = Object.fromEntries(((sessions.result?.sessions ?? []) as SessionSummary[]).map((session) => [session.sessionId, session.title]))
    requestFrame()
  }

  async function open(tab = 0) {
    await preload("agents")
    page = { tab, scroll: 0 }
    report = undefined
    state.page = "agent-commands"
    await load()
  }

  async function command(args: string) {
    const match = /^(\S+)\s*(.*)$/.exec(args.trim())
    const action = match?.[1] ?? "commands"
    const rest = match?.[2] ?? ""
    if (action === "commands" || action === "policy") return open(action === "policy" ? 2 : 0)
    const target = /^(\S+)\s*(.*)$/.exec(rest)
    if (!target) return fail("usage: /agents summary|rename|tag|pause|stop|message <session-id> [text]")
    const text = target[2] ?? ""
    const request: AgentCommandRequest | undefined = action === "summary" ? { kind: "request_summary", ...(text ? { instructions: text } : {}) }
      : action === "rename" && text ? { kind: "rename", title: text }
      : action === "tag" ? { kind: "tag", tags: text.split(",") }
      : action === "pause" || action === "stop" ? { kind: action === "pause" ? "pause_after_turn" : "stop", ...(text ? { reason: text } : {}) }
      : action === "message" && text ? { kind: "send_message", text } : undefined
    if (!request) return fail("usage: /agents summary|rename|tag|pause|stop|message <session-id> [text]")
    const reply = await input.send({ type: "session.agent-command.create", sessionId: state.sessionId, targetSessionId: target[1] as SessionId, request })
    if (!reply.ok) return fail(reply.error.message)
    await open()
  }

  const rows = () => (report?.commands ?? []).filter((entry) => page.tab === 1 ? !["pending", "accepted", "running"].includes(entry.state) : ["pending", "accepted", "running"].includes(entry.state))
  async function key(key: string): Promise<SessionId | undefined> {
    const list = rows()
    const index = Math.max(0, list.findIndex((entry) => entry.commandId === page.selected))
    const selected = list[index]
    if (key === "\x1b" || key === "q") {
      ++visit
      state.page = "chat"
    }
    else if (["1", "2", "3", "\t", "\x1b[Z"].includes(key)) page = { tab: key === "\t" ? (page.tab + 1) % 3 : key === "\x1b[Z" ? (page.tab + 2) % 3 : Number(key) - 1, scroll: 0 }
    else if (key === "r") await load()
    else if (key === "\x1b[5~" || key === "\x1b[6~") page.scroll = Math.max(0, page.scroll + (key === "\x1b[5~" ? -5 : 5))
    else if (page.tab !== 2 && ["j", "k", "\x1b[A", "\x1b[B"].includes(key)) page = { ...page, selected: list[Math.max(0, Math.min(list.length - 1, index + (key === "j" || key === "\x1b[B" ? 1 : -1)))]?.commandId, scroll: 0 }
    else if (page.tab !== 2 && key === "\r" && selected) return selected.targetSessionId === state.sessionId ? selected.sourceSessionId : selected.targetSessionId
    else if (page.tab !== 2 && (key === "a" || key === "x") && selected?.state === "pending" && selected.targetSessionId === state.sessionId && !loading) {
      loading = true
      const reply = await input.send({ type: "session.agent-command.update", sessionId: state.sessionId, commandId: selected.commandId as CommandId, state: key === "a" ? "accepted" : "rejected" })
      await load()
      if (!reply.ok) {
        error = reply.error.message
        requestFrame()
      }
    }
    requestFrame()
  }
  return {
    open, command, key,
    changed: (source: SessionId, target: SessionId) => { if (state.page === "agent-commands" && (state.sessionId === source || state.sessionId === target)) void load() },
    render: (width: number, height: number) => renderAgentCommandsPage({ report, policy, state: page, sessionId: state.sessionId, titles, loading, error, width, height }),
  }
}
