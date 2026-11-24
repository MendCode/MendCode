import type { SessionEvent } from "@mendcode/protocol"
import { createContinuity } from "./continuity"
import type { createSecrets } from "./secrets"
import type { AppContext } from "./context"
import { followPet } from "./pet-follow"
import { RELEASE_AT, RELEASE_KEEP } from "../../view/transcript"
import { KEPT_CATCH_UP, type KeptSession } from "./session-cache"

/** Opening a chat pages back until its transcript fills this many screens, at most this many pages. */
const FILL_SCREENS = 2
const FILL_PAGES = 6
/** Pages read back while the chat still shows nothing at all: a session is never opened on a blank screen while it has history. */
const EMPTY_PAGES = 400
/** Pages read back for the start of a turn the opening window cut in two (its closing line needs when it began). */
const CUT_TURN_PAGES = 8
const TURN_ENDS: ReadonlySet<string> = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"])

/**
 * The newest turn when it ends in these events without having started in them (a window of the newest events can begin in the
 * middle of a long turn): its closing line sits under the answer on screen. An older cut turn is above the fold and is
 * completed when its page is read.
 */
function newestTurnCut(events: readonly SessionEvent[]): Set<string> {
  const started = new Set<string>()
  let newest: string | undefined
  for (const event of events) {
    if (!("turnId" in event) || !event.turnId) continue
    if (event.type === "turn.started") started.add(event.turnId)
    else if (TURN_ENDS.has(event.type)) newest = event.turnId
  }
  return new Set(newest && !started.has(newest) ? [newest] : [])
}
/** The screen height assumed before the first frame has measured one. */
const MIN_SCREEN = 10
/** Screens above the viewport a release always keeps, besides the screen itself. */
const RELEASE_SCREENS = 3

