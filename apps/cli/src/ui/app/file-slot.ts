import { rightBarCells } from "../../view/right-bar"
import type { AppState } from "./context"

/**
 * Where the right slot stands while a file is open (docs/file-viewer.md). Small and eager: the layout, the keys and the chrome ask it
 * every frame, so none of them loads the viewer to find out that no file is open.
 */

/** The right panel, the side chat or a widget of an extension has the slot (or would, if no file were open). */
export const panelWanted = (state: AppState): boolean =>
  !!(state.sideChats.get(state.sessionId)?.open || state.ext?.hasWidgets("sidebar") || state.tuiProfile.rightSidebar && state.tuiProfile.sidebarWidgets.length > 0)

/** The open file is what the right slot draws now (not the panel, and not the `file` page of a narrow terminal). */
export const fileInSlot = (state: AppState): boolean => {
  const file = state.fileViewer
  return !!file && !file.page && (file.showing === "file" || !panelWanted(state))
}

/** The cells the right slot takes at `width`, or 0 when it does not fit. */
export const slotCells = (state: AppState, width: number): number =>
  rightBarCells({ columns: width, setting: state.tuiProfile.sidebarWidth, collapsed: state.rightBarCollapsed }).cells
