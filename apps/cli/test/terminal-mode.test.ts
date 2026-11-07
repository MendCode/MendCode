import { describe, expect, test } from "bun:test"
import { backgroundPaint, createTerminalMode, modeFromEnv, MODE_SUBSCRIBE, MODE_UNSUBSCRIBE, PAINT_RESET, paintSequence } from "../src/ui/terminal-mode"
import { createScreen } from "../src/ui/screen"
import { activeTheme, setTheme } from "../src/ui/theme"
import { THEMES } from "../src/themes"

describe("terminal mode detection", () => {
  test("the start-up mode report keeps the text and cursor colours answered before it; a later flip drops them", () => {
    const mode = createTerminalMode({})
    mode.consume("\x1b]10;rgb:dddd/dddd/dddd\x07\x1b]12;rgb:aaaa/aaaa/aaaa\x07\x1b[?997;1n\x1b]11;rgb:0000/0000/0000\x07")
    mode.hold()
    expect(mode.restore()).toBe("\x1b]10;rgb:dddd/dddd/dddd\x07\x1b]11;rgb:0000/0000/0000\x07\x1b]12;rgb:aaaa/aaaa/aaaa\x07")
    mode.hold()
    mode.consume("\x1b[?997;2n")
    expect(mode.restore()).toBe("\x1b]110\x07\x1b]111\x07\x1b]112\x07")
  })

  test("COLORFGBG tells dark from light and ignores anything else", () => {
    expect(modeFromEnv({ COLORFGBG: "15;0" })).toBe("dark")
    expect(modeFromEnv({ COLORFGBG: "0;15" })).toBe("light")
    expect(modeFromEnv({ COLORFGBG: "0;default;7" })).toBe("light")
    expect(modeFromEnv({ COLORFGBG: "7;8" })).toBe("dark")
    expect(modeFromEnv({ COLORFGBG: "garbage" })).toBeUndefined()
    expect(modeFromEnv({})).toBeUndefined()
  })

  test("mode reports and the OSC 11 colour are consumed, change the mode and notify once per change", () => {
    const mode = createTerminalMode({})
    const seen: string[] = []
    mode.subscribe((next) => seen.push(next))
    expect(mode.consume("a\x1b[?997;2nb")).toBe("ab")
    expect(mode.mode).toBe("light")
    expect(mode.consume("\x1b[?997;2n")).toBe("")
    expect(mode.consume("\x1b]11;rgb:0000/0000/0000\x1b\\x")).toBe("x")
    expect(mode.mode).toBe("dark")
    expect(mode.consume("\x1b]11;rgb:f/f/f\x07")).toBe("")
    expect(mode.mode).toBe("light")
    expect(seen).toEqual(["light", "dark", "light"])
  })

  test("a reply split across two reads is held back and joined; a lone Esc or CSI is never held", () => {
    const mode = createTerminalMode({})
    expect(mode.consume("x\x1b]11;rgb:0000/00")).toBe("x")
    expect(mode.consume("00/0000\x07y")).toBe("y")
    expect(mode.mode).toBe("dark")
    expect(mode.consume("\x1b[?99")).toBe("\x1b[?99")
    expect(mode.consume("\x1b[?997")).toBe("")
    expect(mode.consume(";2nz")).toBe("z")
    expect(mode.mode).toBe("light")
    expect(mode.consume("\x1b")).toBe("\x1b")
    expect(mode.consume("\x1b[")).toBe("\x1b[")
    expect(mode.consume("\x1b[A")).toBe("\x1b[A")
  })

  test("the colour reply cut inside its number is held too, so its BEL never reaches the keys; alt+] is not held", () => {
    for (const cut of [3, 4, 5]) {
      const mode = createTerminalMode({})
      const reply = "\x1b]11;rgb:ffff/ffff/ffff\x07"
      expect(mode.consume(reply.slice(0, cut))).toBe("")
      expect(mode.consume(`${reply.slice(cut)}\x07`)).toBe("\x07")
      expect(mode.mode).toBe("light")
    }
    const mode = createTerminalMode({})
    expect(mode.consume("\x1b]")).toBe("\x1b]")
    // What looked like the start of a reply and was not goes on as it came.
    expect(mode.consume("\x1b]1")).toBe("")
    expect(mode.consume("x")).toBe("\x1b]1x")
  })
})