export function createPaging(ctx: AppContext, actions: {
  chatWidth(): number
  noteSecretMarkers: ReturnType<typeof createSecrets>["noteSecretMarkers"]
  loadSecretTails: ReturnType<typeof createSecrets>["loadSecretTails"]
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
    const paging: AppContext["state"]["paging"] = input.events ? { firstSeq: 0, more: true, loading: true, ready: false, loadedEarlier: false, held: [], loaded: 0 } : undefined
    state.paging = paging
    let afterSeq = 0
    let cutTurns = new Set<string>()
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
        paging.loaded = reply.window.events.length
        paging.ready = true
        afterSeq = reply.window.lastSeq
        cutTurns = newestTurnCut(reply.window.events)
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
    await readCutTurns(transcript, cutTurns)
    await fillScreen(transcript)
  }

  /**
   * A turn of many events can begin before the opening window: its answer shows but its closing line (how long it took) needs the
   * `turn.started` that was left out. The pages before are read until the start is among them, a few at most.
   */
  async function readCutTurns(transcript: typeof state.transcript, cut: Set<string>) {
    for (let page = 0; page < CUT_TURN_PAGES && cut.size; page++) {
      const paging = state.paging
      if (state.transcript !== transcript || !paging?.ready || !paging.more) return
      const first = paging.firstSeq
      await loadEarlier()
      if (state.transcript !== transcript || state.paging?.firstSeq === first) return
      for (const turnId of lastPageStarts) cut.delete(turnId)
    }
  }

  /**
   * A chat kept from an earlier visit (session-cache.ts) is already on `state.transcript`: only the events after the last one it
   * holds are read (undo markers too, as a subscriber gets them) and applied the way an opening window is, quietly, then the
   * subscription goes on from there. "fallback" when it cannot be (the gap is more than one page, the log is shorter than what
   * it holds, the read failed): the caller opens the chat afresh. "left" when the reader switched away meanwhile.
   */
  async function resumeTranscript(kept: KeptSession): Promise<"resumed" | "fallback" | "left"> {
    const sessionId = state.sessionId
    const transcript = state.transcript
    const loadAfter = input.events?.loadAfter
    if (!loadAfter) return "fallback"
    const paging = { ...kept.paging, loading: true, ready: false, held: [] as SessionEvent[] }
    state.paging = paging
    const from = transcript.lastSeq
    let afterSeq = from
    try {
      const reply = await loadAfter(sessionId, from, KEPT_CATCH_UP)
      if (state.transcript !== transcript) return "left"
      if (!reply.ok && reply.error.code === "unknown_session" && await actions.recoverMissingSession()) return "left"
      if (!reply.ok || reply.window.more || reply.window.sessionLastSeq < from) return "fallback"
      // An undo or redo made while the chat was away: a fresh open shows the turns as they are now, with no marker of the change.
      if (reply.window.events.some((event) => event.type === "turn.reverted" || event.type === "turn.restored")) return "fallback"
      const width = chatWidth()
      const height = state.lastBodyHeight
      const scroll = kept.scroll
      const before = scroll.follow || !reply.window.events.length ? 0 : transcript.totalLines(width)
      const windowTop = transcript.olderBlocks
      for (const event of reply.window.events) {
        transcript.apply(event)
        state.turnState.apply(event)
        state.compactionFacts.apply(event)
        noteSecretMarkers(event)
      }
      afterSeq = Math.max(from, reply.window.lastSeq)
      paging.loaded += reply.window.events.length
      if (kept.secrets) void actions.loadSecretTails()
      if (scroll.follow) view.jump(sessionId, 0, 0)
      else {
        // As for live events: what came in meanwhile does not push the top of the window the reader was in.
        transcript.pinWindow(windowTop)
        const added = reply.window.events.length ? transcript.totalLines(width) - before : 0
        const offset = (scroll.anchor && transcript.offsetForAnchor(scroll.anchor, width, height)) ?? scroll.offset + added
        const local = view.get(sessionId)
        local.offset = Math.max(0, offset)
        local.follow = local.offset === 0
        local.unseen = local.follow ? 0 : scroll.unseen + Math.max(0, added)
      }
      paging.ready = true
    } catch {
      return state.transcript === transcript ? "fallback" : "left"
    } finally {
      if (state.transcript === transcript && paging.ready) {
        paging.loading = false
        for (const event of paging.held.splice(0)) replay(event)
        requestFrame()
      }
    }
    const reply = await input.subscribe?.(sessionId, afterSeq)
    if (state.transcript !== transcript) return "left"
    if (reply && !reply.ok && reply.error.code === "unknown_session" && await actions.recoverMissingSession()) return "left"
    if (reply && !reply.ok) fail(reply.error.message)
    void continuity.load()
    followPet(state)
    requestFrame()
    return "resumed"
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
      // Short of one screen the chat would sit at the top over an empty band (sub-agent and streaming records draw few rows a
      // page): reading goes on until it fills the screen. The second screen is the usual few pages at most.
      if (!blank && page >= FILL_PAGES && transcript.totalLines(width) >= height) return
      const first = paging.firstSeq
      await loadEarlier()
      if (state.transcript !== transcript || state.paging?.firstSeq === first) return
    }
  }

  let lastPageStarts: string[] = []

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
      lastPageStarts = reply.window.events.flatMap((event) => (event.type === "turn.started" ? [event.turnId] : []))
      if (!local.follow && anchor) {
        const offset = transcript.offsetForAnchor(anchor, width, height)
        if (offset !== undefined) local.offset = offset
      }
      for (const event of reply.window.events) noteSecretMarkers(event)
      paging.firstSeq = reply.window.firstSeq
      paging.more = reply.window.more
      paging.loadedEarlier = true
      paging.loaded = (paging.loaded ?? 0) + reply.window.events.length
    } catch (error) {
      if (sessionTranscript() === transcript) fail(error instanceof Error ? error.message : String(error))
    } finally {
      if (sessionTranscript() === transcript) {
        paging.loading = false
        requestFrame()
      }
    }
  }

  /**
   * With a sub-agent's thread open, the session's earlier pages matter only until the thread's start is among them: pages back until
   * it is (each page is 200 events of every kind, so one scroll could add nothing to the thread), then never again for it.
   */
  async function loadThreadStart() {
    const root = state.agentRoot
    const itemId = state.agentView
    if (!root || !itemId) return
    for (let page = 0; page < EMPTY_PAGES && !root.agentThreadLoaded(itemId); page++) {
      const first = state.paging?.firstSeq
      await loadEarlier()
      if (state.agentRoot !== root || state.agentView !== itemId || state.paging?.firstSeq === first) return
    }
  }

  /**
   * Back within a screen of the bottom (or following live output) after reading far up: the transcript lets go of the history above
   * its last `RELEASE_KEEP` blocks and paging restarts from the cut, so scrolling up fetches it again as the first time. Never while a
   * page is on its way, a sub-agent's thread is open, or the find bar or a selection counts rows from the transcript's top.
   */
  function releaseFar() {
    const paging = state.paging
    const transcript = state.transcript
    if (!paging?.ready || paging.loading || transcript.visibleCount < RELEASE_AT) return
    if (state.agentView !== undefined || state.agentRoot || state.find || state.selection) return
    const local = view.get(state.sessionId)
    const height = Math.max(MIN_SCREEN, state.lastBodyHeight)
    if (local.offset > height) return
    const cursor = transcript.release({ keep: RELEASE_KEEP, width: chatWidth(), rows: local.offset + height * RELEASE_SCREENS })
    if (cursor === undefined) return
    paging.firstSeq = cursor
    paging.more = true
  }

  return { openTranscript, resumeTranscript, loadEarlier, loadThreadStart, releaseFar }
}
