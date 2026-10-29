import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import { customizePageKey, customizePreview, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { scrollThumb } from "../src/view/scroll-chrome"
import { setTheme } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

afterEach(() => { cleanTemps(); setTheme("mend") })

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const WHEEL_UP = "\x1b[<64;40;10M"
const TURN_AT = 1_800_000_000_000
const SIZES = [[60, 24], [80, 24], [120, 40], [200, 50]] as const
/** `none` hides the sessions sidebar, `left` is the automatic one, `both` adds the right panel (it needs 150 columns). */
type Side = "none" | "left" | "both"
const SIDES = (width: number): Side[] => (width >= 200 ? ["none", "left", "both"] : width >= 110 ? ["none", "left"] : ["none"])
const LONG = Array.from({ length: 90 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} of the answer: the quick brown fox jumps over the lazy dog and keeps going until the row wraps`).join("\n\n")
const FILL = Array.from({ length: 40 }, (_, i) => `result ${i + 1}: everything checked out`).join("\n\n")

type Scene = { width: number; height: number; side?: Side; profile?: Partial<TuiProfile>; clock?: { at: number }; reduced?: boolean }

async function scene({ width, height, side = "none", profile = {}, clock, reduced }: Scene) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: side === "none" ? "hidden" : "auto", ...(side === "both" ? { rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.pulse) } : {}), ...profile })
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode: "full", now: () => clock?.at ?? TURN_AT + 173_000 })
  h.app.applySettings({ onboarded: true, ...(reduced ? { reducedMotion: true } : {}) })
  await Bun.sleep(10)
  return { h, dataDir, talk: conversation(h.sessionId, h.app.onEvent) }
}

const rows = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))
const promptRow = (lines: string[]) => lines.findIndex((line) => line.includes("❭"))
/** The prompt's top rule: the row above the first prompt row. */
const ruleRow = (lines: string[]) => promptRow(lines) - 1
const lastResult = (lines: string[]) => lines.findLastIndex((line) => /result \d+/.test(line))

function startTurn(h: Harness, state: "generating" | "tool" = "generating") {
  const turnId = ids("turn")
  h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: 900, at: TURN_AT, turnId, queueId: ids("queue") } as never)
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 500, state, turnId } as never)
  h.app.onEvent({ type: "usage.recorded", sessionId: h.sessionId, seq: 902, at: TURN_AT + 2_000, turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 1_240, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never)
  return turnId
}

describe("activity status placement", () => {
  for (const [width, height] of SIZES) {
    for (const side of SIDES(width)) {
      for (const theme of ["mend", "paper"]) {
        test(`${width}x${height} sidebars ${side}, ${theme}: above and inside take no row, off draws nothing, the classic row pushes the text up`, async () => {
          setTheme(theme)
          const classic = await scene({ width, height, side })
          classic.talk.exchange("Explain the results", FILL)
          const idle = rows(classic.h)
          startTurn(classic.h)
          const busy = rows(classic.h)
          expect(busy[ruleRow(busy) - 1]).toContain("Generating...")
          // Today's look, kept as the default: the row is taken from the transcript, which moves up by one.
          expect(ruleRow(busy)).toBe(ruleRow(idle))
          expect(lastResult(busy)).toBe(lastResult(idle) - 1)

          for (const placement of ["above", "inside", "off"] as const) {
            const { h, talk } = await scene({ width, height, side, profile: { activityPlacement: placement } })
            talk.exchange("Explain the results", FILL)
            const before = rows(h)
            const cursorBefore = h.cursors.at(-1)
            startTurn(h)
            const after = rows(h)
            expect(ruleRow(after), placement).toBe(ruleRow(before))
            expect(lastResult(after), placement).toBe(lastResult(before))
            expect(after.length).toBe(before.length)
            expect(h.cursors.at(-1), placement).toEqual(cursorBefore)
            if (placement === "off") expect(after.join("\n")).not.toContain("Generating...")
            else expect(after.filter((line) => line.includes("Generating...")), placement).toHaveLength(1)
            for (const line of after) expect(textWidth(line)).toBeLessThanOrEqual(width)
            if (placement === "above") {
              expect(after[ruleRow(after)]).toMatch(/─{2} \S Generating\.\.\. · \d+m \d+s/)
              expect(after[ruleRow(after)]).toMatch(/─{4,}\s*$/)
            }
            if (placement === "inside") {
              const first = after[promptRow(after)]!
              expect(first).toMatch(/❭\s+\S Generating\.\.\. · \d+m \d+s/)
              expect(first.indexOf("❭")).toBe(before[promptRow(before)]!.indexOf("❭"))
            }
          }
        })
      }
    }
  }

  test("the status comes back when the turn ends and the rule is plain again", async () => {
    const { h, talk } = await scene({ width: 100, height: 26, profile: { activityPlacement: "above" } })
    talk.exchange("hello", "there")
    const idle = rows(h)
    expect(idle[ruleRow(idle)]).toMatch(/^\s*─+\s*$/)
    const turnId = startTurn(h)
    expect(rows(h)[ruleRow(rows(h))]).toContain("Generating...")
    h.app.onEvent({ type: "turn.completed", sessionId: h.sessionId, seq: 910, at: TURN_AT + 5_000, turnId } as never)
    h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 911, at: TURN_AT + 5_000, state: "idle" } as never)
    const done = rows(h)
    expect(done[ruleRow(done)]).toMatch(/^\s*─+\s*$/)
    expect(ruleRow(done)).toBe(ruleRow(idle))
  })

  test("inside leaves the typed text and the cursor alone, and gives way when the text needs the room", async () => {
    const { h } = await scene({ width: 80, height: 24, profile: { activityPlacement: "inside" } })
    await h.type("fix the tests")
    const typed = rows(h)
    const cursor = h.cursors.at(-1)
    startTurn(h)
    const busy = rows(h)
    expect(busy[promptRow(busy)]).toMatch(/^ {2}❭ fix the tests {2,}\S Generating\.\.\./)
    expect(h.cursors.at(-1)).toEqual(cursor)
    // Everything else on screen is as it was before the turn started.
    const same = (lines: string[]) => lines.filter((_, index) => index !== promptRow(lines) && index > 0 && index < lines.length - 1)
    expect(same(busy)).toEqual(same(typed))
    // Text that leaves too little room: the status steps down to the spinner and the time, then leaves, and not a character of the text is cut.
    await h.type("x".repeat(28))
    const core = rows(h)
    expect(core[promptRow(core)]).toContain("fix the tests" + "x".repeat(28))
    expect(core[promptRow(core)]).toMatch(/Generating\.\.\. · 2m 53s\s*$/)
    expect(core[promptRow(core)]).not.toContain("tokens")
    await h.type("x".repeat(12))
    const tight = rows(h)
    expect(tight[promptRow(tight)]).toContain("fix the tests" + "x".repeat(40))
    expect(tight[promptRow(tight)]).toMatch(/\S 2m 53s\s*$/)
    expect(tight[promptRow(tight)]).not.toContain("Generating")
    await h.type("x".repeat(12))
    const full = rows(h)
    expect(full[promptRow(full)]).toContain("fix the tests" + "x".repeat(52))
    expect(full.join("\n")).not.toContain("2m 53s")
    expect(full[promptRow(full)]).not.toContain("…")
  })

  test("the Esc hint stays visible in every placement, including off", async () => {
    for (const placement of ["transcript", "above", "inside", "off"] as const) {
      const { h, talk } = await scene({ width: 100, height: 26, profile: { activityPlacement: placement } })
      talk.exchange("hello", "there")
      startTurn(h)
      await h.app.onKey("\x1b")
      expect(rows(h).join("\n"), placement).toContain("[esc again to interrupt]")
    }
  })

  test("reduced motion draws a still spinner in every placement", async () => {
    for (const placement of ["transcript", "above", "inside"] as const) {
      const { h, talk } = await scene({ width: 100, height: 26, reduced: true, profile: { activityPlacement: placement } })
      talk.exchange("hello", "there")
      startTurn(h)
      const first = rows(h).find((line) => line.includes("Generating..."))!
      expect(first, placement).toContain("⋯ Generating...")
      h.app.onEvent({ type: "usage.recorded", sessionId: h.sessionId, seq: 903, at: TURN_AT + 3_000, turnId: ids("turn"), provider: "p", model: "m", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never)
      expect(rows(h).find((line) => line.includes("Generating..."))!.replace(/\d+m \d+s/, "")).toContain("⋯ Generating...")
    }
  })

  test("the parts are ordered and toggled by the profile; tokens per second and the queue are opt-in", async () => {
    const queued = (h: Harness) => h.app.onEvent({ type: "queue.changed", sessionId: h.sessionId, seq: 905, at: TURN_AT + 3_000, queue: [{ queueId: ids("queue"), preview: "then lint it", attachments: 0 }] } as never)
    const plainRow = await scene({ width: 120, height: 26, profile: { activityPlacement: "above" } })
    plainRow.talk.exchange("hello", "there")
    startTurn(plainRow.h)
    queued(plainRow.h)
    const row = rows(plainRow.h)[ruleRow(rows(plainRow.h))]!
    expect(row).toContain("Generating... · 2m 53s · ↑1,000 ↓1,240 tokens")
    expect(row).not.toContain("queued")
    expect(row).not.toContain("tok/s")

    const custom = await scene({ width: 120, height: 26, profile: { activityPlacement: "above", activityParts: "elapsed,spinner,verb,queue,tps" } })
    custom.talk.exchange("hello", "there")
    startTurn(custom.h)
    queued(custom.h)
    expect(rows(custom.h)[ruleRow(rows(custom.h))]).toMatch(/2m 53s · \S Generating\.\.\. · 1 queued · 7 tok\/s/)

    // The older toggles still switch their part off.
    const toggled = await scene({ width: 120, height: 26, profile: { activityPlacement: "above", showElapsed: false, showTokens: false } })
    toggled.talk.exchange("hello", "there")
    startTurn(toggled.h)
    const gated = rows(toggled.h)[ruleRow(rows(toggled.h))]!
    expect(gated).toContain("Generating...")
    expect(gated).not.toContain("2m")
    expect(gated).not.toContain("tokens")
  })

  test("the placement is one setting with a command and a stored value", async () => {
    const { h, dataDir } = await scene({ width: 100, height: 26 })
    await h.type("/activity above\r")
    expect(readTuiProfile(dataDir).activityPlacement).toBe("above")
    await h.type("/activity inside\r")
    expect(readTuiProfile(dataDir).activityPlacement).toBe("inside")
    await h.type("/activity off\r")
    expect(readTuiProfile(dataDir).activityPlacement).toBe("off")
    await h.type("/activity transcript\r")
    expect(readTuiProfile(dataDir).activityPlacement).toBe("transcript")
    await h.type("/activity +tps -model\r")
    expect(readTuiProfile(dataDir).activityParts).toBe("spinner,verb,elapsed,stalled,tokens,interrupt,tps")
    await h.type("/activity reset\r")
    expect(readTuiProfile(dataDir).activityParts).toBe(DEFAULT_TUI_PROFILE.activityParts)
    await h.type("/activity sideways\r")
    expect(h.text().join("\n")).toContain("usage: /activity")
    await h.type("/activity\r")
    expect(h.text().join("\n")).toContain("Activity status")
  })
})

describe("the jump-to-latest button", () => {
  /** A long session scrolled up by two notches. */
  async function scrolled(options: Scene) {
    const s = await scene(options)
    s.talk.exchange("Count for me", LONG)
    rows(s.h)
    await s.h.app.onKey(WHEEL_UP)
    await s.h.app.onKey(WHEEL_UP)
    return s
  }
  const pillRow = (lines: string[]) => lines.findIndex((line) => /↓ (latest|\d+ new)/.test(line))

  for (const [width, height] of SIZES) {
    for (const side of SIDES(width)) {
      test(`${width}x${height} sidebars ${side}: visible whenever the view is off the bottom, gone at the bottom, and a click or End follows the newest output`, async () => {
        const { h } = await scrolled({ width, height, side })
        const lines = rows(h)
        const at = pillRow(lines)
        expect(at, "the button is drawn").toBeGreaterThan(-1)
        expect(at).toBe(ruleRow(lines) - 1)
        expect(lines[at]).toContain("↓ latest · End")
        expect(lines.join("\n")).not.toContain("line 90 of the answer")
        const col = lines[at]!.indexOf("↓ latest")
        // Inside the chat column, never over a sidebar or the bar.
        expect(col).toBeGreaterThan(lines[at]!.indexOf("line") >= 0 ? 0 : -1)
        await h.app.onKey(press(col + 2, at))
        await h.app.onKey(release(col + 2, at))
        const after = rows(h)
        expect(pillRow(after)).toBe(-1)
        expect(after.join("\n")).toContain("line 90 of the answer")

        await h.app.onKey(WHEEL_UP)
        expect(pillRow(rows(h))).toBeGreaterThan(-1)
        await h.app.onKey("\x1b[F")
        expect(pillRow(rows(h))).toBe(-1)
      })
    }
  }

  test("the owner's session: full view, both sidebars, 200 columns, scrolled up in a long transcript", async () => {
    const { h } = await scrolled({ width: 210, height: 60, side: "both" })
    const lines = rows(h)
    expect(pillRow(lines)).toBeGreaterThan(-1)
    expect(lines.some((line) => line.includes("Agent"))).toBe(true)
    // The pill is a fill, not the old muted text: it carries a background.
    const spans = h.frames.at(-1)![pillRow(lines)]!
    expect(spans.some((span) => span.text.includes("↓") && span.bg === "panel" && span.fg === "primary")).toBe(true)
  })

  test("it says how many rows arrived below while the reader was away, and starts again after following", async () => {
    const { h, talk } = await scrolled({ width: 100, height: 30 })
    expect(rows(h)[pillRow(rows(h))]).toContain("↓ latest")
    talk.exchange("And again", Array.from({ length: 6 }, (_, i) => `later ${i}`).join("\n\n"))
    const text = rows(h)[pillRow(rows(h))]!
    const count = Number(/↓ (\d+) new/.exec(text)?.[1])
    expect(count).toBeGreaterThanOrEqual(6)
    talk.exchange("One more", "one more answer")
    expect(Number(/↓ (\d+) new/.exec(rows(h)[pillRow(rows(h))]!)?.[1])).toBeGreaterThan(count)
    await h.app.onKey("\x1b[F")
    await h.app.onKey(WHEEL_UP)
    expect(rows(h)[pillRow(rows(h))]).toContain("↓ latest")
  })

  test("End is named only while it works: with text in the prompt the button is just the arrow and the count", async () => {
    const { h } = await scrolled({ width: 100, height: 30 })
    await h.type("hello")
    const line = rows(h)[pillRow(rows(h))]!
    expect(line).toContain("↓ latest")
    expect(line).not.toContain("End")
  })

  test("position and text are settings: left, centre, right, off, and a template", async () => {
    const cols: Record<string, number> = {}
    for (const jumpHint of ["left", "center", "right"] as const) {
      const { h } = await scrolled({ width: 100, height: 30, profile: { jumpHint } })
      const lines = rows(h)
      cols[jumpHint] = lines[pillRow(lines)]!.indexOf("↓")
    }
    expect(cols.left!).toBeLessThan(cols.center!)
    expect(cols.center!).toBeLessThan(cols.right!)
    expect(cols.left).toBe(3)
    const off = await scrolled({ width: 100, height: 30, profile: { jumpHint: "off" } })
    expect(rows(off.h).join("\n")).not.toContain("↓ latest")
    const custom = await scrolled({ width: 100, height: 30, profile: { jumpText: "{n} below · {key}" } })
    custom.talk.exchange("again", "x\n\ny\n\nz")
    expect(rows(custom.h).join("\n")).toMatch(/\d+ below · End/)
  })

  test("its command and its alias set the position", async () => {
    const { h, dataDir } = await scene({ width: 100, height: 26 })
    await h.type("/jump-to-latest left\r")
    expect(readTuiProfile(dataDir).jumpHint).toBe("left")
    await h.type("/jump off\r")
    expect(readTuiProfile(dataDir).jumpHint).toBe("off")
    await h.type("/jump center\r")
    expect(readTuiProfile(dataDir).jumpHint).toBe("center")
    await h.type("/jump-to-latest up\r")
    expect(h.text().join("\n")).toContain("usage: /jump-to-latest")
    await h.type("/jump-to-latest\r")
    expect(h.text().join("\n")).toContain("Jump to latest")
  })
})

describe("the scrollbar", () => {
  const thumbRows = (lines: string[], col: number) => lines.flatMap((line, row) => (line[col] === "┃" ? [row] : []))

  async function chat(options: Scene) {
    const s = await scene(options)
    s.talk.exchange("Count for me", LONG)
    rows(s.h)
    return s
  }

  /** Where the bar is in a frame of a long session at the bottom with `always`: its column, and the first and last row of the transcript. */
  function geometry(lines: string[]) {
    const bodyEnd = ruleRow(lines) - 1
    const col = [...lines[bodyEnd]!].lastIndexOf("┃")
    let top = bodyEnd
    while (top > 0 && ["│", "┃"].includes(lines[top - 1]![col] ?? "")) top--
    return { bodyEnd, col, top }
  }

  test("off is today's look: no bar and the text uses the whole column", async () => {
    const { h } = await chat({ width: 80, height: 24 })
    await h.app.onKey(WHEEL_UP)
    const lines = rows(h)
    expect(lines.every((line) => !line.endsWith("┃"))).toBe(true)
    expect(Math.max(...lines.map((line) => textWidth(line.trimEnd())))).toBeGreaterThanOrEqual(79)
  })

  for (const [width, height] of SIZES) {
    for (const side of SIDES(width)) {
      test(`${width}x${height} sidebars ${side}: auto draws a proportional thumb off the bottom and keeps its column free when hidden`, async () => {
        const hidden = await chat({ width, height, side, profile: { scrollbar: "auto" } })
        const atBottom = rows(hidden.h)
        const always = await chat({ width, height, side, profile: { scrollbar: "always" } })
        const shownBottom = rows(always.h)
        const off = await chat({ width, height, side })
        const offRows = rows(off.h)
        const { bodyEnd, col, top } = geometry(shownBottom)
        expect(col).toBeGreaterThan(0)
        // The column is reserved either way: hiding or showing the bar changes nothing left of it.
        for (let row = top; row <= bodyEnd; row++) expect(atBottom[row]!.padEnd(col + 1).slice(0, col), `row ${row}`).toBe(shownBottom[row]!.padEnd(col + 1).slice(0, col))
        // The bar's own column holds nothing but the bar: text never reaches it.
        for (let row = top; row <= bodyEnd; row++) expect(atBottom[row]![col] ?? " ", `row ${row}`).toBe(" ")
        // Without the bar the transcript is laid out one column wider.
        expect(offRows.length).toBe(atBottom.length)
        // Hidden at the bottom, `always` has the thumb touching the last body row.
        expect(thumbRows(shownBottom, col).at(-1)).toBe(bodyEnd)
        expect(thumbRows(atBottom, col)).toEqual([])

        await hidden.h.app.onKey(WHEEL_UP)
        await hidden.h.app.onKey(WHEEL_UP)
        const up = rows(hidden.h)
        const thumb = thumbRows(up, col)
        expect(thumb.length).toBeGreaterThan(0)
        // A track runs the whole body, the thumb is one run of cells inside it.
        for (let row = top; row <= bodyEnd; row++) expect(["│", "┃"], `row ${row}`).toContain(up[row]![col])
        expect(thumb.every((row, index) => index === 0 || row === thumb[index - 1]! + 1)).toBe(true)
      })
    }
  }

  test("the thumb sits where the view is: at the end of the track at the bottom, at its start at the top", async () => {
    const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "always" } })
    const { bodyEnd, col } = geometry(rows(h))
    const atBottom = thumbRows(rows(h), col)
    expect(atBottom.at(-1)).toBe(bodyEnd)
    await h.app.onKey("\x1b[H")
    // At the top the pinned prompt row is gone and the track starts one row higher.
    const lines = rows(h)
    const atTop = thumbRows(lines, col)
    expect(atTop[0]).toBe(lines.findIndex((line) => ["│", "┃"].includes(line[col] ?? "")))
    expect(atBottom.length).toBe(atTop.length)
    // About 270 rows of transcript seen through a 25-row view: a thumb of a couple of cells in a track of 25.
    expect(atTop.length).toBeGreaterThanOrEqual(1)
    expect(atTop.length).toBeLessThanOrEqual(4)
  })

  test("half a screen of transcript past the view makes a thumb of about half the track", async () => {
    const { h, talk } = await scene({ width: 100, height: 30, profile: { scrollbar: "always" } })
    talk.exchange("Count for me", Array.from({ length: 12 }, (_, i) => `short ${i}`).join("\n\n"))
    const lines = rows(h)
    const { bodyEnd, col, top } = geometry(lines)
    const track = bodyEnd - top + 1
    const thumb = thumbRows(lines, col)
    expect(thumb.length).toBeGreaterThan(track / 2)
    expect(thumb.length).toBeLessThan(track)
    expect(thumb.at(-1)).toBe(bodyEnd)
  })

  test("auto stays a moment after a scroll, also at the bottom, then goes", async () => {
    const clock = { at: TURN_AT }
    const { h } = await chat({ width: 100, height: 30, clock, profile: { scrollbar: "auto" } })
    expect(thumbRows(rows(h), 99)).toEqual([])
    await h.app.onKey(WHEEL_UP)
    await h.app.onKey("\x1b[F")
    expect(thumbRows(rows(h), 99).length).toBeGreaterThan(0)
    clock.at += 1_000
    expect(thumbRows(rows(h), 99).length).toBeGreaterThan(0)
    clock.at += 400
    expect(thumbRows(rows(h), 99)).toEqual([])
  })

  test("a press on the track pages toward it, the thumb drags, a release lets go", async () => {
    const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "always" } })
    const lines0 = rows(h)
    const { bodyEnd, col: barCol, top } = geometry(lines0)
    const first = (lines: string[]) => Number(/line (\d+) of the answer/.exec(lines.find((line) => /line \d+ of the answer/.test(line)) ?? "")?.[1])
    const bottomLine = first(lines0)
    // Above the thumb: one page up.
    await h.app.onKey(press(barCol, top))
    await h.app.onKey(release(barCol, top))
    const paged = rows(h)
    expect(first(paged)).toBeLessThan(bottomLine)
    const page = bottomLine - first(paged)
    expect(page).toBeGreaterThan(0)
    // Below it: back down.
    await h.app.onKey(press(barCol, bodyEnd))
    await h.app.onKey(release(barCol, bodyEnd))
    expect(first(rows(h))).toBeGreaterThan(first(paged))
    // The thumb: grab it where it is and drag to the top of the track.
    const thumb = thumbRows(rows(h), barCol)
    await h.app.onKey(press(barCol, thumb[0]!))
    await h.app.onKey(drag(barCol, top - 1))
    expect(first(rows(h))).toBe(1)
    await h.app.onKey(drag(barCol, bodyEnd))
    expect(rows(h).join("\n")).toContain("line 90 of the answer")
    await h.app.onKey(release(barCol, bodyEnd))
    // Let go: further motion is not a drag of the thumb.
    await h.app.onKey(drag(barCol, top))
    expect(rows(h).join("\n")).toContain("line 90 of the answer")
  })

  test("with a sessions sidebar the bar is still under the pointer", async () => {
    const { h } = await chat({ width: 150, height: 30, side: "left", profile: { scrollbar: "always" } })
    const lines = rows(h)
    const { col, top } = geometry(lines)
    expect(col).toBeGreaterThan(39)
    const before = lines.join("\n")
    await h.app.onKey(press(col, top))
    await h.app.onKey(release(col, top))
    expect(rows(h).join("\n")).not.toBe(before)
  })

  test("a click on the text beside the bar is not a bar click", async () => {
    const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "always" } })
    const before = rows(h).join("\n")
    await h.app.onKey(press(90, 1))
    await h.app.onKey(release(90, 1))
    expect(rows(h).join("\n")).toBe(before)
  })

  test("glyphs are settings: custom thumb and track, or a thumb alone with no track", async () => {
    const both = await chat({ width: 100, height: 30, profile: { scrollbar: "always", scrollbarGlyphs: "█░" } })
    const lines = rows(both.h)
    const bodyEnd = ruleRow(lines) - 1
    expect(lines.slice(bodyEnd - 8, bodyEnd - 2).map((line) => line[99])).toEqual(Array(6).fill("░"))
    expect(lines[bodyEnd]![99]).toBe("█")
    const none = await chat({ width: 100, height: 30, profile: { scrollbar: "always", scrollbarGlyphs: "█" } })
    const bare = rows(none.h)
    expect(bare.slice(bodyEnd - 8, bodyEnd - 2).map((line) => line[99] ?? " ")).toEqual(Array(6).fill(" "))
    expect(bare[bodyEnd]![99]).toBe("█")
  })

  test("the colours are theme tokens, in a light and a dark theme", async () => {
    for (const theme of ["mend", "paper"]) {
      setTheme(theme)
      const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "always" } })
      rows(h)
      const body = h.frames.at(-1)!.slice(1, 10)
      const cells = body.map((line) => line.at(-1)!)
      expect(cells.every((span) => span.fgHex === undefined && span.bgHex === undefined), theme).toBe(true)
      expect(cells.some((span) => span.fg === "border")).toBe(true)
      expect(h.frames.at(-1)!.some((line) => line.at(-1)?.fg === "primary" && line.at(-1)?.text === "┃")).toBe(true)
    }
  })

  test("the jump button never covers the bar", async () => {
    const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "always", jumpHint: "right" } })
    await h.app.onKey(WHEEL_UP)
    const lines = rows(h)
    const at = lines.findIndex((line) => line.includes("↓ latest"))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at]!.at(-1)).toMatch(/[┃│]/)
    expect(lines[at]!.indexOf("↓ latest") + "↓ latest · End".length).toBeLessThan(98)
  })

  test("the commands set the mode; bare it switches between off and always", async () => {
    const { h, dataDir } = await scene({ width: 100, height: 26 })
    await h.type("/scrollbar auto\r")
    expect(h.app.accessibility.profile.scrollbar).toBe("auto")
    await h.type("/scrollbar always\r")
    expect(h.app.accessibility.profile.scrollbar).toBe("always")
    // A slash command changes this session's screen; the stored profile, every terminal's default, is left alone.
    expect(readTuiProfile(dataDir).scrollbar).not.toBe("always")
    await h.type("/scrollbar\r")
    expect(h.app.accessibility.profile.scrollbar).toBe("off")
    await h.type("/scrollbar\r")
    expect(h.app.accessibility.profile.scrollbar).toBe("always")
    await h.type("/scrollbar sometimes\r")
    expect(h.text().join("\n")).toContain("usage: /scrollbar auto|always|off")
    expect(h.app.accessibility.profile.scrollbar).toBe("always")
  })

  test("turning it on reflows the text once and showing and hiding afterwards never does", async () => {
    const { h } = await chat({ width: 100, height: 30, profile: { scrollbar: "auto" } })
    const quiet = rows(h).slice(1, 20).map((line) => line.slice(0, 99))
    await h.app.onKey(WHEEL_UP)
    await h.app.onKey("\x1b[F")
    const shown = rows(h).slice(1, 20).map((line) => line.slice(0, 99))
    expect(shown).toEqual(quiet)
  })
})

describe("scroll speed", () => {
  test("a wheel notch moves `wheelLines` rows (3 by default), one frame's worth of work per notch", async () => {
    // A code block is one transcript row per line, so the row numbers count rows scrolled.
    const code = `\`\`\`\n${Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n")}\n\`\`\``
    const last = (list: string[]) => Number(/row (\d+)/.exec(list.findLast((line) => /row \d+/.test(line)) ?? "")?.[1])
    for (const lines of [3, 7]) {
      const { h, talk } = await scene({ width: 100, height: 30, profile: { wheelLines: lines } })
      talk.exchange("Count for me", code)
      // Rows under the last numbered line (the closing fence) are scrolled away first, so measure from the first notch.
      await h.app.onKey(WHEEL_UP)
      const one = last(rows(h))
      await h.app.onKey(WHEEL_UP)
      expect(one - last(rows(h))).toBe(lines)
      for (let i = 0; i < 8; i++) await h.app.onKey(WHEEL_UP)
      expect(one - last(rows(h))).toBe(lines * 9)
      await h.app.onKey("\x1b[<65;40;10M")
      expect(one - last(rows(h))).toBe(lines * 8)
    }
  })
})

