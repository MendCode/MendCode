import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPtyScreen } from "./pty-screen"
import { runPtySmoke, runTuiBugs } from "./pty-smoke"
import { parseSlash } from "../apps/cli/src/view/commands"

test("faux smoke triggers pass through slash routing, without colliding with /limit", () => {
  for (const text of ["/faux-limit", "/graft", "/thread-check @thread:123", "/ask", "/tool 3000"]) expect(parseSlash(text)).toBeUndefined()
  expect(parseSlash("/limit")?.command.name).toBe("limit")
})

test("VT receiver applies partial escapes, differential erases, wide cells and ED without moving the cursor", () => {
  const screen = createPtyScreen(8, 3)
  screen.feed("\x1b[?1049h\x1b[1;1Habcdefgh\x1b[2;")
  screen.feed("1H界XY\x1b[0m\x1b[1;3HZ\x1b[K\x1b[?2026l")
  expect(screen.text()).toBe("abZ     \n界XY    \n        \n")
  expect(screen.frames).toBe(1)
  screen.feed("\x1b[2;3H\x1b[2Jq")
  expect(screen.text()).toBe("        \n  q     \n        \n")
  screen.resize(4, 2)
  screen.feed("\x1b[1;1H1234\x1b[2;1HXY")
  expect(screen.text()).toBe("1234\nXY  \n")
  expect(screen.unsupported).toEqual([])
  // The keyboard protocol query, the device attributes request and the flag push and pop are queries, not output.
  screen.feed("\x1b[?u\x1b[c\x1b[>29u\x1b[<u")
  expect(screen.unsupported).toEqual([])
  expect(screen.text()).toBe("1234\nXY  \n")
  screen.feed("\x1b[999z")
  expect(screen.unsupported).toEqual(["CSI 999z"])
  const emoji = createPtyScreen(8, 2)
  emoji.feed("⚙")
  emoji.feed("\ufe0f👩\u200d")
  emoji.feed("💻AB")
  expect(emoji.text()).toBe("⚙️👩‍💻AB  \n        \n")
})

test("VT snapshots preserve cell colours through differential erase, scroll and resize", () => {
  const screen = createPtyScreen(3, 2)
  screen.feed("\x1b[31;1mR\x1b[0mX\x1b[2;1H\x1b[38;5;42mG")
  expect(screen.ansi()).toContain("\x1b[31;1mR")
  expect(screen.ansi()).toContain("\x1b[38;5;42mG")
  screen.feed("\x1b[1;2H\x1b[34m\x1b[K")
  expect(screen.ansi().split("\n")[0]).toContain("\x1b[34m ")
  screen.feed("\x1b[2;1H\r\n")
  expect(screen.ansi().split("\n")[0]).toContain("\x1b[38;5;42mG")
  screen.resize(2, 1)
  expect(screen.text()).toBe("  \n")
  expect(screen.ansi()).not.toContain("\x1b[31;1m")
})

