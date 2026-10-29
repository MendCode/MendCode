import { afterEach, describe, expect, test } from "bun:test"
import { CUSTOMIZE_ROWS, customizePageKey, renderCustomizePage, type CustomizePageState } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "../src/view/tui-profile"
import { setColorOverrides, sgr } from "../src/ui/theme"
import { createTranscript } from "../src/view/transcript"
import { createIdFactory } from "@mendcode/protocol"

afterEach(() => setColorOverrides({}))

const at = (field: (typeof CUSTOMIZE_ROWS)[number]): CustomizePageState => ({ row: CUSTOMIZE_ROWS.indexOf(field) })
const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const page = (state: CustomizePageState, profile: TuiProfile = DEFAULT_TUI_PROFILE, width = 150, height = 50) =>
  renderCustomizePage({ state, profile, preview: { root: "/work", tip: "", now: 0 }, width, height }).map((line) => line.map((span) => span.text).join(""))

describe("the Markdown group in /customize", () => {
  test("has a row for each setting, between the session rows and the status segments", () => {
    const start = CUSTOMIZE_ROWS.indexOf("tableStyle")
    expect(CUSTOMIZE_ROWS.slice(start, start + 5)).toEqual(["tableStyle", "headingStyle", "markdownCopyHints", "markdownRtl", "markdownColors"])
    expect(CUSTOMIZE_ROWS[start - 1]).toBe("doneSymbol")
    expect(CUSTOMIZE_ROWS[start + 5]).toBe("statusLeft")
  })

  test("the choice rows step through their values and wrap around", () => {
    const patch = (field: "tableStyle" | "headingStyle" | "markdownCopyHints", key: string, profile: TuiProfile = DEFAULT_TUI_PROFILE) => (customizePageKey(at(field), key, profile).action as { patch: Record<string, string> }).patch[field]
    expect(patch("tableStyle", RIGHT)).toBe("box")
    expect(patch("tableStyle", LEFT)).toBe("minimal")
    expect(patch("headingStyle", RIGHT, { ...DEFAULT_TUI_PROFILE, headingStyle: "uppercase" })).toBe("auto")
    expect(patch("markdownCopyHints", RIGHT, { ...DEFAULT_TUI_PROFILE, markdownCopyHints: "code" })).toBe("all")
    expect(patch("markdownCopyHints", RIGHT, { ...DEFAULT_TUI_PROFILE, markdownCopyHints: "off" })).toBe("auto")
  })

  test("the right-to-left row toggles", () => {
    expect(customizePageKey(at("markdownRtl"), " ", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { markdownRtl: false } })
  })

  test("the colour row takes JSON, saves valid roles and says what is wrong with the rest", () => {
    const start = customizePageKey(at("markdownColors"), "\r", DEFAULT_TUI_PROFILE).state
    expect(start.typing).toBe("")
    const typed = { ...start, typing: '{"mdHeading1":"#FF0000","mdRule":"#00ff00"}' }
    const saved = customizePageKey(typed, "\r", DEFAULT_TUI_PROFILE)
    expect(saved.action).toEqual({ type: "set", patch: { markdownColors: '{"mdHeading1":"#ff0000","mdRule":"#00ff00"}' } })
    expect(customizePageKey({ ...start, typing: '{"mdHeading1":"red"}' }, "\r", DEFAULT_TUI_PROFILE).state.error).toContain("mdHeading1 must be #rrggbb")
    expect(customizePageKey({ ...start, typing: '{"nope":"#ffffff"}' }, "\r", DEFAULT_TUI_PROFILE).state.error).toContain("unknown role: nope")
    expect(customizePageKey({ ...start, typing: "{broken" }, "\r", DEFAULT_TUI_PROFILE).action.type).toBe("none")
    expect(customizePageKey({ ...start, typing: "" }, "\r", { ...DEFAULT_TUI_PROFILE, markdownColors: '{"mdRule":"#00ff00"}' }).action).toEqual({ type: "set", patch: { markdownColors: "" } })
  })

  test("a Markdown row previews the sample in the chosen style, wide and narrow", () => {
    for (const [width, height] of [[150, 50], [80, 40]] as const) {
      const rules = page(at("tableStyle"), { ...DEFAULT_TUI_PROFILE, tableStyle: "rules" }, width, height).join("\n")
      expect(rules).toContain("Markdown preview")
      expect(rules).toContain("Heading one")
      expect(rules).not.toMatch(/│ Name +│ Qty/)
      expect(rules).toContain("Name   Qty")
      const box = page(at("tableStyle"), { ...DEFAULT_TUI_PROFILE, tableStyle: "box" }, width, height).join("\n")
      expect(box).toMatch(/│ Name +│ Qty/)
      expect(box).toContain("╭─ ts")
    }
    expect(page(at("headingStyle"), { ...DEFAULT_TUI_PROFILE, headingStyle: "underline" }).join("\n")).toContain("═══")
    expect(page(at("markdownCopyHints"), { ...DEFAULT_TUI_PROFILE, markdownCopyHints: "off" }).join("\n")).not.toMatch(/ copy( |$)/)
    expect(page(at("markdownCopyHints"), { ...DEFAULT_TUI_PROFILE, markdownCopyHints: "all" }).join("\n")).toMatch(/─ copy [┐╮]|─ copy +│/)
  })

  test("typing colours previews them at once and leaving the row keeps the saved ones", () => {
    const typing = { ...at("markdownColors"), typing: '{"mdHeading1":"#123456"}' }
    page(typing)
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).toBe("\x1b[38;2;18;52;86m")
    page(at("markdownColors"), DEFAULT_TUI_PROFILE)
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).not.toBe("\x1b[38;2;18;52;86m")
  })

  test("other rows do not draw the Markdown preview", () => {
    expect(page(at("timestamps")).join("\n")).not.toContain("Markdown preview")
  })
})

