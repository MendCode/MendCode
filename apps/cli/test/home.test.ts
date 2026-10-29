import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { HOME_SECTION_CAPS, homeVisibleSessions, logoRows, renderHome, type HomeSession } from "../src/view/home"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")
const lines = (rows: Line[]) => rows.map(text)
const now = Date.parse("2026-09-28T12:00:00Z")
const minutes = (count: number) => now - count * 60_000
const base = { root: "~/Code/MendCodeV2", version: "0.4.2", now }

const session = (state: HomeSession["state"], title: string, patch: Partial<HomeSession> = {}): HomeSession => ({ id: title, title, state, updatedAt: minutes(5), ...patch })
const mixed: HomeSession[] = [
  session("needs_input", "Approve plan", { startedAt: minutes(12), detail: "Run command: ls" }),
  session("looping", "Fix reconnect", { startedAt: minutes(95) }),
  session("working", "Port palette", { startedAt: minutes(4) }),
  session("working", "Audit storage", { startedAt: minutes(31) }),
  session("completed", "Release notes", { updatedAt: minutes(48) }),
]

describe("home header row", () => {
  test("the root is on the left and MendCode v<version> on the right, both muted, after one empty row", () => {
    const rows = renderHome({ ...base, width: 120, height: 40, screenHeight: 40 })
    expect(rows[0]).toEqual([])
    const header = rows[1]!
    expect(text(header)).toMatch(/^ {2}~\/Code\/MendCodeV2 +MendCode v0\.4\.2$/)
    expect(textWidth(text(header))).toBe(120 - 2)
    expect(header.filter((span) => span.text.trim()).every((span) => span.fg === "muted")).toBe(true)
  })
  test("a version that already starts with v is not doubled, and no version prints just the product", () => {
    expect(text(renderHome({ ...base, version: "v1.2.3", width: 100, height: 30 })[1]!)).toContain("MendCode v1.2.3")
    const bare = text(renderHome({ root: "~/x", width: 100, height: 30, now })[1]!)
    expect(bare.trimEnd().endsWith("MendCode")).toBe(true)
    expect(bare).not.toContain(" v")
  })
  test("a long root is shortened in the middle and keeps the product visible", () => {
    const header = text(renderHome({ ...base, root: `~/${"very-long-directory-name/".repeat(8)}project`, width: 60, height: 30 })[1]!)
    expect(textWidth(header)).toBeLessThanOrEqual(60)
    expect(header).toContain("…")
    expect(header).toContain("MendCode v0.4.2")
    // Seen live: a shortened root ran into the product with one space; there are always at least two.
    for (const width of [60, 90, 120]) expect(text(renderHome({ ...base, root: `/private/tmp/${"x".repeat(150)}/proj`, width, height: 30 })[1]!)).toMatch(/\S {2,}MendCode v0\.4\.2/)
  })
  test("nothing under the header repeats the product, the root or a tip", () => {
    const rest = lines(renderHome({ ...base, width: 120, height: 40 })).slice(2).join("\n")
    expect(rest).not.toContain("0.4.2")
    expect(rest).not.toContain("~/Code")
    expect(rest).not.toMatch(/tip|Tip|for commands|mention a file/)
    expect(rest).not.toMatch(/Switch session|Open commands|Quit/)
  })
})

describe("home logo density (v1 homeDensity)", () => {
  const wordmark = logoRows()
  const withLogo = (rows: Line[]) => lines(rows).some((line) => line.includes(wordmark[0]!))
  const plainName = (rows: Line[]) => lines(rows).some((line) => line.trim() === "MendCode")

  test("full: the ASCII logo in the text color, centered, when taller than 23 rows and wider than 64 columns", () => {
    const rows = renderHome({ ...base, width: 120, height: 34, screenHeight: 40 })
    expect(withLogo(rows)).toBe(true)
    const row = rows.find((line) => text(line).includes(wordmark[0]!))!
    expect(row.find((span) => span.text === wordmark[0])).toMatchObject({ fg: "text" })
    const left = text(row).indexOf(wordmark[0]!)
    expect(left).toBe(Math.floor((120 - textWidth(wordmark[0]!)) / 2))
  })
  test("compact (24 rows or fewer, or 64 columns or fewer): the text MendCode instead", () => {
    for (const [width, screenHeight] of [[120, 23], [120, 18], [64, 40], [50, 40]] as const) {
      const rows = renderHome({ ...base, width, height: screenHeight - 6, screenHeight })
      expect(withLogo(rows)).toBe(false)
      expect(plainName(rows)).toBe(true)
    }
    expect(withLogo(renderHome({ ...base, width: 65, height: 30, screenHeight: 36 }))).toBe(true)
    expect(withLogo(renderHome({ ...base, width: 120, height: 18, screenHeight: 24 }))).toBe(true)
  })
  test("tiny (17 rows or fewer): only the header row, no logo and no panel", () => {
    const rows = renderHome({ ...base, width: 100, height: 11, screenHeight: 17, sessions: mixed })
    expect(rows).toHaveLength(1)
    expect(text(rows[0]!)).toContain("MendCode v0.4.2")
    expect(text(rows[0]!).startsWith(" ~/Code")).toBe(true)
  })
  test("bare keeps only the header row at any size", () => {
    const rows = renderHome({ ...base, width: 120, height: 34, screenHeight: 40, bare: true, sessions: mixed })
    expect(rows).toHaveLength(1)
    expect(text(rows[0]!)).toContain("~/Code/MendCodeV2")
  })
  test("a missing screenHeight falls back to the given height", () => {
    expect(withLogo(renderHome({ ...base, width: 120, height: 40 }))).toBe(true)
    expect(withLogo(renderHome({ ...base, width: 120, height: 20 }))).toBe(false)
  })
})

