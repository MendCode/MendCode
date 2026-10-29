import type { HistoryReport, HistoryTurn, MessageRevision, SessionId } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { createHistoryState, historyTurns, historyReaderRows } from "../lazy-pages"

export function createHistory(ctx: AppContext, actions: { loadPage(): Promise<void> }) {
  const { input, state, requestFrame } = ctx
  const remembered = new Map<SessionId, { state: typeof state.historyState; report: HistoryReport | undefined }>()
  let serial = 0
  const remember = () => {
    remembered.delete(state.sessionId)
    remembered.set(state.sessionId, { state: { ...state.historyState, reader: false, editing: false }, report: state.historyReport })
    if (remembered.size > 32) remembered.delete(remembered.keys().next().value!)
  }
  async function loadHistory(query: { before?: number; after?: number; turnId?: HistoryTurn["turnId"] } = {}, search = false) {
    const visit = ++serial
    const sessionId = state.sessionId
    state.historyLoading = true
    state.historyError = ""
    requestFrame()
    try {
      let next = query
      for (let page = 0; page < (search ? 200 : 1); page++) {
        const reply = await input.send({ type: "session.history", sessionId, ...next })
        if (visit !== serial || state.page !== "history" || state.sessionId !== sessionId) return
        if (!reply.ok) { state.historyError = reply.error.message; return }
        const report = reply.result as HistoryReport | undefined ?? { turns: [] }
        if (query.turnId) { state.historyDetail = report.turns[0]; return }
        state.historyReport = report
        const matches = historyTurns(report, state.historyState.query)
        state.historyState.selected = search || query.after !== undefined ? 0 : Math.max(0, matches.length - 1)
        if (!search || matches.length || !report.older) return
        next = { before: report.older }
        state.historyState.page = page + 1
      }
      state.historyError = "Quick Jump reached the 200-page limit"
    } finally {
      if (visit === serial) { state.historyLoading = false; requestFrame() }
    }
  }
  async function openHistory() {
    await actions.loadPage()
    state.page = "history"
    const saved = remembered.get(state.sessionId)
    state.historyState = saved?.state ?? createHistoryState(input.screen.size.width)
    state.historyReport = saved?.report
    state.historyDetail = undefined
    requestFrame()
    const selected = historyTurns(saved?.report, state.historyState.query)[state.historyState.selected]?.turnId
    const last = saved?.report?.turns.at(-1)?.seq
    await loadHistory(saved && state.historyState.page > 0 && last !== undefined ? { before: last + 1 } : {})
    const index = historyTurns(state.historyReport, state.historyState.query).findIndex((turn) => turn.turnId === selected)
    if (index >= 0) state.historyState.selected = index
    requestFrame()
  }
  async function historyKey(key: string) {
    const h = state.historyState
    const turns = historyTurns(state.historyReport, h.query)
    const selected = turns[h.selected]
    if (h.editing) {
      if (key === "\x1b") { h.editing = false; h.query = h.queryBefore ?? ""; delete h.queryBefore }
      else if (key === "\r") { h.editing = false; h.page = 0; await loadHistory({}, true) }
      else if (key === "\x7f" || key === "\b") h.query = Array.from(h.query).slice(0, -1).join("")
      else if (!/[\x00-\x1f\x7f]/.test(key)) h.query = (h.query + key).slice(0, 200)
    } else if (key === "\x1b" || key === "q") {
      if (h.reader) { h.reader = false; h.scroll = 0 }
      else if (h.query) { h.query = ""; h.selected = 0 }
      else { remember(); serial++; state.page = "chat" }
    } else if (key === "l") { remember(); serial++; state.page = "chat"; ctx.view.jump(state.sessionId, 0, 0) }
    else if (key === "/") { h.queryBefore = h.query; h.editing = true }
    else if (h.reader) {
      const max = Math.max(0, historyReaderRows(state.historyDetail ?? selected, h, Math.max(1, input.screen.size.width - 4), ctx.now()).length - Math.max(1, input.screen.size.height - 7))
      const step = key === "\x1b[5~" || key === "\x1b[6~" ? Math.max(1, input.screen.size.height - 8) : 1
      if (["\x1b[A", "k", "\x1b[5~"].includes(key)) h.scroll = Math.max(0, h.scroll - step)
      if (["\x1b[B", "j", "\x1b[6~"].includes(key)) h.scroll = Math.min(max, h.scroll + step)
      if (key === "g" || key === "\x1b[H") h.scroll = 0
      if (key === "G" || key === "\x1b[F") h.scroll = max
      if (key === "t") h.tools = h.tools === "hidden" ? "count" : h.tools === "count" ? "tree" : "hidden"
    } else if (key === "v") h.view = h.view === "timeline" ? "tree" : h.view === "tree" ? "pages" : "timeline"
    else if (key === "s") h.split = !h.split
    else if (key === "t") h.tools = h.tools === "hidden" ? "count" : h.tools === "count" ? "tree" : "hidden"
    else if (key === "\r" && selected) { h.reader = true; h.scroll = 0; state.historyDetail = undefined; await loadHistory({ turnId: selected.turnId }) }
    else if (key === "\x1b[5~" && state.historyReport?.older && !state.historyLoading) { h.page++; await loadHistory({ before: state.historyReport.older }) }
    else if (key === "\x1b[6~" && state.historyReport?.newer && !state.historyLoading) { h.page = Math.max(0, h.page - 1); await loadHistory({ after: state.historyReport.newer }) }
    else if (["\x1b[A", "k", "\x10"].includes(key)) h.selected = Math.max(0, h.selected - 1)
    else if (["\x1b[B", "j", "\x0e"].includes(key)) h.selected = Math.min(Math.max(0, turns.length - 1), h.selected + 1)
    else if (key === "g" || key === "\x1b[H") h.selected = 0
    else if (key === "G" || key === "\x1b[F") h.selected = Math.max(0, turns.length - 1)
    else if (selected && [" ", "\x1b[D", "\x1b[C"].includes(key)) {
      const collapsed = h.collapsed.includes(selected.turnId)
      h.collapsed = key === "\x1b[C" || key === " " && collapsed ? h.collapsed.filter((id) => id !== selected.turnId) : [...new Set([...h.collapsed, selected.turnId])]
    }
    requestFrame()
  }
  function noteMessageRevision(event: MessageRevision) {
    const turns = new Set([...(state.historyReport?.turns ?? []), ...(state.historyDetail ? [state.historyDetail] : []), ...(remembered.get(event.sessionId)?.report?.turns ?? [])])
    for (const turn of turns) {
      const item = turn.items.find((item) => item.itemId === event.itemId)
      if (!item) continue
      if (item.kind === "user_message") turn.preview = event.deleted ? "" : (event.snapshot.text ?? "").replace(/\s+/g, " ").slice(0, 120)
      if (event.deleted) turn.items = turn.items.filter((item) => item.itemId !== event.itemId)
      else {
        item.text = event.snapshot.text ?? ""
        item.status = event.snapshot.status
        if (event.snapshot.attachments?.length) {
          item.attachmentRefs = event.snapshot.attachments
          item.attachments = event.snapshot.attachments.map((ref) => ref.name ?? ref.sha256.slice(0, 12))
        } else { delete item.attachments; delete item.attachmentRefs }
      }
    }
    requestFrame()
  }
  return { openHistory, historyKey, noteMessageRevision }
}
