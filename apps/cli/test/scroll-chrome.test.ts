import { afterAll, describe, expect, test } from "bun:test"
import { ACTIVITY_PARTS, ACTIVITY_PARTS_DEFAULT, tuiProblems, TUI_DEFAULTS, TUI_ENUMS } from "@mendcode/protocol/wire"
import { glyphs, setTheme, sgr, themeNames, activeTheme, type Line } from "../src/ui/theme"
import { THEMES } from "../src/themes"
import { jumpFrom, jumpPill, jumpText, offsetForThumb, overlayAt, scrollbarGlyphs, scrollbarShown, scrollThumb, withScrollbar } from "../src/view/scroll-chrome"
import { ACTIVITY_MIN_CELLS, insideRoom, parseActivityCommand, placeInside } from "../src/view/activity-status"
import { activityPartsOf, quietTurn, renderWorkingRow, STALL_AFTER_MS, THINKING_STALL_AFTER_MS } from "../src/view/working-row"
import { DEFAULT_TUI_PROFILE, normalizeActivityParts, normalizeScrollbarGlyphs, normalizeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")
const g = glyphs({})
afterAll(() => { setTheme("mend") })

describe("scrollbar geometry", () => {
  test("nothing is drawn while the transcript fits", () => {
    expect(scrollThumb({ rows: 20, total: 20, viewport: 20, offset: 0 })).toBeUndefined()
    expect(scrollThumb({ rows: 20, total: 12, viewport: 20, offset: 0 })).toBeUndefined()
  })

  test("the thumb is as long as the view is of the transcript and never shorter than a cell", () => {
    expect(scrollThumb({ rows: 20, total: 40, viewport: 20, offset: 0 })).toEqual({ top: 10, length: 10 })
    expect(scrollThumb({ rows: 20, total: 40, viewport: 20, offset: 20 })).toEqual({ top: 0, length: 10 })
    expect(scrollThumb({ rows: 20, total: 20_000, viewport: 20, offset: 5 })!.length).toBe(1)
  })

  test("at the bottom the thumb touches the end of the track, at the top its start", () => {
    for (const rows of [5, 17, 40]) {
      const bottom = scrollThumb({ rows, total: 500, viewport: rows, offset: 0 })!
      const top = scrollThumb({ rows, total: 500, viewport: rows, offset: 500 - rows })!
      expect(bottom.top + bottom.length).toBe(rows)
      expect(top.top).toBe(0)
    }
  })

  test("dragging inverts the thumb: the offset for a thumb position puts the thumb there", () => {
    const rows = 24, total = 900, viewport = 24
    for (let top = 0; top <= rows - scrollThumb({ rows, total, viewport, offset: 0 })!.length; top++) {
      const offset = offsetForThumb({ rows, total, viewport, top })
      expect(Math.abs(scrollThumb({ rows, total, viewport, offset })!.top - top)).toBeLessThanOrEqual(1)
    }
    expect(offsetForThumb({ rows, total, viewport, top: 0 })).toBe(total - viewport)
    expect(offsetForThumb({ rows, total, viewport, top: rows })).toBe(0)
  })

  test("auto shows the bar off the bottom or just after a scroll; always and off ignore both", () => {
    expect(scrollbarShown({ mode: "auto", offset: 0, lingering: false })).toBe(false)
    expect(scrollbarShown({ mode: "auto", offset: 0, lingering: true })).toBe(true)
    expect(scrollbarShown({ mode: "auto", offset: 9, lingering: false })).toBe(true)
    expect(scrollbarShown({ mode: "always", offset: 0, lingering: false })).toBe(true)
    expect(scrollbarShown({ mode: "off", offset: 9, lingering: true })).toBe(false)
  })

  test("glyphs: the set's by default, the profile's when given, one glyph alone draws no track", () => {
    expect(scrollbarGlyphs("", g)).toEqual({ thumb: g.thumb, track: g.track })
    expect(scrollbarGlyphs("█░", g)).toEqual({ thumb: "█", track: "░" })
    expect(scrollbarGlyphs("█", g)).toEqual({ thumb: "█", track: undefined })
    expect(normalizeScrollbarGlyphs("█░")).toBe("█░")
    expect(normalizeScrollbarGlyphs("abc")).toBe("")
    expect(normalizeScrollbarGlyphs("a ")).toBe("")
    expect(normalizeScrollbarGlyphs("漢")).toBe("")
  })

  test("the bar's column is added to every row, hidden or not, so a row is always the full width", () => {
    const rows: Line[] = [[{ text: "one" }], [{ text: "x".repeat(40) }], []]
    const thumb = { top: 1, length: 1 }
    for (const shown of [true, false]) {
      const drawn = withScrollbar({ rows, width: 20, thumb, glyphs: { thumb: "┃", track: "│" }, shown })
      expect(drawn.map((line) => textWidth(text(line)))).toEqual([20, 20, 20])
      expect(drawn.map((line) => text(line).slice(0, 19))).toEqual(withScrollbar({ rows, width: 20, thumb, glyphs: { thumb: "┃", track: "│" }, shown: !shown }).map((line) => text(line).slice(0, 19)))
    }
    const shown = withScrollbar({ rows, width: 20, thumb, glyphs: { thumb: "┃", track: "│" }, shown: true })
    expect(shown.map((line) => line.at(-1))).toEqual([{ text: "│", fg: "border" }, { text: "┃", fg: "primary", bold: true }, { text: "│", fg: "border" }])
    const bare = withScrollbar({ rows, width: 20, thumb, glyphs: { thumb: "┃", track: undefined }, shown: true })
    expect(bare.map((line) => line.at(-1)!.text)).toEqual([" ", "┃", " "])
  })

  test("colours are theme tokens in every built-in theme, light and dark, and thumb and track differ", () => {
    const rows: Line[] = [[], []]
    const [track, thumb] = withScrollbar({ rows, width: 4, thumb: { top: 1, length: 1 }, glyphs: { thumb: "┃", track: "│" }, shown: true }).map((line) => line.at(-1)!)
    expect(track!.fgHex).toBeUndefined()
    expect(thumb!.fgHex).toBeUndefined()
    expect(THEMES.some((theme) => theme.dark)).toBe(true)
    expect(THEMES.some((theme) => !theme.dark)).toBe(true)
    for (const name of themeNames()) {
      setTheme(name)
      expect(sgr(track!, "truecolor"), name).not.toBe(sgr(thumb!, "truecolor"))
      expect(activeTheme().name).toBe(name)
    }
  })
})

describe("the jump button", () => {
  test("its text says how much arrived below, and names End only while End works", () => {
    expect(jumpText({ template: "", unseen: 0, keyHint: true, g })).toBe("↓ latest · End")
    expect(jumpText({ template: "", unseen: 12, keyHint: true, g })).toBe("↓ 12 new · End")
    expect(jumpText({ template: "", unseen: 12, keyHint: false, g })).toBe("↓ 12 new")
    expect(jumpText({ template: "{n} below · {key}", unseen: 3, keyHint: true, g })).toBe("3 below · End")
    expect(jumpText({ template: "back {key}", unseen: 3, keyHint: false, g })).toBe("back")
  })

  test("it is a pill: the arrow in the accent, the rest on a panel fill", () => {
    const pill = jumpPill("↓ 12 new · End", g)
    expect(text(pill)).toBe(" ↓ 12 new · End ")
    expect(pill[0]).toMatchObject({ fg: "primary", bg: "panel", bold: true })
    expect(pill.every((span) => span.fgHex === undefined && span.bg === "panel")).toBe(true)
    expect(text(jumpPill("back", g))).toBe(" back ")
  })

  test("left, centre and right put it where the position says, inside the margin", () => {
    expect(jumpFrom({ position: "left", width: 80, labelWidth: 16, gutter: 0 })).toBe(2)
    expect(jumpFrom({ position: "center", width: 80, labelWidth: 16, gutter: 0 })).toBe(32)
    expect(jumpFrom({ position: "right", width: 80, labelWidth: 16, gutter: 0 })).toBe(62)
  })

  test("overlaying keeps the row's width and the text outside the pill, and refuses what does not fit", () => {
    const row: Line = [{ text: "abcdefghijklmnopqrstuvwxyz", fg: "text" }]
    const drawn = overlayAt({ line: row, width: 30, from: 5, label: [{ text: "[XY]", bg: "panel" }] })!
    expect(text(drawn)).toBe("abcde[XY]jklmnopqrstuvwxyz    ")
    expect(textWidth(text(drawn))).toBe(30)
    expect(overlayAt({ line: row, width: 30, from: 28, label: [{ text: "[XY]" }] })).toBeUndefined()
    expect(overlayAt({ line: row, width: 30, from: -1, label: [{ text: "[XY]" }] })).toBeUndefined()
    const wide = overlayAt({ line: [{ text: "漢字漢字漢字" }], width: 14, from: 3, label: [{ text: "[]" }] })!
    expect(textWidth(text(wide))).toBe(14)
  })
})

describe("the working row's parts", () => {
  const base = { width: 120, margin: 2, spinner: "*", phase: "Generating...", elapsedMs: 81_000, tokens: { input: 45_200, output: 1_240 }, tokensPerSecond: 42, queued: 2, model: "luna", now: 0 }

  test("the default parts draw the classic row, byte for byte", () => {
    expect(text(renderWorkingRow({ ...base, interruptHint: true }))).toBe("  * Generating...  1m 21s  luna  ↑45.2K ↓1,240 tokens  [esc again to interrupt]")
    // While a call streams, its output is an estimate until the provider reports the exact count; an engine that reports no input has no ↑.
    expect(text(renderWorkingRow({ ...base, tokens: { input: 0, output: 310, estimated: true } }))).toBe("  * Generating...  1m 21s  luna  ↓~310 tokens")
    expect(text(renderWorkingRow({ width: 100, margin: 2, spinner: "*", phase: "Generating...", elapsedMs: 90_000, now: 0, stalledMs: 62_000 }))).toBe("  * Generating...  1m 30s  no response for 1m 2s")
  })

  test("the list orders them, leaves out what it does not name, and adds the opt-in ones", () => {
    expect(text(renderWorkingRow({ ...base, parts: activityPartsOf("elapsed,spinner,verb") }))).toBe("  1m 21s  * Generating...")
    expect(text(renderWorkingRow({ ...base, parts: activityPartsOf("spinner,elapsed") }))).toBe("  * 1m 21s")
    expect(text(renderWorkingRow({ ...base, parts: activityPartsOf("spinner,verb,tps,queue") }))).toBe("  * Generating...  42 tok/s  2 queued")
    expect(text(renderWorkingRow({ ...base, parts: activityPartsOf("verb") }))).toBe("  Generating...")
  })

  test("a part with nothing to say is skipped, not drawn empty", () => {
    const row = renderWorkingRow({ width: 80, margin: 0, spinner: "*", phase: "Generating...", now: 0, parts: activityPartsOf("spinner,verb,elapsed,tps,queue,interrupt") })
    expect(text(row)).toBe("* Generating...")
  })

  test("on a rule the parts are set off by the glyph, muted, and keep their own colours", () => {
    const row = renderWorkingRow({ ...base, margin: 0, separator: g.sep, parts: activityPartsOf("spinner,verb,elapsed,tps"), stalledMs: undefined as never })
    expect(text(row)).toBe("* Generating... · 1m 21s · 42 tok/s")
    expect(row.filter((span) => span.text === ` ${g.sep} `).every((span) => span.fg === "muted")).toBe(true)
    expect(text(renderWorkingRow({ ...base, margin: 0, separator: g.sep, parts: activityPartsOf("elapsed,spinner,verb") }))).toBe("1m 21s · * Generating...")
  })

  test("a retry keeps its countdown and the parts after it", () => {
    const retry = { attempt: 2, nextAt: 12_000, message: "429" }
    const row = renderWorkingRow({ ...base, margin: 0, retry, parts: activityPartsOf("spinner,verb,elapsed,queue,interrupt"), interruptHint: true })
    expect(text(row)).toContain("[retrying in 12s attempt #2]")
    expect(text(row)).toEndWith("2 queued  [esc again to interrupt]")
  })

  test("it never draws wider than it is given", () => {
    for (const width of [8, 20, 40]) expect(textWidth(text(renderWorkingRow({ ...base, width, margin: 0, separator: g.sep })))).toBeLessThanOrEqual(width)
  })

  test("the commands: placement words, +/- parts, bare ids in order, reset, and a usage line for a typo", () => {
    expect(parseActivityCommand("", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: {} })
    expect(parseActivityCommand("above", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: { activityPlacement: "above" } })
    expect(parseActivityCommand("transcript", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: { activityPlacement: "transcript" } })
    expect(parseActivityCommand("+tps -model", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: { activityParts: "spinner,verb,elapsed,stalled,tokens,interrupt,tps" } })
    expect(parseActivityCommand("elapsed spinner", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: { activityParts: "elapsed,spinner" } })
    expect(parseActivityCommand("reset", "elapsed")).toEqual({ ok: true, patch: { activityParts: ACTIVITY_PARTS_DEFAULT } })
    expect(parseActivityCommand("-spinner -verb -elapsed -stalled -model -tokens -interrupt", ACTIVITY_PARTS_DEFAULT)).toEqual({ ok: true, patch: { activityParts: ACTIVITY_PARTS_DEFAULT } })
    expect(parseActivityCommand("sideways", "")).toMatchObject({ ok: false })
    expect(parseActivityCommand("+tps elapsed", "")).toMatchObject({ ok: false })
  })
})

describe("inside the prompt", () => {
  const row = (typed: string): Line => [{ text: "  " }, { text: "❭ ", fg: "muted" }, { text: typed, fg: "text" }]

  test("the label ends at the right edge and the typed text is untouched", () => {
    const label: Line = [{ text: "* Generating...", fg: "text" }]
    const drawn = placeInside({ row: row("fix the tests"), width: 60, right: 58, label })
    expect(text(drawn)).toStartWith("  ❭ fix the tests")
    expect(text(drawn)).toEndWith("* Generating..." + "  ")
    expect(textWidth(text(drawn))).toBe(60)
  })

  test("a tinted prompt keeps its fill under the label", () => {
    const tinted: Line = [{ text: "  ❭ ".padEnd(60), bg: "promptBg" }]
    const drawn = placeInside({ row: tinted, width: 60, right: 58, label: [{ text: "busy", fg: "text" }] })
    expect(drawn.every((span) => span.bg === "promptBg")).toBe(true)
  })

  test("the room left by the typed text decides whether there is one", () => {
    expect(insideRoom(4, 58)).toBe(52)
    expect(insideRoom(56, 58)).toBeLessThan(ACTIVITY_MIN_CELLS)
  })
})

describe("the profile", () => {
  test("the parts and the placements are in the shared schema, validated", () => {
    expect(TUI_DEFAULTS.activityParts).toBe(ACTIVITY_PARTS_DEFAULT)
    expect(TUI_DEFAULTS.activityPlacement).toBe("transcript")
    expect(TUI_ENUMS.activityPlacement).toEqual(["transcript", "above", "inside", "off"])
    expect(TUI_ENUMS.scrollbar).toEqual(["auto", "always", "off"])
    expect(TUI_ENUMS.jumpHint).toEqual(["right", "center", "left", "off"])
    expect(tuiProblems({ activityParts: "spinner,tps" })).toEqual([])
    expect(tuiProblems({ activityParts: "spinner,nope" })).toHaveLength(1)
    expect(tuiProblems({ activityPlacement: "beside" })).toHaveLength(1)
    expect(tuiProblems({ scrollbar: "sometimes" })).toHaveLength(1)
    expect(tuiProblems({ scrollbar: true })).toEqual([])
    expect(tuiProblems({ jumpText: "x".repeat(41) })).toHaveLength(1)
    expect(tuiProblems({ scrollbarGlyphs: "abc" })).toHaveLength(1)
    // Only `tps`, `queue` and the session stat parts (cache, ctx, ...) are opt-in; the default row stays what it was.
    expect(ACTIVITY_PARTS.filter((part) => !ACTIVITY_PARTS_DEFAULT.split(",").includes(part))).toEqual(["tps", "queue", "cache", "hit", "ctx", "think", "calls", "spend", "ttft", "effort", "forecast"])
  })

  test("defaults keep today's look: the classic row, no bar, the label on the right", () => {
    expect(DEFAULT_TUI_PROFILE).toMatchObject({ activityPlacement: "transcript", activityParts: ACTIVITY_PARTS_DEFAULT, scrollbar: "off", jumpHint: "right", jumpText: "", scrollbarGlyphs: "" })
  })

  test("an old boolean scrollbar still reads: on is always, off is the default", () => {
    expect(normalizeTuiProfile({ scrollbar: true }).scrollbar).toBe("always")
    expect(normalizeTuiProfile({ scrollbar: false }).scrollbar).toBe("off")
    expect(normalizeTuiProfile({ scrollbar: "auto" }).scrollbar).toBe("auto")
    expect(normalizeTuiProfile({ scrollbar: "bogus" }).scrollbar).toBe("off")
  })

  test("a parts list keeps the known names once each, in order; an unusable list is the default", () => {
    expect(normalizeActivityParts("elapsed, spinner,elapsed,nope,tps")).toBe("elapsed,spinner,tps")
    expect(normalizeActivityParts("")).toBe(ACTIVITY_PARTS_DEFAULT)
    expect(normalizeActivityParts("nope")).toBe(ACTIVITY_PARTS_DEFAULT)
    expect(normalizeActivityParts(7)).toBe(ACTIVITY_PARTS_DEFAULT)
    expect(normalizeTuiProfile({ activityPlacement: "inside", jumpHint: "left", jumpText: "  back   {key} " })).toMatchObject({ activityPlacement: "inside", jumpHint: "left", jumpText: "back {key}" })
    expect(normalizeTuiProfile({ activityPlacement: "nowhere", jumpHint: "up" })).toMatchObject({ activityPlacement: "transcript", jumpHint: "right" })
  })
})

test("a reasoning model's silence is thinking until the thinking allowance, then a stall; a plain model stalls at 45 s", () => {
  const at = (silent: number, reasons: boolean, current?: { kind: "reasoning" }) => quietTurn({ state: "generating", lastEventAt: 0, now: silent, reasons, ...(current ? { current: current as never } : {}) })
  expect(at(STALL_AFTER_MS - 1, true)).toEqual({ thinking: false })
  expect(at(80_000, true)).toEqual({ thinking: true })
  expect(at(THINKING_STALL_AFTER_MS, true)).toEqual({ stalledMs: THINKING_STALL_AFTER_MS, thinking: false })
  expect(at(80_000, false)).toEqual({ stalledMs: 80_000, thinking: false })
  expect(at(80_000, true, { kind: "reasoning" })).toEqual({ thinking: false })
})
