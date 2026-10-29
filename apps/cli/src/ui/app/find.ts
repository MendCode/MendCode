import { centerOffset, findBar, findMatches, FIND_MAX_QUERY, type FindState } from "../../view/find"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import { MOUSE_SGR } from "./constants"
import type { AppContext } from "./context"

const PRINTABLE = /^[^\x00-\x1f\x7f\x1b]+$/
/** Keys the bar leaves to the transcript: the mouse wheel and the paging keys keep scrolling while it is open. */
const SCROLL_KEYS = new Set(["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[F", "\x1bOF", "\x1b[4~"])
const SHIFT_ENTER = new Set(["\x1b[13;2u", "\x1b[27;2;13~"])

/** Find in the transcript (ctrl+f, `/find`): type to highlight hits, move between them, esc closes. */
export function createFind(ctx: AppContext, actions: { chatWidth(): number }) {
  const { state, view, requestFrame } = ctx

  /** Every laid-out line of the window, top to bottom, the same rows the viewport scrolls over. */
  function windowLines(width: number) {
    const transcript = state.transcript
    return transcript.blocks().slice(transcript.olderBlocks).flatMap((block) => transcript.blockLines(block.itemId, width))
  }

  function recompute(find: FindState, keep?: { line: number; from: number }) {
    const width = actions.chatWidth()
    // A hit inside a folded run or a capped tool body is shown by opening it while the bar is up.
    state.transcript.revealFind(find.prompts ? "" : find.query, width)
    const lines = windowLines(width)
    find.width = width
    find.total = lines.length
    find.seen = state.transcript.totalLines(width)
    find.revision = state.transcript.revision
    find.matches = findMatches(lines, find.query, find.prompts)
    const kept = keep ? find.matches.findIndex((match) => match.line === keep.line && match.from === keep.from) : -1
    // A new query lands on the newest hit: it is the one nearest the prompt.
    find.index = kept >= 0 ? kept : Math.max(0, find.matches.length - 1)
  }

  function jump(find: FindState) {
    const match = find.matches[find.index]
    if (!match) return
    state.clearFrom = undefined
    const body = Math.max(1, state.lastBodyHeight)
    view.jump(state.sessionId, centerOffset(find.total, match.line, body), Math.max(0, find.total - body))
  }

  function open(query = "") {
    const transcript = state.transcript
    // Search covers every loaded block, not only the laid-out window.
    while (transcript.olderBlocks > 0 && transcript.loadOlder() > 0);
    const find: FindState = { query: query.slice(0, FIND_MAX_QUERY), prompts: false, matches: [], index: 0, width: 0, total: 0, seen: 0 }
    state.find = find
    recompute(find)
    jump(find)
    requestFrame()
  }

  function close() {
    state.transcript.endFind()
    state.find = undefined
    requestFrame()
  }

  function step(find: FindState, delta: number) {
    if (!find.matches.length) return
    find.index = (find.index + delta + find.matches.length) % find.matches.length
    jump(find)
  }

  function change(find: FindState, query: string, prompts = find.prompts) {
    find.query = query.slice(0, FIND_MAX_QUERY)
    find.prompts = prompts
    recompute(find)
    jump(find)
  }

  /** Handles a key while the bar is open; false lets it through (scrolling keys, the mouse). */
  async function key(raw: string) {
    const find = state.find
    if (!find) return false
    if (MOUSE_SGR.test(raw) || SCROLL_KEYS.has(raw)) return false
    if (raw === "\x1b" || raw === "\x03") close()
    else if (SHIFT_ENTER.has(raw) || raw === "\x1b[A" || raw === "\x1bOA") step(find, -1)
    else if (raw === "\r" || raw === "\x1b[B" || raw === "\x1bOB" || raw === "\x0e" || raw === "\x06") step(find, 1)
    else if (raw === "\t") change(find, find.query, !find.prompts)
    else if (raw === "\x7f" || raw === "\b") change(find, [...find.query].slice(0, -1).join(""))
    else if (raw === "\x15") change(find, "")
    else if (PRINTABLE.test(raw)) change(find, find.query + raw)
    requestFrame()
    return true
  }

  /** Pasted text goes into the query as one line. */
  function paste(text: string) {
    const find = state.find
    if (!find) return false
    change(find, find.query + text.replace(/\s+/g, " "))
    requestFrame()
    return true
  }

  /** The bar row for a frame `width` wide, after bringing the hits up to date with the transcript (streaming adds lines). */
  function bar(width: number) {
    const find = state.find
    if (!find) return undefined
    // The hits were laid out at the transcript's width (the scrollbar's column left out), not the bar's; text that changed
    // without changing the height (a streamed word, an edited message) moves the revision.
    const laidOut = actions.chatWidth()
    if (find.width !== laidOut || find.seen !== state.transcript.totalLines(laidOut) || find.revision !== state.transcript.revision) {
      const current = find.matches[find.index]
      recompute(find, current)
    }
    return findBar({ state: find, width, margin: PROMPT_MARGIN })
  }

  return { open, close, key, paste, bar }
}
