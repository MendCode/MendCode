import type { TuiProfile } from "./tui-profile"

/**
 * Screen-reader mode (docs/accessibility.md). The mode keeps the chat inline (no alternate screen), turns animation and
 * mouse reporting off and shows plain text. It is always asked for: a terminal gives no reliable sign that a screen reader
 * is running, so there is no automatic detection.
 */
type Look = Pick<TuiProfile, "presentation" | "messageRenderer" | "reasoning">

/** What the mode shows: the plain text presentation `/raw` gives, with reasoning in full. */
export const ACCESSIBLE_LOOK: Look = { presentation: "raw", messageRenderer: "plain", reasoning: "expanded" }
/** What turning the mode off puts back. */
export const NORMAL_LOOK: Look = { presentation: "auto", messageRenderer: "full", reasoning: "auto" }

/** Whether this run is in screen-reader mode: `--accessible`, then `MENDCODE_ACCESSIBLE` (1 on, 0 off), then the saved setting. */
export function accessibleMode({ flag, env, saved }: { flag?: boolean | undefined; env: Record<string, string | undefined>; saved: boolean }): boolean {
  if (flag === true) return true
  if (env.MENDCODE_ACCESSIBLE === "1") return true
  if (env.MENDCODE_ACCESSIBLE === "0") return false
  return saved
}
