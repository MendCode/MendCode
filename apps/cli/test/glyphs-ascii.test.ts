import { afterEach, describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { detectGlyphMode, glyphs, resolveGlyphMode, setGlyphMode } from "../src/ui/theme"
import { asciiLine, asciiText } from "../src/ui/ascii"
import { textWidth } from "../src/view/wrap"
import { scene } from "./reply-comments-helpers"
import { cleanTemps, plain } from "./session-ui-harness"

afterEach(() => {
  setGlyphMode("unicode")
  cleanTemps()
})

const ANSWER = [
  "## Plan — café ✓",
  "",
  "- step → done • next ↓",
  "",
  "| Name | État |",
  "|---|---|",
  "| naïve | ✓ ok |",
  "",
  "```ts",
  "const arrow = \"→ ✗ ●\"",
  "```",
].join("\n")

/** Pages a user reaches from the prompt; each opens, draws and closes with Esc. */
const PAGES = ["/customize", "/setup", "/changes", "/usage", "/help", "/settings", "/tools", "/memory", "/agents", "/packages", "/extensions", "/hooks", "/context", "/loops", "/workflows", "/mcps", "/secrets", "/permissions", "/keymap", "/terminal-setup", "/theme", "/model", "/status", "/diagnostics", "/pet", "/sidebar", "/tasks", "/history"]

const nonAscii = (frame: readonly Line[]) => frame.map(plain).filter((row) => /[^\x20-\x7e]/.test(row))

async function sweep(glyphsChoice: "ascii" | "unicode", width: number) {
  const { h } = await scene({ width, height: 30 }, {
    profile: { glyphs: glyphsChoice },
    exchanges: [["Show me the plan → now", ANSWER]],
    // No daemon here: a page that asks for its report draws its error state, which has to be ASCII too; writes still succeed.
    reply: (command) => (/\.(list|get|info|report|status|search|load|show|catalog|registry)$|^(changes|context|usage|daemon)\b/.test(command.type) ? { ok: false, error: { code: "internal", message: "no daemon in this test — “offline” ✗" } } : undefined),
  })
  const visited = new Set<string>()
  for (const command of PAGES) {
    await h.type(command)
    await h.type("\r")
    visited.add(h.app.page)
    await h.type("\x1b")
    if (h.app.page !== "chat") await h.type("\x1b")
  }
  return { frames: h.frames, visited }
}

describe("glyphs: ascii", () => {
  for (const width of [40, 80, 160]) {
    test(`every frame of the chat and ${PAGES.length} pages is printable ASCII at ${width} columns`, async () => {
      const { frames, visited } = await sweep("ascii", width)
      expect(visited.size).toBeGreaterThan(15)
      const offending = frames.flatMap((frame, index) => nonAscii(frame).map((row) => `frame ${index}: ${row}`))
      expect(offending).toEqual([])
    })
  }

  test("the same sweep in unicode does draw non-ASCII marks, so the ASCII check is not vacuous", async () => {
    const { frames } = await sweep("unicode", 80)
    expect(frames.some((frame) => nonAscii(frame).length > 0)).toBe(true)
  })
})

describe("ASCII transliteration", () => {
  test("marks get look-alikes and every cell keeps its width", () => {
    expect(asciiText("┌─┐│✓✗→…●")).toBe("+-+|+x>.o")
    expect(asciiText("café naïve Ñ")).toBe("cafe naive N")
    for (const text of ["界 wide", "🙂 ok", "áb", "⠋ spin", " nerd"]) expect(textWidth(asciiText(text))).toBe(textWidth(text))
    expect(asciiText("plain text")).toBe("plain text")
  })

  test("a line keeps its styles; an all-ASCII line is returned as is", () => {
    const line: Line = [{ text: "✓ ok", fg: "success", bold: true }]
    expect(asciiLine(line)).toEqual([{ text: "+ ok", fg: "success", bold: true }])
    const same: Line = [{ text: "ok" }]
    expect(asciiLine(same)).toBe(same)
  })
})

describe("glyph mode resolution", () => {
  test("MENDCODE_GLYPHS wins, then the profile, then the terminal", () => {
    expect(resolveGlyphMode({ choice: "nerd", env: { MENDCODE_GLYPHS: "ascii" } })).toBe("ascii")
    expect(resolveGlyphMode({ choice: "unicode", env: { TERM: "dumb" } })).toBe("unicode")
    expect(resolveGlyphMode({ choice: "auto", env: { TERM: "dumb" } })).toBe("ascii")
  })

  test("detection: ASCII on old terminals, Nerd Font only where the terminal bundles it", () => {
    for (const TERM of ["dumb", "linux", "vt100", "ansi"]) expect(detectGlyphMode({ TERM })).toBe("ascii")
    expect(detectGlyphMode({ TERM_PROGRAM: "ghostty" })).toBe("nerd")
    expect(detectGlyphMode({ TERM: "xterm-ghostty" })).toBe("nerd")
    expect(detectGlyphMode({ TERM_PROGRAM: "WezTerm" })).toBe("nerd")
    for (const TERM_PROGRAM of ["iTerm.app", "Apple_Terminal", "vscode", "kitty"]) expect(detectGlyphMode({ TERM_PROGRAM, TERM: "xterm-256color" })).toBe("unicode")
  })

  test("an explicit environment names its set; no environment reads the app's resolved mode", () => {
    setGlyphMode("ascii")
    expect(glyphs().user).toBe(">")
    expect(glyphs({}).user).toBe("❯")
    expect(glyphs({ MENDCODE_GLYPHS: "nerd" }).user).toBe(glyphs({ MENDCODE_GLYPHS: "nerd" }).user)
  })
})
