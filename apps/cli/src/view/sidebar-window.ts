/**
 * Where the left list's window starts. Both lists (classic and projects and bots) keep the picked row in view; a wheel over the list
 * moves the window itself (`top`) and leaves the pick where it is, until the pick moves (`anchor` changes) and the window follows it again.
 * The renderer reports the window it drew (`start`) and how far it can go (`max`), so the wheel stays inside the rows.
 */
export type SidebarScroll = {
  /** The row the window followed when `top` was set: the picked row while the list has focus, else the open session. */
  anchor: string
  /** Where the wheel put the window's first row; undefined follows the anchor. */
  top?: number | undefined
  /** Written by the renderer: the first row the last frame drew. */
  start: number
  /** Written by the renderer: the last first row there is (0 when every row fits). */
  max: number
}

export function sidebarWindowStart({ total, shownRoom, overflow, anchorIndex, scroll }: { total: number; shownRoom: number; overflow: boolean; anchorIndex: number; scroll?: SidebarScroll | undefined }): number {
  const max = overflow ? Math.max(0, total - shownRoom) : 0
  const followed = overflow && anchorIndex >= 0 ? Math.max(0, Math.min(anchorIndex - shownRoom + 1, max)) : 0
  const start = scroll?.top !== undefined && overflow ? Math.max(0, Math.min(scroll.top, max)) : followed
  if (scroll) {
    scroll.start = start
    scroll.max = max
  }
  return start
}

/**
 * A click lands on the row that was under the pointer when the hand moved, not the one a redraw slid there since: a click on a line
 * whose row changed less than `CLICK_GUARD_MS` ago is dropped. A change the user caused (a key, a click, the wheel just before:
 * `own`) is theirs and guards nothing. Kept per frame at the cost of one small map; no timer.
 */
export type SidebarClickGuard = { rows: Map<number, string>; changedAt: Map<number, number> }
export const CLICK_GUARD_MS = 250
/** How long after the user's own act a change of rows still counts as theirs. */
export const OWN_INPUT_MS = 300

/** Records what each line shows in this frame. */
export function noteSidebarFrame(guard: SidebarClickGuard | undefined, hits: ReadonlyArray<{ row: number; sessionId: string }>, now: number, own: boolean): SidebarClickGuard {
  const rows = new Map(hits.map((hit) => [hit.row, hit.sessionId]))
  const changedAt = new Map<number, number>()
  // A list that fills from empty slid nothing under the pointer.
  if (guard && guard.rows.size > 0 && !own) {
    // A line that was blank and a line that went blank count too: the row someone aimed at is not there.
    for (const row of new Set([...rows.keys(), ...guard.rows.keys()])) {
      const at = rows.get(row) !== guard.rows.get(row) ? now : guard.changedAt.get(row)
      if (at !== undefined && now - at < CLICK_GUARD_MS) changedAt.set(row, at)
    }
  }
  return { rows, changedAt }
}

/** Whether a click on `row` now goes through. */
export function sidebarClickAllowed(guard: SidebarClickGuard | undefined, row: number, now: number): boolean {
  const at = guard?.changedAt.get(row)
  return at === undefined || now - at >= CLICK_GUARD_MS
}

/** Moves a list's window by `rows` (positive goes down); true when it moved. */
export function scrollSidebarWindow(scroll: SidebarScroll | undefined, rows: number): boolean {
  if (!scroll || scroll.max <= 0) return false
  const top = Math.max(0, Math.min(scroll.max, (scroll.top ?? scroll.start) + rows))
  const moved = top !== scroll.start
  scroll.top = top
  return moved
}
