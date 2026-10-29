import { glyphModeOf, glyphSet, resolveGlyphMode, setGlyphMode, type GlyphMode, type Glyphs } from "../theme"
import type { TuiProfile } from "../../view/tui-profile"
import { asciiLine } from "../ascii"
import type { Line } from "../theme"

type GlyphProfile = Pick<TuiProfile, "glyphs" | "promptChrome" | "promptBorder">

/** The profile's glyph set for this terminal: see `resolveGlyphMode` for the order. */
export const profileGlyphMode = (profile: GlyphProfile, env: Record<string, string | undefined>): GlyphMode => resolveGlyphMode({ choice: profile.glyphs, env })

/**
 * Whether the chrome draws its own marks in ASCII: the ASCII glyph set, or a prompt look that asks for ASCII lines (`ascii-box`, an
 * ASCII border) while the rest of the frame keeps its glyphs. The one check views use instead of reading those keys themselves.
 */
export const asciiChrome = (state: { tuiProfile: GlyphProfile; glyphMode: GlyphMode }): boolean =>
  state.glyphMode === "ascii" || state.tuiProfile.promptChrome === "ascii-box" || state.tuiProfile.promptBorder === "ascii"

/**
 * Applies the resolved mode everywhere at once: the module default the views read, and the app's one glyph object (changed in place, so
 * every holder of it sees the new set). A set the caller pinned (`AppInput.glyphs`) stands for `auto`: the terminal is not asked.
 */
export function applyGlyphMode({ state, glyphs, pinned, env }: { state: { tuiProfile: GlyphProfile; glyphMode: GlyphMode }; glyphs: Glyphs; pinned: Glyphs | undefined; env: Record<string, string | undefined> }): boolean {
  const keep = pinned !== undefined && state.tuiProfile.glyphs === "auto" && env.MENDCODE_GLYPHS === undefined
  const mode = keep ? glyphModeOf(pinned) : profileGlyphMode(state.tuiProfile, env)
  setGlyphMode(mode)
  Object.assign(glyphs, keep ? pinned : glyphSet(mode))
  const changed = mode !== state.glyphMode
  state.glyphMode = mode
  return changed
}

/** A screen whose frames are transliterated to ASCII while `on()` says so; everything else is the screen's own. */
export function asciiScreen<S extends { draw(rows: Line[], ...rest: never[]): unknown }>(screen: S, on: () => boolean): S {
  const wrapped = Object.create(screen) as S
  const draw = screen.draw.bind(screen) as (rows: Line[], cursor?: unknown, placements?: unknown, finished?: Line[]) => unknown
  const plain = (rows: Line[]) => rows.map(asciiLine)
  Object.defineProperty(wrapped, "draw", {
    value: (rows: Line[], cursor?: unknown, placements?: unknown, finished?: Line[]) =>
      on() ? draw(plain(rows), cursor, placements, finished && plain(finished)) : draw(rows, cursor, placements, finished),
  })
  return wrapped
}
