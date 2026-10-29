import type { ItemId } from "@mendcode/protocol"
import { FOLD_CARD, FOLD_PAGE } from "../../view/tool-frame"
import type { AppContext } from "./context"

/** A second click on a card's footer this soon after the click that opened it is an accident. */
const SETTLE_MS = 600

/**
 * Folds and opens one `<details>` block of an assistant message on its own: a click on its summary row, or the details key
 * (`ctrl+x f`) at the block nearest the middle of the screen. ctrl+o still opens every block (and the tool output) at once.
 */
export function createDetails(ctx: AppContext, actions: { chatWidth: () => number }) {
  const { state, view, say, requestFrame } = ctx

  /**
   * A tool card's header: its row in its block and, when it is on screen, its row in the body. Opening a card grows it below the
   * header, and a view that follows the bottom would slide the header up (off the screen for a card taller than the body) and leave
   * the card's end in view; closing a card clicked far below its header (which is scrolled off) would land anywhere. A header that is
   * off screen has no `screenRow`.
   */
  function headerOf(itemId: ItemId) {
    const width = actions.chatWidth()
    const row = state.transcript.blockLines(itemId, width).find((line) => line.fold === FOLD_CARD)?.row
    if (row === undefined) return undefined
    const top = state.selectionMap?.body.findIndex((line) => line !== undefined) ?? -1
    const shown = state.transcript.viewport(width, state.lastBodyHeight, view.get(state.sessionId).offset).findIndex((entry) => entry.itemId === itemId && entry.row === row)
    return { row, ...(shown >= 0 && top >= 0 ? { screenRow: top + shown } : {}) }
  }

  /** After a card opens, closes or turns a page: the header stays where it was, or goes near the top of the body when the card no longer fits under it or it was off screen. */
  function keepHeader(itemId: ItemId, before: { screenRow?: number; row: number }) {
    const width = actions.chatWidth()
    const height = state.lastBodyHeight
    const rows = state.transcript.blockLines(itemId, width).length
    const was = before.screenRow ?? 1
    // Never row 0: a pinned prompt takes the first row once the view has scrolled, and would hide the header.
    const screenRow = Math.max(1, was + rows <= height ? was : 0)
    const offset = state.transcript.offsetForAnchor({ itemId, row: before.row, screenRow }, width, height)
    if (offset !== undefined) view.jump(state.sessionId, offset, Math.max(0, state.transcript.totalLines(width) - height))
  }

  /** The card a click just opened or closed, and when: the click that follows it within `SETTLE_MS` is the second half of a double click. */
  let settling: { itemId: ItemId; at: number } | undefined

  /**
   * A mouse click on a fold. A card that has just opened can have its footer under the pointer (a card at the bottom of the view
   * has nowhere else to grow), so a quick second click on it would turn the page by accident; it is dropped.
   */
  function click(itemId: ItemId, ordinal: number) {
    const at = ctx.now()
    if (ordinal === FOLD_PAGE && settling?.itemId === itemId && at - settling.at < SETTLE_MS) return
    settling = ordinal === FOLD_CARD ? { itemId, at } : undefined
    toggle(itemId, ordinal)
  }

  function toggle(itemId: ItemId, ordinal: number) {
    const isCard = (ordinal === FOLD_CARD || ordinal === FOLD_PAGE) && state.transcript.blocks().some((block) => block.itemId === itemId && block.kind === "tool_call")
    const card = isCard ? headerOf(itemId) : undefined
    state.transcript.toggleDetails(itemId, ordinal)
    if (card) keepHeader(itemId, card)
    requestFrame()
  }

  /** The summary rows on screen with their message and their position in the document, top to bottom. */
  function visibleFolds() {
    const rows = state.transcript.viewport(actions.chatWidth(), state.lastBodyHeight, view.get(state.sessionId).offset)
    return rows.flatMap((line, at) => (line.itemId !== undefined && line.fold !== undefined ? [{ at, itemId: line.itemId, ordinal: line.fold, rows: rows.length }] : []))
  }

  /** The key: the summary nearest the middle of the transcript on screen (the lower one on a tie). False when none is visible. */
  function toggleFocused(): boolean {
    const folds = visibleFolds()
    const middle = ((folds[0]?.rows ?? 1) - 1) / 2
    const target = folds.reduce<(typeof folds)[number] | undefined>((best, fold) => (!best || Math.abs(fold.at - middle) <= Math.abs(best.at - middle) ? fold : best), undefined)
    if (!target) {
      say("no <details> block in view", "info")
      return false
    }
    toggle(target.itemId, target.ordinal)
    return true
  }

  return { toggle, click, toggleFocused }
}
