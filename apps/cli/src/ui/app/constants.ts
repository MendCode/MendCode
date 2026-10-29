import type { ForegroundState, PermissionMode } from "@mendcode/protocol"

// shift+tab keeps v1's cycle; `smart` is chosen with `/permissions smart`.
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "edits", "full", "plan"]
export const SELECTABLE_PERMISSION_MODES: readonly PermissionMode[] = ["ask", "smart", "edits", "full", "plan"]
export const BUSY = new Set<ForegroundState>(["generating", "tool", "compacting", "cancelling"])
export const DOUBLE_ESC_MS = 5_000
/** How much the model may have said and Esc Esc still takes the message back (a line of narration, not an answer). */
export const RETRACT_NARRATION_CHARS = 280
export const MAX_EDITOR_ROWS = 6
/** SGR mouse report: ESC [ < button ; col ; row (M press | m release). 64/65 = wheel up/down. */
export const MOUSE_SGR = /^\x1b\[<(\d+);\d+;\d+[Mm]$/
