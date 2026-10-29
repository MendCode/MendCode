import { describe, expect, test } from "bun:test"
import { createTerminalMode, modeFromEnv, MODE_SUBSCRIBE, MODE_UNSUBSCRIBE } from "../src/ui/terminal-mode"
import { createScreen } from "../src/ui/screen"

describe("terminal mode detection", () => {
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
