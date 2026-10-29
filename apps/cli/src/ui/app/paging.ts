import type { SessionEvent } from "@mendcode/protocol"
import { createContinuity } from "./continuity"
import type { createSecrets } from "./secrets"
import type { AppContext } from "./context"
import { followPet } from "./pet-follow"

/** Opening a chat pages back until its transcript fills this many screens, at most this many pages. */
const FILL_SCREENS = 2
const FILL_PAGES = 6
/** Pages read back while the chat still shows nothing at all: a session is never opened on a blank screen while it has history. */
const EMPTY_PAGES = 400
/** The screen height assumed before the first frame has measured one. */
const MIN_SCREEN = 10

export function createPaging(ctx: AppContext, actions: {
  chatWidth(): number
  noteSecretMarkers: ReturnType<typeof createSecrets>["noteSecretMarkers"]
  /** Handles one live event as if it had just arrived (the app's own `onEvent`). */
  replay(event: SessionEvent): void
  /** The session this terminal holds is gone from the daemon: moves to the project's blank chat; false when it could not. */
  recoverMissingSession(): Promise<boolean>
}) {
  const { input, state, view, fail, requestFrame } = ctx
  const { chatWidth, noteSecretMarkers, replay } = actions
  const continuity = createContinuity(ctx)

  async function openTranscript() {
    const sessionId = state.sessionId
    const transcript = state.transcript
    view.jump(sessionId, 0, 0)
    const paging = input.events ? { firstSeq: 0, more: true, loading: true, ready: false, loadedEarlier: false, held: [] } : undefined
    state.paging = paging
    let afterSeq = 0
    if (input.events && paging) {
      requestFrame()
      try {
        const reply = await input.events.loadWindow(sessionId)
        if (state.transcript !== transcript) return
        // A session the daemon no longer has (it removes the blank chats when it starts) is replaced by the project's blank chat, not reported.
        if (!reply.ok && reply.error.code === "unknown_session" && await actions.recoverMissingSession()) return
        if (!reply.ok) return fail(reply.error.message)
        for (const event of reply.window.events) {
          transcript.apply(event)
          state.turnState.apply(event)
          noteSecretMarkers(event)
        }
        paging.firstSeq = reply.window.firstSeq
        paging.more = reply.window.more
        paging.ready = true
        afterSeq = reply.window.lastSeq
      } catch (error) {
        if (state.transcript === transcript) fail(error instanceof Error ? error.message : String(error))
        return
      } finally {
        if (state.transcript === transcript) {
          paging.loading = false
          // Events that came in while the window was on its way follow it; the transcript drops any the window already carried.
          for (const event of paging.held.splice(0)) replay(event)
          requestFrame()
        }
      }
    }
    if (state.transcript !== transcript) return
    const reply = await input.subscribe?.(sessionId, afterSeq)
    if (state.transcript !== transcript) return
    if (reply && !reply.ok && reply.error.code === "unknown_session" && await actions.recoverMissingSession()) return
    if (reply && !reply.ok) fail(reply.error.message)
    void continuity.load()
    followPet(state)
    requestFrame()
    await fillScreen(transcript)
  }

  /** A window is counted in raw events, so a session of long turns can open on little more than its last exchange: page back until the screen is full. */
  async function fillScreen(transcript: typeof state.transcript) {
    for (let page = 0; page < EMPTY_PAGES; page++) {
      const paging = state.paging
      if (state.transcript !== transcript || !paging?.ready || !paging.more || transcript.olderBlocks > 0) return
      const width = chatWidth()
      const height = Math.max(MIN_SCREEN, state.lastBodyHeight)
      if (transcript.totalLines(width) >= height * FILL_SCREENS) return
      // A window of events that draw nothing (a run of status, usage or housekeeping records) leaves the chat blank: reading goes on
      // until something shows. Once something does, the usual few pages are the limit.
      const blank = !transcript.viewport(width, height, 0).some((line) => line.text.trim())
      if (!blank && page >= FILL_PAGES) return
      const first = paging.firstSeq
      await loadEarlier()
      if (state.transcript !== transcript || state.paging?.firstSeq === first) return
    }
  }

  async function loadEarlier() {
    const paging = state.paging
    if (!input.events || !paging?.ready || paging.loading || !paging.more) return
    const sessionId = state.sessionId
    // The session's own transcript: a sub-agent's thread opened meanwhile is a view over it, not another conversation.
    const sessionTranscript = () => state.agentRoot ?? state.transcript
    const transcript = sessionTranscript()
    paging.loading = true
    requestFrame()
    try {
      const reply = await input.events.loadBefore(sessionId, paging.firstSeq)
      if (sessionTranscript() !== transcript) return
      if (!reply.ok) return fail(reply.error.message)
      // Capture when the reply lands: the reader may have scrolled or live output may have arrived while it waited.
      const local = view.get(sessionId)
      const width = chatWidth()
      const height = state.lastBodyHeight
      const rows = transcript.viewport(width, height, local.offset)
      const screenRow = rows.findIndex((line) => line.itemId !== undefined && line.row !== undefined)
      const line = rows[screenRow]
      // The scroll belongs to whatever is on screen: with a thread open, the session's rows are not what the reader looks at.
      const anchor = !state.agentRoot && line?.itemId !== undefined && line.row !== undefined ? { itemId: line.itemId, row: line.row, screenRow } : undefined
      transcript.prepend(reply.window.events)
      if (!local.follow && anchor) {
        const offset = transcript.offsetForAnchor(anchor, width, height)
        if (offset !== undefined) local.offset = offset
      }
      for (const event of reply.window.events) noteSecretMarkers(event)
      paging.firstSeq = reply.window.firstSeq
      paging.more = reply.window.more
      paging.loadedEarlier = true
    } catch (error) {
      if (sessionTranscript() === transcript) fail(error instanceof Error ? error.message : String(error))
    } finally {
      if (sessionTranscript() === transcript) {
        paging.loading = false
        requestFrame()
      }
    }
  }

  return { openTranscript, loadEarlier }
}
