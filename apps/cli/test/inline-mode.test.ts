import { afterAll, describe, expect, test } from "bun:test"
import { createInlineRegion } from "../src/ui/inline-region"
import { createScreen } from "../src/ui/screen"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { parseStartup } from "../src/startup"
import { TUI_DEFAULTS } from "@mendcode/protocol/wire"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir } from "./session-ui-harness"
import { createVt } from "./vt-harness"

afterAll(cleanTemps)

/** The app on a real screen whose output feeds a terminal emulator, so what a user would see (scrollback too) can be read back. */
function terminal(options: { inline: boolean; width?: number; height?: number; shellLines?: number }) {
  const width = options.width ?? 80
  const height = options.height ?? 24
  const vt = createVt(width, height)
  const writes: string[] = []
  const output = { write: (data: string) => (writes.push(data), vt.write(data), true), columns: width, rows: height, isTTY: true }
  // The shell had printed a few lines, so the prompt starts near the bottom, as in a real terminal.
  vt.write(`${Array.from({ length: options.shellLines ?? height - 2 }, (_, n) => `shell line ${n + 1}`).join("\r\n")}\r\n`)
  const screen = createScreen(output, { MENDCODE_MOUSE: "0", MENDCODE_TERMINAL_TITLE: "0", MENDCODE_TERMINAL_MODE: "0" }, { inline: options.inline })
  const h = appHarness({ screen, width, height, mode: "balanced", dataDir: tempDir("inline-data-"), directory: tempDir("inline-project-") })
  const script = conversation(h.sessionId, (event) => h.app.onEvent(event))
  screen.enter()
  h.app.render()
  const mentions = (text: string) => vt.history().filter((row) => row.includes(text)).length
  return { ...h, screen, script, writes, vt, mentions, all: () => writes.join("") }
}

describe("the alternate screen stays the default", () => {
  test("entering and leaving switch the alternate screen and mouse reporting on and off", () => {
    const t = terminal({ inline: false })
    expect(t.all()).toContain("\x1b[?1049h")
    t.screen.leave()
    expect(t.all()).toContain("\x1b[?1049l")
  })

  test("the saved setting defaults on and matches the shared defaults", () => {
    expect(DEFAULT_TUI_PROFILE.altScreen).toBe(true)
    expect(TUI_DEFAULTS.altScreen).toBe(true)
    expect(normalizeTuiProfile({ altScreen: false }).altScreen).toBe(false)
    expect(normalizeTuiProfile({ altScreen: "no" }).altScreen).toBe(true)
  })

  test("--no-alt-screen and --alt-screen parse, conflict and need the TUI", () => {
    expect(parseStartup([]).altScreen).toBeUndefined()
    expect(parseStartup(["--no-alt-screen"]).altScreen).toBe(false)
    expect(parseStartup(["--alt-screen"]).altScreen).toBe(true)
    expect(() => parseStartup(["--alt-screen", "--no-alt-screen"])).toThrow("not both")
    expect(() => parseStartup(["run", "hi", "--no-alt-screen"])).toThrow("require the TUI")
  })
})