describe("the transcript applies the settings", () => {
  const exchange = (appearance: Partial<TuiProfile>, mode: "minimal" | "balanced" | "full") => {
    const transcript = createTranscript({ appearance, mode })
    const ids = createIdFactory()
    const sessionId = ids("session")
    const turnId = ids("turn")
    const itemId = ids("item")
    let seq = 0
    const feed = (event: Record<string, unknown>) => transcript.apply({ sessionId, seq: ++seq, at: 1_000 + seq, ...event } as never)
    feed({ type: "turn.started", turnId, queueId: ids("queue") })
    feed({ type: "item.started", turnId, itemId, kind: "agent_message" })
    feed({ type: "item.completed", itemId, status: "ok", text: "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nx\n```" })
    feed({ type: "turn.completed", turnId })
    return transcript
  }
  const lines = (appearance: Partial<TuiProfile>, mode: "minimal" | "balanced" | "full") => exchange(appearance, mode).viewport(60, 30).map((line) => line.text)

  test("the full view draws the headed engine and applies tableStyle and headingStyle", () => {
    const full = lines({}, "full")
    expect(full.some((row) => row.includes("╭─ ts"))).toBe(true)
    expect(full.some((row) => row.includes("═══"))).toBe(true)
    const rules = lines({ tableStyle: "rules", headingStyle: "bold" }, "full")
    expect(rules.some((row) => row.includes("┌"))).toBe(false)
    expect(rules.some((row) => row.includes("═"))).toBe(false)
  })

  test("balanced is calmer: bold headings and a button on code only", () => {
    const balanced = lines({}, "balanced")
    expect(balanced.some((row) => row.includes("═"))).toBe(false)
    expect(balanced.some((row) => row.includes("╭─ ts"))).toBe(true)
    expect(balanced.some((row) => row.includes("╭─ table"))).toBe(false)
  })

  test("minimal and the markdown renderer stay plain, and changing the setting redraws", () => {
    expect(lines({}, "minimal").some((row) => row.includes("╭─"))).toBe(false)
    expect(lines({ messageRenderer: "markdown" }, "full").some((row) => row.includes("╭─"))).toBe(false)
    const transcript = exchange({}, "full")
    expect(transcript.viewport(60, 30).some((line) => line.text.includes("╭─ ts"))).toBe(true)
    transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, markdownCopyHints: "off", reasoning: "auto", toolOutput: "auto" })
    const rows = transcript.viewport(60, 30)
    expect(rows.some((line) => line.copy?.some((region) => region.to > region.from))).toBe(false)
    expect(rows.some((line) => line.copy)).toBe(true)
    expect(rows.some((line) => line.text.includes("╭─ ts"))).toBe(true)
  })

  test("rows carry their copy buttons to the view, shifted by the message gutter", () => {
    const rows = exchange({}, "full").viewport(60, 30)
    const header = rows.find((line) => line.text.includes("╭─ ts"))!
    const [button] = header.copy!
    expect(header.text.slice(button!.from, button!.to)).toBe("copy")
    expect(button!.text).toBe("x")
  })

  test("the colour overrides of the profile reach the SGR output", () => {
    const transcript = exchange({}, "full")
    transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, markdownColors: '{"mdHeading1":"#123456"}', reasoning: "auto", toolOutput: "auto" })
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).toBe("\x1b[38;2;18;52;86m")
    transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, reasoning: "auto", toolOutput: "auto" })
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).not.toBe("\x1b[38;2;18;52;86m")
  })
})
