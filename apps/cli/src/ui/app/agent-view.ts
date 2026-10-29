import type { ItemId } from "@mendcode/protocol"
import type { AgentThread } from "../../view/transcript"
import type { AppContext } from "./context"

/**
 * What the chat reads from the sub-agent's own transcript while its thread is open: the rows and everything that moves, folds
 * or searches them. The rest (the turn, approvals, the queue, usage, the permission mode, new events) stays the session's.
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
  const { state, view, requestFrame } = ctx
  type Transcript = typeof state.transcript
  let left: { offset: number; follow: boolean } | undefined

  const root = (): Transcript => state.agentRoot ?? state.transcript
  const threads = (): AgentThread[] => root().agentThreads()

  function show(itemId: ItemId): boolean {
    const session = root()
    const thread = session.agentTranscript(itemId) as Transcript | undefined
    if (!thread) return false
    const scroll = view.get(state.sessionId)
    if (!state.agentRoot) left = { offset: scroll.offset, follow: scroll.follow }
    state.agentRoot = session
    state.agentView = itemId
    state.transcript = new Proxy(session, {
      get(target, property) {
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
    reset() { state.agentRoot = undefined; state.agentView = undefined; left = undefined },
  }
}

export type AgentView = ReturnType<typeof createAgentView>