describe("terminal mode on the screen", () => {
  const output = (isTTY: boolean) => {
    const writes: string[] = []
    return { writes, out: { write: (data: string) => void writes.push(data), columns: 80, rows: 24, isTTY } }
  }

  test("the query goes out once, on request, and leaving turns the reports off", () => {
    const { writes, out } = output(true)
    const screen = createScreen(out, { COLORFGBG: "0;15" })
    expect(writes).toEqual([])
    expect(screen.terminalMode.mode).toBe("light")
    screen.requestTerminalMode()
    screen.requestTerminalMode()
    expect(writes).toEqual([MODE_SUBSCRIBE])
    expect(screen.consumeTerminalInput("\x1b[?997;1nq")).toBe("q")
    expect(screen.terminalMode.mode).toBe("dark")
    screen.leave()
    expect(writes.at(-1)).toContain(MODE_UNSUBSCRIBE)
  })

  test("nothing is asked on a pipe or when MENDCODE_TERMINAL_MODE=0", () => {
    for (const [tty, env] of [[false, {}], [true, { MENDCODE_TERMINAL_MODE: "0" }]] as const) {
      const { writes, out } = output(tty)
      const screen = createScreen(out, env)
      screen.requestTerminalMode()
      screen.leave()
      expect(writes.join("")).not.toContain("2031")
    }
  })
})