describe("the customize page", () => {
  test("every new setting has a row, and the choices cycle", () => {
    for (const row of ["scrollbar", "scrollbarGlyphs", "jumpHint", "jumpText", "activityPlacement", "activityParts"]) expect(CUSTOMIZE_ROWS).toContain(row as never)
    const key = (row: string, press: string, profile: TuiProfile = DEFAULT_TUI_PROFILE) => customizePageKey({ row: CUSTOMIZE_ROWS.indexOf(row as never) }, press, profile)
    expect(key("scrollbar", "\x1b[C").action).toEqual({ type: "set", patch: { scrollbar: "auto" } })
    expect(key("scrollbar", "\x1b[C", { ...DEFAULT_TUI_PROFILE, scrollbar: "auto" }).action).toEqual({ type: "set", patch: { scrollbar: "always" } })
    expect(key("jumpHint", "\x1b[C").action).toEqual({ type: "set", patch: { jumpHint: "center" } })
    expect(key("activityPlacement", "\x1b[C").action).toEqual({ type: "set", patch: { activityPlacement: "above" } })
    expect(key("activityPlacement", "\x1b[D").action).toEqual({ type: "set", patch: { activityPlacement: "off" } })
  })

  test("the text rows check what is typed", () => {
    const at = (row: string, typing: string) => customizePageKey({ row: CUSTOMIZE_ROWS.indexOf(row as never), typing }, "\r", DEFAULT_TUI_PROFILE)
    expect(at("activityParts", "spinner,bogus").state.error).toContain("Unknown part")
    expect(at("activityParts", "elapsed,spinner").action).toEqual({ type: "set", patch: { activityParts: "elapsed,spinner" } })
    expect(at("scrollbarGlyphs", "abc").state.error).toContain("thumb")
    expect(at("scrollbarGlyphs", "█░").action).toEqual({ type: "set", patch: { scrollbarGlyphs: "█░" } })
    expect(at("jumpText", "{n} below").action).toEqual({ type: "set", patch: { jumpText: "{n} below" } })
  })

  test("the preview draws the status as the live frame will", () => {
    const preview = (activityPlacement: TuiProfile["activityPlacement"], extra: Partial<TuiProfile> = {}) => customizePreview({
      profile: { ...DEFAULT_TUI_PROFILE, activityPlacement, ...extra }, preview: { root: "/work", tip: "", now: 0, model: "luna" }, screenHeight: 30, width: 80, height: 14, glyphs: { ...appHarnessGlyphs }, surface: "status",
    }).map(plain)
    const above = preview("above")
    expect(above.findIndex((line) => line.includes("Generating..."))).toBe(above.findIndex((line) => line.includes("❭")) - 1)
    expect(above.find((line) => line.includes("Generating..."))).toMatch(/─{2} \S Generating\.\.\. · 1m 21s/)
    const inside = preview("inside")
    expect(inside.find((line) => line.includes("❭"))).toContain("Generating...")
    const classic = preview("transcript")
    expect(classic[classic.findIndex((line) => line.includes("❭")) - 2]).toContain("Generating...")
    expect(preview("off").join("\n")).not.toContain("Generating...")
    expect(preview("above", { activityParts: "elapsed,spinner" }).join("\n")).toMatch(/1m 21s · \S/)
  })
})

import { glyphs as defaultGlyphs } from "../src/ui/theme"
const appHarnessGlyphs = defaultGlyphs({})
