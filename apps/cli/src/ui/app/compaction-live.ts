import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import { SPINNER_FRAMES } from "../../view/tool-card"
import { advanceArcade, arcadeField, arcadeInput, isLoaded, pickGame, preload, renderLiveCompaction, startArcade } from "../lazy-pages"
import type { Line } from "../theme"
import type { AppContext } from "./context"

type Scratch = { top: number; left: number; width: number; rows: number; first: number; cursor?: { row: number; col: number } }

/**
 * The panel shown above the prompt while the context is being compacted (`compactionPanel` in /customize): a framed
 * progress panel, a stats chart, an arcade of small games, the project scratchpad or one quiet line. This is its
 * controller: it loads the panel code on the first compaction, starts a random game, ticks it from the render
 * loop's frames (never from a timer of its own), owns the keyboard only while the arcade has focus, and lets go of
 * everything the moment the compaction is over.
 */
export function createCompactionLive(ctx: AppContext, actions: { editScratch(): Promise<void>; endScratchEdit(): void; ensureScratch(): Promise<void> }) {
  const { input, state, random, editor, requestFrame } = ctx
  const live = state.compactionLive
  /** The width and rows the last frame offered, so `n` can start the next game on the same field. */
  let fitted = { width: 0, room: 0 }
  let arcadeShown = false

  const mode = () => (state.mode === "minimal" ? "quiet" : state.tuiProfile.compactionPanel)
  const visible = () => state.page === "chat" && state.transcript.foreground === "compacting"
  const moduleName = () => (mode() === "arcade" ? "compactionArcade" : "compactionLive")

  function rememberBest() {
    const session = live.session
    if (session) live.best[session.definition.id] = Math.max(live.best[session.definition.id] ?? 0, session.instance.best)
  }

  function startGame(avoid?: string) {
    rememberBest()
    live.session = undefined
    const definition = pickGame(random, avoid)
    const field = arcadeField(definition, fitted.width, fitted.room)
    if (field) live.session = startArcade({ definition, ...field, random, best: live.best[definition.id] ?? 0, frame: state.spinFrame })
  }

  /** Lets go of the game, the keyboard and the scratchpad editor the panel was holding. */
  function stop() {
    rememberBest()
    live.session = undefined
    live.focused = false
    live.area = undefined
    arcadeShown = false
    if (live.scratchPanel) {
      live.scratchPanel = false
      if (state.editingScratch && !state.dockOpen) actions.endScratchEdit()
    }
  }

  /** Once per frame before drawing: loads the panel code, and plays the frames since the last one while the arcade has focus. */
  function sync() {
    if (!visible()) {
      if (live.session || live.focused || live.scratchPanel || live.area) stop()
      return
    }
    const name = moduleName()
    if (!isLoaded(name) && !live.loading) live.loading = preload(name).catch(() => undefined).then(() => { live.loading = undefined; requestFrame() })
    if (mode() !== "arcade" && live.session) {
      rememberBest()
      live.session = undefined
      live.focused = false
    }
    if (live.session) {
      if (live.focused) advanceArcade(live.session, state.spinFrame)
      else live.session.frame = state.spinFrame
    }
  }

  /** The panel's rows for `width` columns and at most `room` rows, margin included; undefined when nothing shows. */
  function rows(request: { width: number; room: number }): { rows: Line[]; scratch?: Scratch } | undefined {
    live.scratchPanel = false
    arcadeShown = false
    if (!visible() || !isLoaded(moduleName()) || request.room < 1) {
      live.area = undefined
      return undefined
    }
    const width = Math.max(1, request.width - PROMPT_MARGIN * 2)
    fitted = { width, room: request.room }
    if (mode() === "arcade" && !live.session) startGame()
    const chosen = mode() === "arcade" && !live.session ? "panel" : mode()
    if (chosen === "scratchpad") void actions.ensureScratch()
    const session = live.session
    const view = chosen === "arcade" && session ? session.instance.view({ focused: live.focused }) : undefined
    const out = renderLiveCompaction({
      mode: chosen,
      width,
      maxRows: request.room,
      facts: state.compactionFacts.snapshot(),
      ...(state.compactionFacts.lastCall ? { lastCall: state.compactionFacts.lastCall } : {}),
      limit: state.contextReport?.contextWindow ? { tokens: state.contextReport.contextWindow, kind: "window" } : { tokens: state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS, kind: "threshold" },
      now: ctx.now(),
      spinner: state.reducedMotion ? "⋯" : SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length]!,
      ...(view ? { arcade: { view, focused: live.focused, fieldRows: view.rows.length } } : {}),
      scratch: { text: state.scratchNote, editing: state.editingScratch !== undefined, editor: ctx.scratchEditor, readOnly: input.remote?.readOnly === true },
    })
    arcadeShown = out.mode === "arcade" && view !== undefined
    live.scratchPanel = out.mode === "scratchpad" && out.scratch !== undefined
    if (live.focused && !arcadeShown) live.focused = false
    const margin = { text: " ".repeat(PROMPT_MARGIN) }
    const scratch = out.scratch ? { ...out.scratch, left: out.scratch.left + PROMPT_MARGIN, ...(out.scratch.cursor ? { cursor: { row: out.scratch.cursor.row, col: out.scratch.cursor.col + PROMPT_MARGIN } } : {}) } : undefined
    return { rows: out.rows.map((line): Line => [margin, ...line]), ...(scratch ? { scratch } : {}) }
  }

  /** Whether the keyboard goes to the game: the prompt sees nothing while this is true. */
  const focused = () => live.focused && visible()

  /** Tab on an empty prompt puts the arcade or the scratchpad editor in focus. */
  async function enterKey(key: string): Promise<boolean> {
    if (key !== "\t" || !visible() || !editor.isEmpty()) return false
    if (live.scratchPanel) {
      await actions.editScratch()
      return true
    }
    if (arcadeShown && live.session) {
      live.focused = true
      requestFrame()
      return true
    }
    return false
  }

  /** A key while the arcade has focus: moves, space, `r`, `n` for another game, Esc/q/Tab/ctrl+c to leave. Anything else is ignored. */
  function playKey(key: string) {
    const session = live.session
    if (!visible() || !session) {
      live.focused = false
      return requestFrame()
    }
    const action = arcadeInput(key)
    if (action?.type === "leave") live.focused = false
    else if (action?.type === "next") startGame(session.definition.id)
    else if (action) {
      session.instance.key(action.key)
      // Reduced motion draws no frames of its own, so each move key is also one step of the game.
      if (state.reducedMotion && session.definition.ticks && action.key !== "restart" && action.key !== "space") session.instance.tick()
    }
    requestFrame()
  }

  /** A click inside the panel focuses the arcade; a click anywhere else lets it go. The scratchpad has its own click handler. */
  function click(point: { row: number; col: number }): boolean {
    const area = live.area
    const inside = area !== undefined && point.row >= area.top && point.row < area.top + area.rows && point.col >= 0 && point.col < area.width
    if (inside && arcadeShown && live.session && !live.focused) {
      live.focused = true
      return true
    }
    if (!inside && live.focused) {
      live.focused = false
      return true
    }
    return false
  }

  /** The panel's screen position, set by the chat layout once it knows where the rows landed. */
  function place(area: { top: number; rows: number; width: number } | undefined) {
    live.area = area
  }

  return { sync, rows, place, focused, enterKey, playKey, click, mode, visible }
}