describe("inline mode", () => {
  test("starts on the normal screen with no mouse reporting, and the prompt sits under what the shell printed", () => {
    const t = terminal({ inline: true })
    expect(t.writes[0]).not.toContain("1049")
    expect(t.all()).not.toContain("1003h")
    expect(t.vt.alternate).toBe(false)
    const history = t.vt.history()
    expect(history.some((row) => row.includes("shell line 1"))).toBe(true)
    expect(history.some((row) => row.includes("❭"))).toBe(true)
  })

  test("a finished exchange lands in the scrollback once and later frames never repaint it", async () => {
    const t = terminal({ inline: true })
    t.script.exchange("first question", "first answer\n\nsecond paragraph")
    t.app.render()
    expect(t.mentions("first question")).toBe(1)
    expect(t.mentions("first answer")).toBe(1)
    const writesBefore = t.writes.length
    for (const key of ["h", "i", " ", "t", "h", "e", "r", "e"]) await t.type(key)
    t.script.exchange("second question", "second answer")
    t.app.render()
    await t.type("\x1b[D")
    for (const text of ["first question", "first answer", "second paragraph", "second question", "second answer"]) expect(t.mentions(text)).toBe(1)
    // The typing frames wrote the prompt row only, never the history.
    const typing = t.writes.slice(writesBefore, writesBefore + 8).join("")
    expect(typing).not.toContain("first")
    expect(t.vt.history().some((row) => row.includes("hi there"))).toBe(true)
  })

  test("a long conversation scrolls into the terminal scrollback in order, each block once", () => {
    const t = terminal({ inline: true, height: 20 })
    for (let n = 1; n <= 14; n++) t.script.exchange(`question ${n}`, `answer ${n}\n\nmore of ${n}`)
    t.app.render()
    const history = t.vt.history()
    const rowsEndingWith = (text: string) => history.filter((row) => row.trimEnd().endsWith(text)).length
    for (let n = 1; n <= 14; n++) {
      expect(rowsEndingWith(`question ${n}`)).toBe(1)
      expect(rowsEndingWith(`answer ${n}`)).toBe(1)
    }
    expect(history.findIndex((row) => row.trimEnd().endsWith("question 2"))).toBeLessThan(history.findIndex((row) => row.trimEnd().endsWith("question 13")))
    // The newest rows are the prompt and the footer: the region stays at the bottom.
    expect(history.slice(-6).some((row) => row.includes("❭"))).toBe(true)
    expect(t.vt.screen().filter((row) => row.trimEnd().endsWith("question 1")).length).toBe(0)
  })

  test("a streaming answer lives in the region and lands in the scrollback once, whole, when it ends", () => {
    const t = terminal({ inline: true })
    const turnId = ids("turn")
    const itemId = ids("item")
    t.script.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    t.script.emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
    t.script.emit({ type: "item.delta", itemId, text: "partial words" })
    t.app.render()
    expect(t.mentions("partial words")).toBe(1)
    t.script.emit({ type: "item.completed", itemId, status: "ok", text: "the complete sentence arrives" })
    t.script.emit({ type: "turn.completed", turnId })
    t.app.render()
    t.app.render()
    expect(t.mentions("the complete sentence arrives")).toBe(1)
    expect(t.mentions("partial words")).toBe(0)
  })

  test("a run of tool rows stays live until a message closes it, then all of it is written once", () => {
    const t = terminal({ inline: true })
    const written = t.committed.length
    const turnId = ids("turn")
    t.script.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    for (let n = 1; n <= 3; n++) {
      const itemId = ids("item")
      t.script.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read", title: `read file ${n}` } })
      t.script.emit({ type: "item.completed", itemId, status: "ok", text: "" })
    }
    t.app.render()
    expect(t.committed).toHaveLength(written)
    // Three reading calls of one turn are one folded row, still live while the run can grow.
    expect(t.vt.history().filter((row) => row.includes("Read 3 files")).length).toBe(1)
    const message = ids("item")
    t.script.emit({ type: "item.started", turnId, itemId: message, kind: "agent_message" })
    t.script.emit({ type: "item.completed", itemId: message, status: "ok", text: "done reading" })
    t.script.emit({ type: "turn.completed", turnId })
    t.app.render()
    expect(t.mentions("done reading")).toBe(1)
    expect(t.vt.history().filter((row) => row.includes("Read 3 files")).length).toBe(1)
  })

  test("pages and overlays use the alternate screen and the chat comes back with its history intact", async () => {
    const t = terminal({ inline: true })
    t.script.exchange("history stays", "put in scrollback")
    t.app.render()
    const before = t.vt.history()
    await t.type("\x10")
    expect(t.vt.alternate).toBe(true)
    expect(t.vt.screen().some((row) => row.includes("Commands"))).toBe(true)
    await t.type("\x1b")
    expect(t.vt.alternate).toBe(false)
    expect(t.vt.history()).toEqual(before)
    expect(t.mentions("history stays")).toBe(1)
  })

  test("find searches the whole transcript on the alternate screen and closes back inline", async () => {
    const t = terminal({ inline: true })
    t.script.exchange("where is the needle", "right here is the needle")
    t.app.render()
    await t.type("\x06")
    await t.type("needle")
    expect(t.vt.alternate).toBe(true)
    expect(t.vt.screen().some((row) => row.includes("2/2"))).toBe(true)
    await t.type("\x1b")
    expect(t.vt.alternate).toBe(false)
    expect(t.mentions("right here is the needle")).toBe(1)
  })

  test("leaving erases the live region and leaves the history for the shell", () => {
    const t = terminal({ inline: true })
    t.script.exchange("keep this line", "and this one")
    t.app.render()
    t.screen.leave()
    const history = t.vt.history()
    expect(history.some((row) => row.includes("keep this line"))).toBe(true)
    expect(history.some((row) => row.includes("and this one"))).toBe(true)
    expect(history.some((row) => row.includes("❭"))).toBe(false)
    expect(t.vt.alternate).toBe(false)
    expect(t.all()).toContain("\x1b[?25h")
  })

  test("the region is as tall as its rows, never the whole screen", () => {
    const t = terminal({ inline: true, height: 30 })
    t.script.exchange("short chat", "short answer")
    t.app.render()
    const rows = t.frames.at(-1)!
    expect(rows.length).toBeLessThan(12)
    expect(rows.map(plain).join("\n")).not.toContain("short chat")
  })

  test("a title line with the product and the project is written once when the chat starts", async () => {
    const t = terminal({ inline: true })
    t.script.exchange("hello", "world")
    t.app.render()
    await t.type("x")
    expect(t.mentions("MendCode")).toBe(1)
  })
})

