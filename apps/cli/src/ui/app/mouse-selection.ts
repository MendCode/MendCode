import type { ItemId } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { graphemes } from "../../view/editor"
import { quoteWithComment } from "../../view/quote"
import { draftRefs } from "../../view/attachments"
import { offsetForThumb } from "../../view/scroll-chrome"
import { findLinks } from "../../view/links"
import { areaAt,belowPrompt, bodyPoint, bodyText, dragEdge, footerRow, footerText, lineSpan, mouseEvent, promptOffsetAt, promptRange, rowText, wordSpan, wrappedRows, wrappedTextAt, type Point, type Selection, type SelectionMap } from "../selection"

/** A second press this close (in time) to the last one, on the same cell, is a double click; a third is a triple click. */
export const DOUBLE_CLICK_MS = 450

/** A drag past the transcript's edge moves it this often, and by at most this many rows a step (the farther the pointer, the faster). */
export const AUTOSCROLL_MS = 50
const AUTOSCROLL_MAX_ROWS = 3

/** Select text with the mouse in the transcript or the prompt; releasing copies it (OSC 52) when `copyOnSelect` is on. */
export function createMouseSelection(ctx: AppContext, scroll: { by: (rows: number) => void; width: () => number; offset: () => number; fold: (itemId: ItemId, ordinal: number) => void; /** A click on a card of the chat: true when it opened something of its own (a sub-agent). */ card?: (itemId: ItemId) => boolean; /** A click on `text[at]` of a transcript line: true when it is a file path that was opened (docs/file-viewer.md). */ openPath?: (text: string, at: number) => boolean; /** A click on an http/https address: the browser opens it (the terminal never sees the click while the mouse is reported). */ openUrl?: (url: string) => void; /** A click on a generated image's `open` or `folder` button. */ openImage?: (path: string, reveal: boolean) => void }) {
  const { state, editor, requestFrame, copyText } = ctx
  let timer: ReturnType<typeof setInterval> | undefined
  /** A drag that holds the scrollbar's thumb: how many cells below the thumb's first cell the press landed. */
  let thumbDrag: { grab: number } | undefined
  /** The last press: when and where it was and how many presses in a row (1 to 3) it ended a streak of. */
  let lastPress: { at: number; row: number; col: number; count: number } | undefined
  let clicks = 1

  function pressCount(point: Point): number {
    const at = ctx.now()
    const same = lastPress && lastPress.row === point.row && lastPress.col === point.col && at - lastPress.at <= DOUBLE_CLICK_MS && lastPress.count < 3
    lastPress = { at, row: point.row, col: point.col, count: same ? lastPress!.count + 1 : 1 }
    return lastPress.count
  }

  /** The word (double click) or the wrapped line (triple click) under `point`, as a selection; undefined when there is no text there. */
  function clickSelection(map: SelectionMap, point: Point, area: Selection["area"], count: number): Selection | undefined {
    if (area === "footer") {
      const text = footerRow(map, point.row)
      const span = count === 2 ? wordSpan(text, point.col) : lineSpan(text)
      return span ? { anchor: { row: point.row, col: span[0] }, focus: { row: point.row, col: span[1] - 1 }, area, moved: true } : undefined
    }
    if (area === "body") {
      const at = bodyPoint(map, point)
      if (count === 2) {
        const span = wordSpan(rowText(map, at.row), at.col)
        return span ? { anchor: { row: at.row, col: span[0] }, focus: { row: at.row, col: span[1] - 1 }, area, moved: true } : undefined
      }
      const [top, bottom] = wrappedRows(map, at.row)
      const end = lineSpan(rowText(map, bottom))
      return end && rowText(map, top).trim() ? { anchor: { row: top, col: 0 }, focus: { row: bottom, col: end[1] - 1 }, area, moved: true } : undefined
    }
    const line = map.promptLines[map.promptFirst + point.row - map.promptTop]
    if (!line) return undefined
    const span = count === 2 ? wordSpan(line.text, point.col - map.promptInset) : lineSpan(line.text)
    return span ? { anchor: { row: point.row, col: map.promptInset + span[0] }, focus: { row: point.row, col: map.promptInset + span[1] - 1 }, area, moved: true } : undefined
  }

  function openPathAt(map: SelectionMap, point: Point): boolean {
    if (!scroll.openPath) return false
    const under = wrappedTextAt(map, point)
    return !!under && scroll.openPath(under.text, under.at)
  }

  /** The http/https address under `point` in the transcript, whole even where the layout wrapped it. */
  function urlAt(map: SelectionMap, point: Point): string | undefined {
    const under = wrappedTextAt(map, point)
    return under ? findLinks(under.text, { cwd: "", opener: "none" }).find((link) => under.at >= link.start && under.at < link.end)?.uri : undefined
  }

  /** The prompt's cursor goes to grapheme `offset` (a click); `extend` keeps the selection from where the cursor was (shift+click). */
  function placeCursor(offset: number, extend: boolean) {
    if (extend) editor.moveTo(offset, true)
    else ctx.vim.place(offset)
    requestFrame()
  }

  function selectedText(selection: Selection): string {
    const map = state.selectionMap
    if (!map) return ""
    if (selection.area === "body") return bodyText(map, selection)
    if (selection.area === "footer") return footerText(map, selection)
    const range = promptRange(map, selection)
    return range ? graphemes(editor.text).slice(range.start, range.end).join("") : ""
  }

  /** Copies the selection and drops it. */
  function copySelection(selection: Selection) {
    stopAutoscroll()
    state.selection = undefined
    const text = selectedText(selection)
    if (text && selection.area === "body") state.copiedBody = { text, at: ctx.now() }
    // A passage of an answer may be commented on: the toast says so and the offer stays for a few seconds (docs/editor.md).
    if (text && !(selection.area === "body" && ctx.comments.copied(selection, text, (hint, ms) => copyText(text, `${text.length} chars`, { ...(hint ? { hint } : {}), ...(ms !== undefined ? { ms } : {}) })))) copyText(text, `${text.length} chars`)
    requestFrame()
  }

  function stopAutoscroll() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  /** One autoscroll step: the transcript moves toward the pointer; the page and the selection decide when it is over. */
  function autoscroll() {
    const selection = state.selection
    const map = state.selectionMap
    const edge = selection?.pointer && map ? dragEdge(map, selection.pointer) : undefined
    if (!selection || !edge || state.page !== "chat") return stopAutoscroll()
    scrollUnder(-edge.direction * Math.min(AUTOSCROLL_MAX_ROWS, edge.distance))
    requestFrame()
  }

  /** The transcript moves by `rows` under a transcript selection, which keeps its text (a drag's focus follows the pointer on the next frame); any other selection is dropped. */
  function scrollUnder(rows: number) {
    const selection = state.selection
    if (selection?.area !== "body" || state.page !== "chat") {
      state.selection = undefined
      return scroll.by(rows)
    }
    const before = state.transcript.olderBlocks
    const total = state.transcript.totalLines(scroll.width())
    scroll.by(rows)
    // The button is held: the text scrolled under the pointer is selected even if the mouse itself never moved.
    if (selection.pointer && !selection.moved) state.selection = { ...selection, moved: true }
    // Older blocks laid out above shift every transcript row down: the selection keeps its text.
    if (state.transcript.olderBlocks < before) {
      const added = state.transcript.totalLines(scroll.width()) - total
      state.selection = { ...selection, anchor: { ...selection.anchor, row: selection.anchor.row + added }, focus: { ...selection.focus, row: selection.focus.row + added } }
    }
  }

  function startAutoscroll() {
    if (timer) return
    timer = setInterval(autoscroll, AUTOSCROLL_MS)
    timer.unref?.()
    autoscroll()
  }

  /**
   * One mouse report on the chat page; `offset` is the sidebar's width when it is on the left. True when the report is used up:
   * a press goes on to the page's own click handling, since it only arms a selection until the mouse moves.
   */
  function onMouse(key: string, offset: number): boolean {
    const map = state.selectionMap
    const event = mouseEvent(key)
    if (!event || !map) return false
    const point = { row: event.point.row, col: event.point.col - offset }
    // The scrollbar's thumb follows the pointer while it is held; nothing else sees those reports.
    if (thumbDrag) {
      const bar = map.scrollbar
      if (event.kind === "drag" && bar) {
        scroll.by(offsetForThumb({ rows: bar.rows, total: bar.total, viewport: bar.viewport, top: point.row - bar.top - thumbDrag.grab }) - scroll.offset())
        requestFrame()
      } else if (event.kind !== "drag") thumbDrag = undefined
      return true
    }
    if (event.kind === "press") {
      stopAutoscroll()
      // The scrollbar is a control too: a press on the thumb grabs it, a press on the track pages toward it.
      const bar = map.scrollbar
      if (bar && point.col === bar.col && point.row >= bar.top && point.row < bar.top + bar.rows) {
        state.selection = undefined
        lastPress = undefined
        const at = point.row - bar.top
        if (at >= bar.thumb.top && at < bar.thumb.top + bar.thumb.length) thumbDrag = { grab: at - bar.thumb.top }
        else scroll.by(at < bar.thumb.top ? Math.max(1, bar.viewport - 1) : -Math.max(1, bar.viewport - 1))
        requestFrame()
        return true
      }
      // The "jump to latest" label is a button: one press follows the newest output again.
      if (map.jump && point.row === map.jump.row && point.col >= map.jump.from && point.col < map.jump.to) {
        state.selection = undefined
        lastPress = undefined
        scroll.by(-Number.MAX_SAFE_INTEGER)
        requestFrame()
        return true
      }
      // The comment chips, the offer's pill and the margin marks of commented passages are controls too; a press anywhere else ends an offer.
      if (ctx.comments.areaClick(point) || ctx.comments.bodyClick(point)) {
        state.selection = undefined
        lastPress = undefined
        requestFrame()
        return true
      }
      ctx.comments.dismiss()
      clicks = pressCount(point)
      const area = areaAt(map, point)
      const had = state.selection !== undefined
      // A press in the prompt puts the text cursor there (shift extends the selection from it; the border under the text means the end of it).
      // The press still arms a drag selection, which exists only once the mouse moves.
      if (area === "prompt") {
        placeCursor(promptOffsetAt(map, point), event.shift === true)
        if (event.shift || belowPrompt(map, point)) {
          state.selection = undefined
          requestFrame()
          return true
        }
      }
      state.selection = area ? { anchor: area === "body" ? bodyPoint(map, point) : point, focus: area === "body" ? bodyPoint(map, point) : point, area, moved: false, ...(area === "body" ? { pointer: point } : {}) } : undefined
      if (had) requestFrame()
      return false
    }
    const selection = state.selection
    if (!selection) return false
    if (event.kind === "drag") {
      const focus = selection.area === "body" ? bodyPoint(map, point) : point
      const anchor = selection.anchor
      if (selection.moved || focus.row !== anchor.row || focus.col !== anchor.col || (selection.area === "body" && dragEdge(map, point))) {
        state.selection = { ...selection, focus, moved: true, ...(selection.area === "body" ? { pointer: point } : {}) }
        if (selection.area === "body" && dragEdge(map, point)) startAutoscroll()
        else stopAutoscroll()
        requestFrame()
      }
      return true
    }
    stopAutoscroll()
    // A plain click on the footer is not a selection: its own controls (a segment someone clicks) get it.
    if (!selection.moved && selection.area === "footer" && clicks < 2) {
      state.selection = undefined
      return false
    }
    // A click without a drag selects nothing; on the summary of a `<details>` block it folds or opens that block.
    if (!selection.moved) {
      state.selection = undefined
      const line = selection.area === "body" ? map.body[point.row - map.bodyTop] : undefined
      const fold = line?.fold
      let url: string | undefined
      const button = line?.copy?.find((region) => point.col >= region.from && point.col < region.to)
      if (button && bodyPoint(map, point).row === selection.anchor.row) {
        if (button.open) scroll.openImage?.(button.text, button.open === "folder")
        else copyText(button.text, button.label)
        requestFrame()
      // A first click on a web address opens it in the browser.
      } else if (selection.area === "body" && clicks === 1 && scroll.openUrl && bodyPoint(map, point).row === selection.anchor.row && (url = urlAt(map, point))) {
        scroll.openUrl(url)
        requestFrame()
      // A first click on a file path opens it in the viewer, wherever it is drawn (a tool card's title included: the rest of that row still folds the card).
      } else if (selection.area === "body" && clicks === 1 && bodyPoint(map, point).row === selection.anchor.row && openPathAt(map, point)) {
        requestFrame()
      // A sub-agent's call opens that sub-agent, whether or not the card has anything to fold.
      } else if (selection.area === "body" && clicks === 1 && line?.itemId && bodyPoint(map, point).row === selection.anchor.row && scroll.card?.(line.itemId as ItemId)) {
        requestFrame()
      // A row below a card's header folds it too; the second press of a double click on such a row selects a word instead of toggling the card back.
      } else if (fold && !(clicks >= 2 && map.body[point.row - map.bodyTop - 1]?.fold?.itemId === fold.itemId) && bodyPoint(map, point).row === selection.anchor.row) scroll.fold(fold.itemId as ItemId, fold.ordinal)
      else if (clicks >= 2) {
        const picked = clickSelection(map, point, selection.area, clicks)
        if (picked && state.tuiProfile.copyOnSelect) copySelection(picked)
        else if (picked) {
          state.selection = picked
          requestFrame()
        }
      }
      return true
    }
    // Released past the edge, the focus is where the autoscroll left it: the pointer's row is not a transcript row.
    const focus = selection.area === "body" ? (dragEdge(map, point) ? selection.focus : bodyPoint(map, point)) : point
    const { pointer: _pointer, ...rest } = selection
    const released: Selection = { ...rest, focus }
    if (state.tuiProfile.copyOnSelect) copySelection(released)
    else {
      state.selection = released
      requestFrame()
    }
    return true
  }

  /** Any key while a selection is kept: ctrl+c copies it, everything else drops it and goes on. True when the key was used. */
  function onKey(key: string): boolean {
    const selection = state.selection
    if (!selection) return false
    if (key === "\x03" && selection.moved) {
      copySelection(selection)
      return true
    }
    stopAutoscroll()
    state.selection = undefined
    requestFrame()
    return false
  }

  function quote() {
    const selection = state.selection
    if (!selection?.moved || selection.area !== "body") return ctx.say("Select transcript text first (Copy on select off)", "warning")
    const text = selectedText(selection)
    if (!text.trim()) return
    editor.replaceAll(quoteWithComment(text, editor.text))
    ctx.drafts.changed(state.sessionId, { text: editor.text, images: draftRefs(state.attachments, editor.text) })
    state.selection = undefined
    stopAutoscroll()
    ctx.say("quote ready · add a comment", "success", { quiet: true })
    requestFrame()
  }

  /** The pointer moved to screen `row`/`col` (chat column): the web address under it is underlined and the pointer becomes a hand (OSC 22). */
  function hover(row: number, col: number): void {
    const map = state.selectionMap
    const inBody = !!map && row >= map.bodyTop && row < map.bodyTop + map.body.length && !state.selection
    const link = inBody && scroll.openUrl ? urlAt(map!, { row, col }) : undefined
    if (link === state.hoverLink) return
    state.hoverLink = link
    ctx.input.screen.write?.(link ? "\x1b]22;pointer\x1b\\" : "\x1b]22;default\x1b\\")
    requestFrame()
  }

  return { onMouse, onKey, quote, scrollUnder, hover }
}
