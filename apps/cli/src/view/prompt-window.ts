/**
 * Which rows of a long prompt are on screen. The window stays where the wheel or a drag put it and moves only as far as the cursor
 * needs when the cursor moves or the text changes (a cursor above or below the window pulls it just enough to show the cursor).
 */
export type PromptView = {
  /** Index of the first visible wrapped row. */
  top: number
  /** The cursor offset the window was last fitted to: a different one makes it follow the cursor again. */
  cursor: number
  /** Rows the prompt shows and rows it has in all, as of the last frame (the wheel and the drag read them). */
  rows: number
  total: number
}

/** The window for this frame; `cursorAt` is the wrapped row holding the cursor, `cursor` its offset in the text. */
export function promptWindow({ previous, cursorAt, cursor, rows, total }: { previous: PromptView | undefined; cursorAt: number; cursor: number; rows: number; total: number }): PromptView {
  const max = Math.max(0, total - rows)
  let top = previous?.top ?? Math.max(0, cursorAt - rows + 1)
  if (previous && (previous.cursor !== cursor || previous.rows !== rows || previous.total !== total)) top = cursorAt < top ? cursorAt : cursorAt >= top + rows ? cursorAt - rows + 1 : top
  return { top: Math.max(0, Math.min(max, top)), cursor, rows, total }
}

/** The window moved by `delta` rows (the wheel, a drag past the edge), kept inside the text; the cursor is left alone. */
export function scrollWindow(view: PromptView, delta: number): PromptView {
  return { ...view, top: Math.max(0, Math.min(Math.max(0, view.total - view.rows), view.top + delta)) }
}