describe("the inline region", () => {
  test("a repeat draw writes nothing but the cursor, and a changed row only that row", () => {
    const region = createInlineRegion()
    const first = region.draw(["one", "two", "three"], { row: 2, col: 3 })
    expect(first).toContain("one")
    const same = region.draw(["one", "two", "three"], { row: 2, col: 3 })
    expect(same).not.toContain("one")
    expect(same).not.toContain("two")
    const changed = region.draw(["one", "TWO", "three"], { row: 2, col: 3 })
    expect(changed).toContain("TWO")
    expect(changed).not.toContain("one")
    expect(changed).not.toContain("three")
  })

  test("growing opens rows below, shrinking erases them, committing erases then writes lines", () => {
    const region = createInlineRegion()
    region.draw(["a"], { row: 0, col: 0 })
    expect(region.draw(["a", "b", "c"], { row: 2, col: 0 })).toContain("\r\n\r\n")
    expect(region.height).toBe(3)
    expect(region.draw(["a"], { row: 0, col: 0 })).toContain("\x1b[J")
    expect(region.height).toBe(1)
    const commit = region.commit(["done 1", "done 2"])
    expect(commit.startsWith("\r\x1b[J")).toBe(true)
    expect(commit).toContain("done 1\r\ndone 2\r\n")
    expect(region.height).toBe(0)
  })

  test("on a terminal the region survives growing at the bottom, shrinking and committing", () => {
    const vt = createVt(20, 6)
    vt.write("a\r\nb\r\nc\r\nd\r\n")
    const region = createInlineRegion()
    vt.write(region.draw(["top", "mid", "last"], { row: 2, col: 4 }))
    expect(vt.history().slice(-3)).toEqual(["top", "mid", "last"])
    vt.write(region.draw(["top", "mid", "last", "x1", "x2"], { row: 4, col: 0 }))
    expect(vt.history().slice(-5)).toEqual(["top", "mid", "last", "x1", "x2"])
    vt.write(region.draw(["top"], { row: 0, col: 0 }))
    expect(vt.history().slice(-1)).toEqual(["top"])
    vt.write(region.commit(["done"]))
    vt.write(region.draw(["fresh", "region"], { row: 1, col: 0 }))
    expect(vt.history().slice(-3)).toEqual(["done", "fresh", "region"])
  })
})
