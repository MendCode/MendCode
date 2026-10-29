import type { FileRef } from "../../view/file-ref"
import { bodyText, contentRow, type Selection } from "../selection"
import type { AppContext } from "./context"
import type { createFileOpen } from "./file-open"

/**
 * The `file.open` key: opens the first file path in what the user is pointing at in the transcript. The transcript has no cursor, so
 * "pointing at" is what the other transcript keys use: the kept mouse selection if there is one (or the passage it just copied), else the item nearest the middle of the
 * screen (the rule of `ctrl+x f` and `ctrl+x Y`), read as drawn, wrapped lines rejoined. One path opens at once; several are listed in the
 * palette's picker; none says so. Paths outside the workspace are left out (a click on one says why it is refused).
 */
/** How long a copied passage is still "the selection" for the key. */
const COPIED_MS = 8_000

export function createFilePick(ctx: AppContext, deps: { fileOpen: ReturnType<typeof createFileOpen>; pickPaths(refs: FileRef[]): Promise<void> }) {
  const { state, say } = ctx

  /** The text to look in and what to call it in the message when nothing is there. */
  function scope(): { text: string; where: string } | undefined {
    const map = state.selectionMap
    if (!map) return undefined
    const selection = state.selection
    if (selection?.area === "body" && selection.moved) return { text: bodyText(map, selection), where: "the selection" }
    // Copy on select drops the selection at release: what it copied still counts for a few seconds.
    const copied = state.copiedBody
    if (copied && ctx.now() - copied.at <= COPIED_MS) return { text: copied.text, where: "the selection" }
    const rows = map.body
    const middle = (rows.length - 1) / 2
    let at = -1
    rows.forEach((row, index) => {
      if (row?.itemId !== undefined && (at < 0 || Math.abs(index - middle) <= Math.abs(at - middle))) at = index
    })
    if (at < 0) return undefined
    const itemId = rows[at]!.itemId
    const first = rows.findIndex((row) => row?.itemId === itemId)
    const last = rows.findLastIndex((row) => row?.itemId === itemId)
    const whole: Selection = { anchor: { row: contentRow(map, map.bodyTop + first), col: 0 }, focus: { row: contentRow(map, map.bodyTop + last), col: map.width - 1 }, area: "body", moved: true }
    return { text: bodyText(map, whole), where: "the item in view" }
  }

  async function run() {
    const found = scope()
    // The selection was for this: the viewer (or the list of paths) takes the screen's attention from here.
    state.selection = undefined
    state.copiedBody = undefined
    const refs = found ? deps.fileOpen.refsIn(found.text) : []
    if (refs.length === 0) return say(`no file path in ${found?.where ?? "view"}`, "info")
    if (refs.length === 1) return deps.fileOpen.openRef(refs[0]!)
    await deps.pickPaths(refs)
  }

  return { run }
}
