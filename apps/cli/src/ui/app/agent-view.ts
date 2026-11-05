import type { ItemId } from "@mendcode/protocol"
import type { AgentThread } from "../../view/transcript"
import type { AppContext, AppState } from "./context"

/** A view's own prompt while another view is on screen. */
export type ViewPrompt = { text: string; attachments: AppState["attachments"]; pastes: AppState["pastes"] }

/**
 * What the chat reads from the sub-agent's own transcript while its thread is open: the rows and everything that moves, folds
 * or searches them. The rest (the turn, approvals, usage, the permission mode, new events) stays the session's. The prompt and the
 * queue are the view's own: the thread shows only what was sent from it, and the conversation's prompt waits until it is back.
 */
const BODY = new Set<PropertyKey>([
  "blocks", "olderBlocks", "loadOlder", "totalLines", "viewport", "from", "blockLines", "attachmentsOf", "visibleCount", "offsetFor", "offsetForAnchor",
  "pinWindow", "toggleTools", "toggleDetails", "toggleConceal", "revealFind", "endFind", "refresh", "revision",
])
// `setMode` and `setAppearance` stay the session's: it passes them on to every thread, so the chat reads one way wherever the reader goes.

/**
 * A sub-agent that lives inside the session (an engine's own, as Claude Code's Agent tool) opened in the chat's place. It has no
 * session to switch to, so the chat shows its transcript where the conversation was: `state.transcript` becomes a view that
 * takes the rows from the thread and everything else from the session, and closing puts the session's transcript back at the
 * row the reader left. The same keys as for child sessions move here: down opens, up returns, left and right change sibling.
 */
export function createAgentView(ctx: AppContext) {
  const { state, view, editor, requestFrame } = ctx
  type Transcript = typeof state.transcript
  let left: { offset: number; follow: boolean } | undefined

  const root = (): Transcript => state.agentRoot ?? state.transcript
  const threads = (): AgentThread[] => root().agentThreads()
  const own = (itemId: ItemId) => (state.agentViews ??= new Map()).get(itemId) ?? state.agentViews.set(itemId, { queued: new Map() }).get(itemId)!

  /** The prompt on screen leaves with the view it belongs to; the next view's comes back (empty the first time). */
  function swapPrompt(next: ViewPrompt | undefined): ViewPrompt {
    const leaving = { text: editor.text, attachments: state.attachments, pastes: state.pastes }
    editor.replaceAll(next?.text ?? "")
    state.attachments = next?.attachments ?? []
    state.pastes = next?.pastes ?? []
    return leaving
  }

  /**
   * The session's queue as this thread shows it: only what was sent while it was open. The rest is the conversation's and waits there,
   * so ↑, alt+↑, ctrl+s and ctrl+k in the thread never reach a message queued from another view.
   */
  function queueOf(session: Transcript, itemId: ItemId): Transcript["queue"] {
    const queued = own(itemId).queued
    if (!queued.size) return []
    const listed = session.queue.filter((entry) => queued.has(entry.queueId))
    for (const entry of listed) queued.set(entry.queueId, true)
    // A message that left the queue (sent, dropped, edited back) leaves the thread's list too; one not listed yet is still on its way.
    if (listed.length < queued.size) for (const [queueId, seen] of queued) if (seen && !listed.some((entry) => entry.queueId === queueId)) queued.delete(queueId)
    return listed
  }

  function show(itemId: ItemId): boolean {
    const session = root()
    const thread = session.agentTranscript(itemId) as Transcript | undefined
    if (!thread) return false
    const scroll = view.get(state.sessionId)
    if (!state.agentRoot) left = { offset: scroll.offset, follow: scroll.follow }
    const leaving = swapPrompt(own(itemId).prompt)
    if (state.agentView) own(state.agentView).prompt = leaving
    else state.agentMainPrompt = leaving
    state.agentRoot = session
    state.agentView = itemId
    state.transcript = new Proxy(session, {
      get(target, property) {
        if (property === "queue") return queueOf(target, itemId)
        const from = BODY.has(property) ? thread : target
        const value = Reflect.get(from, property, from)
        return typeof value === "function" ? value.bind(from) : value
      },
    })
    scroll.offset = 0
    scroll.follow = true
    scroll.unseen = 0
    requestFrame()
    return true
  }

  function close(): boolean {
    if (!state.agentRoot) return false
    if (state.agentView) own(state.agentView).prompt = swapPrompt(state.agentMainPrompt)
    state.agentMainPrompt = undefined
    state.transcript = state.agentRoot
    state.agentRoot = undefined
    state.agentView = undefined
    const scroll = view.get(state.sessionId)
    scroll.offset = left?.offset ?? 0
    scroll.follow = left?.follow ?? true
    left = undefined
    requestFrame()
    return true
  }

  /** The thread a first open goes to: the one at work, else the latest. */
  function first(): boolean {
    const listed = threads().filter((thread) => root().agentTranscript(thread.itemId))
    const target = listed.find((thread) => thread.running) ?? listed.at(-1)
    return target ? show(target.itemId) : false
  }

  function cycle(step: 1 | -1): boolean {
    const listed = threads().filter((thread) => root().agentTranscript(thread.itemId))
    const at = listed.findIndex((thread) => thread.itemId === state.agentView)
    if (at < 0 || listed.length < 2) return false
    return show(listed[(at + step + listed.length) % listed.length]!.itemId)
  }

  return {
    show, close, first, cycle, threads,
    get open() { return state.agentView !== undefined },
    /** The thread on screen, for the top bar. */
    current: (): AgentThread | undefined => (state.agentView ? threads().find((thread) => thread.itemId === state.agentView) : undefined),
    /** A session switch or a new transcript ends the view without restoring anything. */
    reset() { state.agentRoot = undefined; state.agentView = undefined; state.agentMainPrompt = undefined; state.agentViews = undefined; left = undefined },
  }
}

export type AgentView = ReturnType<typeof createAgentView>