describe("the theme's background", () => {
  const paper = THEMES.find((theme) => theme.name === "paper")!
  const ink = THEMES.find((theme) => theme.name === "ink")!
  const terminal = THEMES.find((theme) => theme.name === "terminal")!

  test("is painted only when the terminal answered with a background of the other lightness", () => {
    expect(backgroundPaint({ theme: paper, mode: "dark", answered: true })).toEqual({ background: "#faf8f2", text: "#1f2a24", cursor: "#1f2a24" })
    expect(backgroundPaint({ theme: ink, mode: "light", answered: true })?.background).toBe("#0a0a0a")
    expect(backgroundPaint({ theme: paper, mode: "light", answered: true })).toBeUndefined()
    expect(backgroundPaint({ theme: ink, mode: "dark", answered: true })).toBeUndefined()
    // COLORFGBG alone (no OSC 11 answer) is a guess: the terminal's colours stay.
    expect(backgroundPaint({ theme: paper, mode: "dark", answered: false })).toBeUndefined()
    expect(backgroundPaint({ theme: paper, mode: undefined, answered: false })).toBeUndefined()
  })

  test("a theme can ask for it always or never, and the terminal palette theme never paints", () => {
    expect(backgroundPaint({ theme: { ...ink, paintBackground: "always" }, mode: undefined, answered: false })?.background).toBe("#0a0a0a")
    expect(backgroundPaint({ theme: { ...ink, paintBackground: "always" }, mode: "dark", answered: true })?.background).toBe("#0a0a0a")
    expect(backgroundPaint({ theme: { ...paper, paintBackground: "never" }, mode: "dark", answered: true })).toBeUndefined()
    expect(backgroundPaint({ theme: terminal, mode: "light", answered: true })).toBeUndefined()
  })

  test("the sequences set the default text, background and cursor colours, and put the terminal's back", () => {
    expect(paintSequence({ background: "#faf8f2", text: "#1f2a24", cursor: "#1f2a24" })).toBe("\x1b]10;rgb:1f/2a/24\x07\x1b]11;rgb:fa/f8/f2\x07\x1b]12;rgb:1f/2a/24\x07")
    expect(paintSequence(undefined)).toBe(PAINT_RESET)
  })

  const tty = () => {
    const writes: string[] = []
    return { writes, out: { write: (data: string) => void writes.push(data), columns: 20, rows: 4, isTTY: true } }
  }
  const SET_BACKGROUND = "\x1b]11;rgb:"
  const rows = [[{ text: "hello", fg: "text" as const }], [{ text: "plain" }], [{ text: "chip", bg: "panel" as const }]]
  const withTheme = (name: string, run: () => void) => {
    const previous = activeTheme().name
    setTheme(name)
    try { run() } finally { setTheme(previous) }
  }

  test("Paper in a dark terminal: painted once, the rows' bytes unchanged, kept on resize, put back on leaving", () => withTheme("paper", () => {
    const plain = tty()
    const unpainted = createScreen(plain.out, {})
    unpainted.enter()
    unpainted.draw(rows)
    const { writes, out } = tty()
    const screen = createScreen(out, {})
    screen.enter()
    screen.requestTerminalMode()
    screen.consumeTerminalInput("\x1b]11;rgb:0000/0000/0000\x07")
    writes.length = 0
    screen.draw(rows)
    const frame = writes.join("")
    expect(frame).toContain(paintSequence(backgroundPaint({ theme: activeTheme(), mode: "dark", answered: true })))
    // The cells' SGR is what an unpainted screen writes: the colour costs one sequence on the first frame, nothing per row.
    expect(frame.replace(paintSequence(backgroundPaint({ theme: activeTheme(), mode: "dark", answered: true })), "")).toBe(plain.writes.at(-1)!)
    writes.length = 0
    screen.draw([[{ text: "hello!", fg: "text" }], ...rows.slice(1)])
    expect(writes.join("")).not.toContain(SET_BACKGROUND)
    screen.resize(30, 5)
    screen.draw(rows)
    expect(writes.join("")).not.toContain(SET_BACKGROUND)
    expect(writes.join("")).not.toContain(PAINT_RESET)
    writes.length = 0
    screen.leave()
    // The background it answered with is set back exactly; text and cursor, never answered, go back to the configured defaults.
    expect(writes.join("")).toContain("\x1b]110\x07\x1b]11;rgb:0000/0000/0000\x07\x1b]112\x07")
    // Back on the screen (an editor, ctrl+z): the terminal is asked again (it may have changed) and painted again.
    screen.enter()
    expect(writes.join("")).toContain(MODE_SUBSCRIBE)
    writes.length = 0
    screen.draw(rows)
    expect(writes.join("")).toContain(SET_BACKGROUND)
  }))

  test("follows the theme and the terminal's mode reports: a matching pair gets the terminal's colours back", () => withTheme("paper", () => {
    const { writes, out } = tty()
    const screen = createScreen(out, {})
    screen.enter()
    screen.requestTerminalMode()
    screen.consumeTerminalInput("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")
    screen.draw(rows)
    expect(writes.join("")).toContain(SET_BACKGROUND)
    writes.length = 0
    screen.consumeTerminalInput("\x1b[?997;2n")
    screen.draw(rows)
    expect(writes.join("")).toContain(PAINT_RESET)
    writes.length = 0
    setTheme("ink")
    screen.draw(rows)
    expect(writes.join("")).toContain("\x1b]11;rgb:0a/0a/0a\x07")
    writes.length = 0
    screen.leave()
    expect(writes.join("")).toContain(PAINT_RESET)
  }))

  test("the colours a shell or another program set at runtime are the ones put back, not the configured defaults", () => withTheme("paper", () => {
    const { writes, out } = tty()
    const screen = createScreen(out, {})
    screen.enter()
    screen.requestTerminalMode()
    expect(writes.join("")).toContain(MODE_SUBSCRIBE)
    // Replies in the order asked: text, cursor, then the background (one chunk, cut inside the cursor's reply).
    const replies = "\x1b]10;rgb:d0d0/d0d0/d0d0\x07\x1b]12;rgb:ff00/8000/0000\x1b\\\x1b]11;rgb:1212/1414/1818\x07"
    expect(screen.consumeTerminalInput(replies.slice(0, 40))).toBe("")
    expect(screen.consumeTerminalInput(replies.slice(40))).toBe("")
    screen.draw(rows)
    expect(writes.join("")).toContain(SET_BACKGROUND)
    // A late answer while painted is the theme's colour: it does not replace what is put back.
    screen.consumeTerminalInput("\x1b]10;rgb:1f1f/2a2a/2424\x07")
    writes.length = 0
    screen.leave()
    const restored = "\x1b]10;rgb:d0d0/d0d0/d0d0\x07\x1b]11;rgb:1212/1414/1818\x07\x1b]12;rgb:ff00/8000/0000\x07"
    expect(writes.join("")).toContain(restored)
    expect(writes.join("")).not.toContain(PAINT_RESET)
    // Switching to a theme that fits the terminal unpaints with the same saved colours.
    screen.enter()
    screen.consumeTerminalInput("\x1b]10;rgb:d0d0/d0d0/d0d0\x07\x1b]11;rgb:1212/1414/1818\x07")
    screen.draw(rows)
    writes.length = 0
    setTheme("ink")
    screen.draw(rows)
    expect(writes.join("")).toContain(restored)
  }))

  test("nothing changes for a theme that fits its terminal, a terminal that never answered, or the inline chat", () => withTheme("paper", () => {
    const cases: Array<[Record<string, string>, string | undefined, boolean]> = [[{}, "\x1b]11;rgb:ffff/ffff/ffff\x07", false], [{ COLORFGBG: "15;0" }, undefined, false], [{}, "\x1b]11;rgb:0000/0000/0000\x07", true]]
    for (const [env, answer, inline] of cases) {
      const { writes, out } = tty()
      const screen = createScreen(out, env, { inline })
      screen.enter()
      screen.requestTerminalMode()
      if (answer) screen.consumeTerminalInput(answer)
      screen.draw(rows)
      screen.leave()
      expect(writes.join("")).not.toContain("\x1b]11;rgb:")
      expect(writes.join("")).not.toContain(PAINT_RESET)
    }
  }))
})