describe("home Agent View", () => {
  test("empty: No sessions yet, muted, centered", () => {
    const rows = renderHome({ ...base, width: 120, height: 34, screenHeight: 40 })
    const found = lines(rows)
    const title = found.findIndex((line) => line.includes("No sessions yet"))
    expect(title).toBeGreaterThan(0)
    expect(found.join("\n")).not.toContain("resume or start a task")
    expect(rows[title]!.find((span) => span.text === "No sessions yet")).toMatchObject({ fg: "muted" })
    expect(found[title]!.indexOf("No sessions yet")).toBe(Math.floor((120 - "No sessions yet".length) / 2))
  })
  test("sections in v1's order with markers, titles in text color and a summary line first", () => {
    const rows = renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed, spinner: 0 })
    const found = lines(rows)
    const at = (needle: string) => found.findIndex((line) => line.includes(needle))
    expect(found[at("Agent View")]!.trim()).toBe("Agent View · 1 wait · 1 loop · 2 work")
    expect(at("Needs input")).toBeGreaterThan(at("Agent View"))
    expect(at("Looping")).toBeGreaterThan(at("Needs input"))
    expect(at("Working")).toBeGreaterThan(at("Looping"))
    expect(at("Completed")).toBeGreaterThan(at("Working"))
    expect(found[at("Approve plan")]).toContain("✱ Approve plan")
    expect(found[at("Fix reconnect")]).toContain("↻ Fix reconnect")
    expect(found[at("Port palette")]).toContain("⠋ Port palette")
    expect(found[at("Release notes")]).toContain("✦ Release notes")
    expect(rows[at("Release notes")]!.find((span) => span.text.startsWith("✦"))).toMatchObject({ fg: "success" })
    expect(rows[at("Needs input")]!.find((span) => span.text === "Needs input")).toMatchObject({ fg: "text" })
    expect(rows[at("Approve plan")]!.find((span) => span.text.startsWith("✱"))).toMatchObject({ fg: "accent" })
    expect(rows[at("Fix reconnect")]!.find((span) => span.text.startsWith("↻"))).toMatchObject({ fg: "accent" })
    expect(rows[at("Port palette")]!.find((span) => span.text.startsWith("⠋"))).toMatchObject({ fg: "muted" })
  })
  test("a row is the title with the time at the right and the detail muted below it; the panel is 54 columns", () => {
    const rows = renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed })
    const found = lines(rows)
    const i = found.findIndex((line) => line.includes("Approve plan"))
    const inset = Math.floor((120 - 54) / 2)
    expect(found[i]!.slice(inset)).toMatch(/^✱ Approve plan +12m$/)
    expect(textWidth(found[i]!)).toBe(inset + 54)
    expect(found[i + 1]!.slice(inset)).toMatch(/^ {2}Run command: ls +$/)
    expect(rows[i + 1]!.find((span) => span.text === "Run command: ls")).toMatchObject({ fg: "muted" })
    expect(rows[i]!.find((span) => span.text === "12m")).toMatchObject({ fg: "muted" })
  })
  test("elapsed time for active rows, age for completed ones, the state name when there is no detail", () => {
    const found = lines(renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed }))
    expect(found.find((line) => line.includes("Fix reconnect"))).toMatch(/1h$/)
    expect(found.find((line) => line.includes("Port palette"))).toMatch(/4m$/)
    expect(found.find((line) => line.includes("Release notes"))).toMatch(/48m ago$/)
    expect(found[found.findIndex((line) => line.includes("Fix reconnect")) + 1]).toContain("looping")
  })
  test("completed-only lists show the Completed section without the summary, and sections without rows are skipped", () => {
    const found = lines(renderHome({ ...base, width: 120, height: 34, screenHeight: 40, sessions: [session("completed", "Done thing")] }))
    expect(found.join("\n")).not.toContain("Agent View")
    expect(found.join("\n")).not.toContain("Working")
    expect(found.some((line) => line.includes("Completed"))).toBe(true)
    expect(found.some((line) => line.includes("Done thing"))).toBe(true)
    expect(found.some((line) => line.includes("No sessions yet"))).toBe(false)
  })
  test("the summary wording follows the panel width", () => {
    const wide = lines(renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed }))
    expect(wide.some((line) => line.trim() === "Agent View · 1 wait · 1 loop · 2 work")).toBe(true)
    const narrow = lines(renderHome({ ...base, width: 36, height: 39, screenHeight: 45, sessions: mixed }))
    expect(narrow.some((line) => line.trim() === "Agent View sessions")).toBe(true)
    expect(narrow.some((line) => line.trim() === "1 wait · 1 loop · 2 work")).toBe(true)
  })
  test("the selected row has the element background across the panel width, and only it", () => {
    const rows = renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed, selectedId: "Fix reconnect" })
    const marked = rows.filter((row) => row.some((span) => span.bg === "element"))
    expect(marked).toHaveLength(2)
    expect(text(marked[0]!)).toContain("Fix reconnect")
    for (const row of marked) expect(row.filter((span) => span.bg === "element").reduce((sum, span) => sum + textWidth(span.text), 0)).toBe(54)
    expect(renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed }).some((row) => row.some((span) => span.bg))).toBe(false)
  })
  test("the working spinner advances with the tick", () => {
    const frame = (spinner: number) => lines(renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: mixed, spinner })).find((line) => line.includes("Port palette"))!.trim()[0]
    expect(frame(0)).toBe("⠋")
    expect(frame(1)).toBe("⠙")
    expect(frame(10)).toBe("⠋")
  })
  test("long titles are shortened in the middle and never widen the panel", () => {
    const found = lines(renderHome({ ...base, width: 120, height: 39, screenHeight: 45, sessions: [session("working", "x".repeat(20) + " the very long title of a session " + "y".repeat(20), { detail: "z".repeat(200) })] }))
    for (const line of found) expect(textWidth(line)).toBeLessThanOrEqual(120)
    expect(found.some((line) => line.includes("…"))).toBe(true)
  })
})

