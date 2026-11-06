/**
 * Test preload: the glyph set the TUI draws with is process-wide state (`setGlyphMode`, apps/cli/src/ui/theme.ts). A test that builds the
 * app with `glyphs: "ascii"` switches it, and every later file run in the same process then drew `>` for `❯`: loops-page.test.ts failed
 * on a CI runner only because the part there put logo-mark.test.ts before it. After each test the mode goes back to Unicode, the
 * default of a fresh process. The module is only touched when a test already loaded it.
 */
import { afterEach } from "bun:test"
import path from "node:path"

const theme = path.resolve(import.meta.dir, "../apps/cli/src/ui/theme.ts")

afterEach(() => {
  const loaded = require.cache[theme]?.exports as { setGlyphMode?(mode: "unicode"): void } | undefined
  loaded?.setGlyphMode?.("unicode")
})
