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

/** Moves a list's window by `rows` (positive goes down); true when it moved. */
export function scrollSidebarWindow(scroll: SidebarScroll | undefined, rows: number): boolean {
  if (!scroll || scroll.max <= 0) return false
  const top = Math.max(0, Math.min(scroll.max, (scroll.top ?? scroll.start) + rows))
  const moved = top !== scroll.start
  scroll.top = top
  return moved
}
