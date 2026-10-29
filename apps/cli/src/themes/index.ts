import type { Theme } from "./define"
import amber from "./amber"
import fjord from "./fjord"
import matrix from "./matrix"
import mend from "./mend"
import mint from "./mint"
import mono from "./mono"
import paper from "./paper"
import terminal from "./terminal"
import { V1_THEMES } from "./v1"

export { BACKGROUND_ROLES, COLOR_NAMES, defineTheme, mix, type ColorName, type Palette, type Theme } from "./define"

export const DEFAULT_THEME = "mend"

/** One entry per theme file. Adding a theme = a new file here plus one import above; v1's come from ./v1. */
export const THEMES: Theme[] = [mend, matrix, mint, amber, fjord, paper, mono, terminal, ...V1_THEMES]
