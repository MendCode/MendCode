import { BREAKPOINTS } from "../ui/breakpoints"

/** Columns the chat keeps beside the right bar. */
const CHAT_MIN = 62
/** A bar that collapsed for lack of room comes back only this many columns above the threshold, so a terminal sitting on the edge does not flicker. */
const HYSTERESIS = 8

/**
 * Cells the right bar takes at `columns`, or 0 when it does not fit (the bar then shows as a sheet above the prompt).
 * `setting` is the `sidebarWidth` profile field: 0 keeps 48 cells (56 from 150 columns), otherwise 32..80.
 * `collapsed` is whether the last call found no room; the new value goes back to the caller to keep.
 */
export function rightBarCells({ columns, setting, collapsed }: { columns: number; setting: number; collapsed: boolean }): { cells: number; collapsed: boolean } {
  const cells = setting > 0 ? setting : columns >= BREAKPOINTS.xl ? 56 : 48
  const needed = Math.max(BREAKPOINTS.wide, cells + CHAT_MIN)
  const fits = columns >= needed + (collapsed ? HYSTERESIS : 0)
  return { cells: fits ? cells : 0, collapsed: !fits }
}