test("the real renderer draws differential frames and resizes inside a native PTY", async () => {
  if (typeof Bun.Terminal !== "function") throw new Error("native PTY unavailable")
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-pty-render-")))
  const grid = createPtyScreen(60, 20)
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({ cols: 60, rows: 20, name: "xterm-256color", data: (_terminal, bytes) => grid.feed(decoder.decode(bytes, { stream: true })) })
  const module = new URL("../apps/cli/src/ui/screen.ts", import.meta.url).href
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { createScreen } from ${JSON.stringify(module)}
    if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2)
    const screen = createScreen(process.stdout, { MENDCODE_MOUSE: "0", MENDCODE_FOCUS_EVENTS: "0", MENDCODE_TERMINAL_TITLE: "0" })
    process.stdin.setRawMode(true)
    screen.enter()
    const draw = (text) => screen.draw([[{ text }], [{ text: "界 Unicode" }]])
    draw("long old frame")
    process.stdin.on("data", (data) => {
      if (data.toString() === "x") {
        screen.leave()
        process.exit(0)
      }
      draw("short")
    })
    process.stdout.on("resize", () => {
      screen.resize(process.stdout.columns, process.stdout.rows)
      draw("resized")
    })
  `], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TERM: "xterm-256color" }, terminal })
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 4000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`PTY renderer timeout: ${grid.text()}`)
      await Bun.sleep(10)
    }
  }
  try {
    await until(() => grid.text().includes("long old frame"))
    expect(grid.text().split("\n")[1]).toContain("界 Unicode")
    terminal.write("a")
    await until(() => grid.text().includes("short"))
    expect(grid.text()).not.toContain("old frame")
    if (process.env.PTY_SMOKE_FRAMES) {
      mkdirSync(process.env.PTY_SMOKE_FRAMES, { recursive: true })
      writeFileSync(path.join(process.env.PTY_SMOKE_FRAMES, "renderer-differential-60x20.txt"), grid.text())
    }
    for (const [cols, rows] of [[100, 30], [180, 50], [60, 20]] as const) {
      grid.resize(cols, rows)
      const before = grid.frames
      terminal.resize(cols, rows)
      child.kill("SIGWINCH")
      await until(() => grid.frames > before && grid.text().includes("resized"))
      expect(grid.text().slice(0, -1).split("\n")).toHaveLength(rows)
      expect(grid.text().slice(0, -1).split("\n").every((row) => Bun.stringWidth(row) === cols)).toBe(true)
      if (process.env.PTY_SMOKE_FRAMES) {
        mkdirSync(process.env.PTY_SMOKE_FRAMES, { recursive: true })
        writeFileSync(path.join(process.env.PTY_SMOKE_FRAMES, `renderer-${cols}x${rows}.txt`), grid.text())
      }
    }
    expect(grid.unsupported).toEqual([])
    terminal.write("x")
    expect(await child.exited).toBe(0)
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    terminal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

// A denied OS listen is a capability gap, not a passing integrated smoke. Normal local runs execute this by default.
const probeDir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-pty-listen-")))
let unavailable = ""
try {
  const listener = Bun.listen({ unix: path.join(probeDir, "probe.sock"), socket: { data() {} } })
  listener.stop(true)
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== "EPERM" && code !== "EACCES") throw error
  unavailable = `OS listen denied (${code})`
} finally { rmSync(probeDir, { recursive: true, force: true }) }

test.skipIf(!!unavailable)(`compiled CLI home, streaming, approval and clean exit in PTY${unavailable ? ` — ${unavailable}` : ""}`, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pty-test-"))
  const full = process.env.PTY_SMOKE_FULL === "1"
  const frames = full && process.env.PTY_SMOKE_FRAMES ? path.resolve(process.env.PTY_SMOKE_FRAMES) : path.join(dir, "frames")
  mkdirSync(frames, { recursive: true })
  try {
    if (process.env.PTY_TUI_BUGS === "1") {
      const result = await runTuiBugs(process.env.PTY_SMOKE_FRAMES ? path.resolve(process.env.PTY_SMOKE_FRAMES) : frames)
      expect(result.cases).toBe(2)
      expect(result.frames).toBeGreaterThan(100)
      return
    }
    const result = await runPtySmoke({ short: !full, frames })
    expect(result.nativePty).toBe(true)
    expect(result.target).toBe("compiled")
    expect(result.cliExit).toBe(0)
    expect(result.streamedDeltas).toBeGreaterThan(1)
    expect(result.frames.slice(0, 6).map((frame) => frame.name)).toEqual(["home", "new-chat", "streaming", "answer", "approval", "approved"])
    expect(readFileSync(result.frames.find((frame) => frame.name === "approval")!.file, "utf8")).toContain("run faux tool?")
    if (full) {
      expect(result.completedTurns).toBe(7)
      expect(result.frames.slice(6).map((frame) => frame.name)).toEqual([
        "tier-minimalist", "tier-panel-minimalist", "tier-balanced", "tier-panel-balanced", "tier-full", "tier-panel-full",
        "pulse", "graft-expanded", "graft-resize", "graft-resize", "graft-resize", "compaction", "compaction-memory",
        "thread", "queue", "usage-limit", "usage-limit-minimalist", "sessions", "long-bottom", "long-page-up", "long-top", "long-end",
      ])
      const frame = (name: string) => readFileSync(result.frames.find((frame) => frame.name === name)!.file, "utf8")
      expect(frame("graft-expanded")).toContain("2 callers · 2 callees")
      expect(frame("compaction-memory")).toContain("No summary")
      expect(frame("thread")).toContain("faux thread snapshot received")
      expect(frame("queue")).toContain("Queued · 1")
      expect(frame("usage-limit")).toContain("resume at reset (armed)")
      expect(frame("usage-limit-minimalist")).toContain("esc cancel")
      expect(frame("long-top")).toContain("(0)")
      expect(frame("long-end")).toContain("(118)")
      for (const captured of result.frames) expect(readFileSync(captured.file, "utf8")).not.toContain("not a file or directory")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60_000)
