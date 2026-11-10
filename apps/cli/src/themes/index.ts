import type { Theme } from "./define"
import amber from "./amber"
import fjord from "./fjord"
import mendcode from "./mendcode"
import matrix from "./matrix"
import mint from "./mint"
import mono from "./mono"
import paper from "./paper"
import terminal from "./terminal"
import { V1_THEMES } from "./v1"

export { BACKGROUND_ROLES, COLOR_NAMES, defineTheme, mix, type ColorName, type Palette, type Theme } from "./define"

export const DEFAULT_THEME = "mendcode"
/** Names a theme had before, read as the one it is now: Ink became MendCode, and the green Mend theme is gone. */
export const THEME_ALIASES: Readonly<Record<string, string>> = { ink: "mendcode", mend: "mendcode" }

/** One entry per theme file. Adding a theme = a new file here plus one import above; v1's come from ./v1. */
export const THEMES: Theme[] = [mendcode, matrix, mint, amber, fjord, paper, mono, terminal, ...V1_THEMES]
