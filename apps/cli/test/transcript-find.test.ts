import { afterAll, describe, expect, test } from "bun:test"
import { centerOffset, findBar, findMatches } from "../src/view/find"
import { KEY_ACTIONS } from "../src/ui/keymap"
import { readTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const CTRL_F = "\x06"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const ESC = "\x1b"

/** Six exchanges; "needle" is in the answers of the 2nd, 4th and 6th, "Needle" (capital) in the 3rd's prompt. */
function chat(options: { width?: number; height?: number } = {}) {
  const dataDir = tempDir("find-data-")
  const h = appHarness({ width: options.width ?? 100, height: options.height ?? 16, mode: "balanced", dataDir, directory: tempDir("find-project-") })
  const script = conversation(h.sessionId, (event) => h.app.onEvent(event))
  for (let n = 1; n <= 6; n++) script.exchange(n === 3 ? `Needle prompt number ${n}` : `prompt number ${n}`, n % 2 === 0 ? `answer ${n} has a needle inside\n\nand more filler text for ${n}` : `answer ${n} plain\n\nfiller for ${n}\n\nfiller again`)
  h.app.render()
  return { ...h, script, dataDir }
}

const barRow = (rows: string[]) => rows.find((row) => /^\s*find /.test(row))

function painted(h: ReturnType<typeof chat>, bg: "warning" | "muted") {
  return (h.frames.at(-1) ?? []).flatMap((line) => line.filter((span) => span.bg === bg).map((span) => span.text))
}

describe("find in the transcript", () => {
  test("ctrl+f opens the bar; typing highlights hits, counts them and lands on the newest", async () => {
    const h = chat()
    expect(barRow(h.text())).toBeUndefined()
    await h.type(CTRL_F)
    expect(barRow(h.text())).toBeDefined()
    await h.type("needle")
    const bar = barRow(h.text())!
    expect(bar).toContain("find needle")
    expect(bar).toContain("4/4")
    // The current hit is painted apart from the others, and the jump brought it on screen.
    expect(painted(h, "warning")).toEqual(["needle"])
    expect(h.text().join("\n")).toContain("answer 6 has a needle inside")
  })

  test("up and down move between hits with a wrap, and the viewport follows", async () => {
    const h = chat()
    await h.type(CTRL_F)
    await h.type("needle")
    await h.type(UP)
    expect(barRow(h.text())).toContain("3/4")
    await h.type(UP)
    await h.type(UP)
    expect(barRow(h.text())).toContain("1/4")
    expect(h.text().join("\n")).toContain("Needle prompt number 3")
    await h.type(UP)
    expect(barRow(h.text())).toContain("4/4")
    await h.type(DOWN)
    expect(barRow(h.text())).toContain("1/4")
  })

  test("the search ignores case unless the query has a capital", async () => {
    const h = chat()
    await h.type(CTRL_F)
    await h.type("Needle")
    expect(barRow(h.text())).toContain("1/1")
    await h.type("\x15needle")
    expect(barRow(h.text())).toContain("4/4")
  })

  test("a query with no hit says so; backspace edits it; esc closes the bar and keeps the place", async () => {
    const h = chat()
    await h.type(CTRL_F)
    await h.type("zzz")
    expect(barRow(h.text())).toContain("no matches")
    await h.type("\x7f\x7f\x7f")
    expect(barRow(h.text())!.startsWith("  find ")).toBe(true)
    expect(barRow(h.text())).not.toContain("no matches")
    await h.type("needle")
    await h.type(UP)
    await h.type(ESC)
    expect(barRow(h.text())).toBeUndefined()
    expect(h.text().join("\n")).toContain("answer 4 has a needle inside")
  })

  test("tab limits the search to prompts: an empty query steps through them", async () => {
    const h = chat()
    await h.type(CTRL_F)
    await h.type("\t")
    expect(barRow(h.text())).toContain("prompts")
    expect(barRow(h.text())).toContain("6/6")
    await h.type(UP)
    await h.type(UP)
    await h.type(UP)
    expect(barRow(h.text())).toContain("3/6")
    expect(h.text().join("\n")).toContain("Needle prompt number 3")
    await h.type("answer")
    expect(barRow(h.text())).toContain("no matches")
  })

  test("typing while the bar is open never reaches the prompt", async () => {
    const h = chat()
    await h.type(CTRL_F)
    await h.type("needle")
    expect(h.app.editor.text).toBe("")
    await h.type(ESC)
    await h.type("hi")
    expect(h.app.editor.text).toBe("hi")
  })

  test("/find opens the bar with a query, and leader slash opens it empty", async () => {
    const h = chat()
    await h.type("/find needle\r")
    expect(barRow(h.text())).toContain("4/4")
    await h.type(ESC)
    await h.type("\x18/")
    expect(barRow(h.text())).toBeDefined()
  })

  test("the bar keeps the count and drops the hints on a narrow terminal", async () => {
    const h = chat({ width: 60 })
    await h.type(CTRL_F)
    await h.type("needle")
    const bar = barRow(h.text())!
    expect(bar).toContain("4/4")
    expect(bar).not.toContain("esc close")
    expect(bar.length).toBeLessThanOrEqual(60)
    const wide = chat({ width: 120 })
    await wide.type(CTRL_F)
    expect(wide.text().some((row) => row.includes("esc close"))).toBe(true)
  })

  test("/raw switches to plain output and back to the automatic look", async () => {
    const h = chat()
    await h.type("/raw\r")
    expect(readTuiProfile(h.dataDir)).toMatchObject({ presentation: "raw", messageRenderer: "plain" })
    await h.type("/raw\r")
    expect(readTuiProfile(h.dataDir)).toMatchObject({ presentation: "auto", messageRenderer: "full" })
  })

  test("the action is bindable by name", () => {
    expect(KEY_ACTIONS).toContain("transcript.find")
  })
})

describe("find helpers", () => {
  const lines = [
    { text: "  › Hello World", kind: "user_message", gutter: 4, row: 0 },
    { text: "  hello again, hello", kind: "agent_message", gutter: 2, row: 0 },
    { text: "", kind: "gap" },
    { text: "  › second prompt", kind: "user_message", gutter: 4, row: 0 },
  ]

  test("matches are smart-case, skip the chrome cells and list each hit", () => {
    expect(findMatches(lines, "hello", false).map((m) => [m.line, m.from, m.to])).toEqual([[0, 4, 9], [1, 2, 7], [1, 15, 20]])
    expect(findMatches(lines, "Hello", false)).toHaveLength(1)
    expect(findMatches(lines, "›", false)).toHaveLength(0)
    expect(findMatches(lines, "hello", true)).toHaveLength(1)
    expect(findMatches(lines, "", false)).toHaveLength(0)
    expect(findMatches(lines, "", true).map((m) => m.line)).toEqual([0, 3])
  })

  test("a regex-looking query is literal", () => {
    expect(findMatches([{ text: "a.b a*b", kind: "agent_message" }], "a.b", false)).toHaveLength(1)
    expect(findMatches([{ text: "(x)", kind: "agent_message" }], "(x", false)).toHaveLength(1)
  })

  test("the jump centres the hit and stays inside the window", () => {
    expect(centerOffset(100, 50, 20)).toBe(40)
    expect(centerOffset(100, 99, 20)).toBe(0)
    expect(centerOffset(100, 0, 20)).toBe(80)
    expect(centerOffset(10, 3, 20)).toBe(0)
  })

  test("the bar row fits its width", () => {
    const state = { query: "x".repeat(80), prompts: true, matches: [{ line: 1, from: 0, to: 1 }], index: 0, width: 40, total: 5, seen: 5 }
    for (const width of [30, 60, 100]) expect(plain(findBar({ state, width, margin: 2 }).row).length).toBeLessThanOrEqual(width)
  })
})