describe("home fitting", () => {
  const many: HomeSession[] = (["needs_input", "looping", "working", "completed"] as const).flatMap((state) => Array.from({ length: 6 }, (_, i) => session(state, `${state} ${i}`, { updatedAt: minutes(i + 1), startedAt: minutes(i + 1) })))

  test.each([
    [120, 40], [120, 24], [100, 20], [80, 24], [60, 30], [40, 25], [30, 20], [25, 18], [120, 18], [10, 10],
  ])("%ix%i never exceeds its box", (width, screenHeight) => {
    const height = Math.max(1, screenHeight - 6)
    for (const sessions of [[], mixed, many]) {
      const rows = renderHome({ ...base, width, height, screenHeight, sessions })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of rows) expect(textWidth(text(row))).toBeLessThanOrEqual(width)
    }
  })
  test("rows per state are capped like v1 (3, 4, 4, 3) when there is room", () => {
    const found = lines(renderHome({ ...base, width: 120, height: 60, screenHeight: 66, sessions: many }))
    const count = (state: string) => found.filter((line) => line.includes(`${state} `) && /\d/.test(line) && !line.includes("Agent View")).length
    expect(count("needs_input")).toBe(HOME_SECTION_CAPS.needs_input)
    expect(count("looping")).toBe(HOME_SECTION_CAPS.looping)
    expect(count("working")).toBe(HOME_SECTION_CAPS.working)
    expect(count("completed")).toBe(HOME_SECTION_CAPS.completed)
  })
  test("short screens drop completed rows first, then working, keeping needs input", () => {
    const found = lines(renderHome({ ...base, width: 120, height: 14, screenHeight: 24, sessions: many }))
    expect(found.some((line) => line.includes("needs_input 0"))).toBe(true)
    expect(found.some((line) => line.includes("completed 0"))).toBe(false)
  })
  test("the content is vertically centered under the header with at least one empty row", () => {
    const rows = renderHome({ ...base, width: 120, height: 34, screenHeight: 40 })
    expect(rows[2]).toEqual([])
    const first = rows.findIndex((row, index) => index > 1 && text(row).trim() !== "")
    const last = rows.findLastIndex((row) => text(row).trim() !== "")
    const above = first - 2
    const below = 34 - 1 - last
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
  })
})

describe("homeVisibleSessions", () => {
  test("lists rows in v1's state order, most recent first (working by start), capped per state", () => {
    const ordered = homeVisibleSessions([
      session("completed", "c-old", { updatedAt: minutes(90) }),
      session("working", "w-old", { startedAt: minutes(50) }),
      session("needs_input", "n1", { updatedAt: minutes(9) }),
      session("completed", "c-new", { updatedAt: minutes(2) }),
      session("working", "w-new", { startedAt: minutes(3) }),
      session("looping", "l1"),
    ])
    expect(ordered.map((s) => s.title)).toEqual(["n1", "l1", "w-new", "w-old", "c-new", "c-old"])
    const flood = Array.from({ length: 10 }, (_, i) => session("completed", `c${i}`, { updatedAt: minutes(i) }))
    expect(homeVisibleSessions(flood).map((s) => s.title)).toEqual(["c0", "c1", "c2"])
  })
})
