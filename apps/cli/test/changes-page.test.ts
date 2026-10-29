import { describe, expect, test } from "bun:test"
import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { changesPageKey, createChangesPageState, renderChangesPage, type ChangesPageState } from "../src/view/changes-page"
import type { Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

function file(input: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: "modified", additions: 0, deletions: 0, binary: false, diff: "", truncated: false, ...input }
}

const DIFF = `@@ -10,4 +10,5 @@ function a() {
 context one
-removed line
+added line one
+added line two
 context two
@@ -40,2 +41,2 @@ function b() {
-old b
+new b`

function report(files: ChangedFile[], extra: Partial<ChangesReport> = {}): ChangesReport {
  return { root: "/repo", branch: "main", files, omittedFiles: 0, ...extra }
}

const sample = report([
  file({ path: "src/a.ts", additions: 3, deletions: 2, diff: DIFF }),
  file({ path: "src/new-name.ts", oldPath: "src/old-name.ts", status: "renamed" }),
  file({ path: "logo.png", binary: true }),
  file({ path: "src/big.ts", additions: 1, diff: "@@ -1 +1 @@\n+x", truncated: true, status: "added" }),
  file({ path: "notes.txt", status: "untracked", additions: 1, diff: "@@ -0,0 +1 @@\n+hi" }),
  file({ path: "src/gone.ts", status: "deleted", deletions: 1, diff: "@@ -1 +0,0 @@\n-bye" }),
])

const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const render = (state: ChangesPageState, width: number, height: number, data = sample) =>
  renderChangesPage({ report: data, state, width, height }).map(text)
const raw = (state: ChangesPageState, width: number, height: number, data = sample) => renderChangesPage({ report: data, state, width, height })
const at = (selected: number, extra: Partial<ChangesPageState> = {}): ChangesPageState => ({ ...createChangesPageState(), selected, ...extra })
const titleRow = (lines: Line[]) => lines[0]!
const tabsRow = (lines: Line[]) => lines[1]!
/** A row without the page's one-cell margin on each side; trailing padding trimmed. */
const unwrapPanel = (raw: string): string => (raw.length > 1 ? raw.slice(1, -1) : raw).trimEnd()
/** The files column of a wide row: the first 40 cells after the margin. */
const filesColumn = (raw: string) => unwrapPanel(raw).slice(0, 40).trimEnd()
/** The diff column of a wide row: what follows the files column and its gutter. */
const diffColumn = (raw: string) => unwrapPanel(raw).split("│")[3] ?? unwrapPanel(raw)
const inDiff = (selected: number, extra: Partial<ChangesPageState> = {}) => at(selected, { focus: "diff", ...extra })

describe("changesPageKey", () => {
  const start = createChangesPageState()
  test("down and up move the file selection and clamp", () => {
    const down = changesPageKey(start, "j", sample)
    expect(down.state.selected).toBe(1)
    expect(changesPageKey(down.state, "\x1b[A", sample).state.selected).toBe(0)
    expect(changesPageKey(start, "k", sample).state).toBe(start)
    expect(changesPageKey(at(5), "\x1b[B", sample).state.selected).toBe(5)
  })
  test("changing file resets the diff scroll", () => {
    expect(changesPageKey(at(0, { scroll: 3 }), "j", sample).state).toMatchObject({ selected: 1, scroll: 0 })
  })
  test("focus diff moves the row cursor one line, scrolls with it and clamps at both ends", () => {
    const focused = at(0, { focus: "diff" })
    const down = changesPageKey(focused, "j", sample).state
    expect(down).toMatchObject({ cursor: 1, scroll: 0, selected: 0 })
    expect(changesPageKey(focused, "k", sample).state).toBe(focused)
    let state = focused
    for (let press = 0; press < 4; press++) state = changesPageKey(state, "j", sample, 3).state
    expect(state).toMatchObject({ cursor: 4, scroll: 2 })
    const end = at(0, { focus: "diff", scroll: 8, cursor: 8 })
    expect(changesPageKey(end, "j", sample).state).toBe(end)
    expect(changesPageKey(at(0, { focus: "diff", scroll: 4, cursor: 4 }), "k", sample, 3).state).toMatchObject({ cursor: 3, scroll: 3 })
  })
  test("page keys scroll by the given page size", () => {
    expect(changesPageKey(at(0), "\x1b[6~", sample, 4).state.scroll).toBe(4)
    expect(changesPageKey(at(0, { scroll: 6 }), "\x1b[5~", sample, 4).state.scroll).toBe(2)
    expect(changesPageKey(at(0, { scroll: 2 }), "\x1b[5~", sample, 4).state.scroll).toBe(0)
    expect(changesPageKey(at(0), "\x1b[6~", sample, 100).state.scroll).toBe(8)
  })
  test("g goes to the top and G shows the bottom", () => {
    expect(changesPageKey(at(0, { scroll: 5 }), "g", sample).state.scroll).toBe(0)
    expect(changesPageKey(at(0), "G", sample, 4).state.scroll).toBe(5)
    expect(changesPageKey(at(0), "G", sample, 100).state.scroll).toBe(0)
  })
  test("1 and 2 jump to the Files and Diff tabs", () => {
    const diff = changesPageKey(start, "2", sample).state
    expect(diff.focus).toBe("diff")
    expect(changesPageKey(diff, "1", sample).state.focus).toBe("files")
    expect(changesPageKey(start, "1", sample).state).toBe(start)
    expect(changesPageKey(diff, "2", sample).state).toBe(diff)
    expect(changesPageKey(at(2, { scroll: 3 }), "2", sample).state).toMatchObject({ selected: 2, scroll: 3, focus: "diff" })
  })
  test("shift-tab toggles focus like tab", () => {
    expect(changesPageKey(start, "\x1b[Z", sample).state.focus).toBe("diff")
    expect(changesPageKey(inDiff(0), "\x1b[Z", sample).state.focus).toBe("files")
  })
  test("tab toggles focus and arrows/enter set it", () => {
    const diff = changesPageKey(start, "\t", sample).state
    expect(diff.focus).toBe("diff")
    expect(changesPageKey(diff, "\t", sample).state.focus).toBe("files")
    expect(changesPageKey(start, "\x1b[C", sample).state.focus).toBe("diff")
    expect(changesPageKey(diff, "\x1b[D", sample).state.focus).toBe("files")
    expect(changesPageKey(start, "\r", sample).state.focus).toBe("diff")
    expect(changesPageKey(diff, "\x1b[C", sample).state).toBe(diff)
  })
  test("r refreshes; esc and q close; unknown keys are ignored", () => {
    expect(changesPageKey(start, "r", sample).action).toEqual({ type: "refresh" })
    expect(changesPageKey(start, "\x1b", sample).action).toEqual({ type: "close" })
    expect(changesPageKey(start, "q", sample).action).toEqual({ type: "close" })
    const ignored = changesPageKey(start, "z", sample)
    expect(ignored.state).toBe(start)
    expect(ignored.action).toEqual({ type: "none" })
  })
  test("an empty report never throws", () => {
    const empty = report([])
    for (const key of ["j", "\x1b[6~", "G", "\r", "\t", "1", "2"]) expect(() => changesPageKey(start, key, empty)).not.toThrow()
    expect(changesPageKey(start, "j", empty).state.selected).toBe(0)
  })
})

describe("renderChangesPage", () => {
  test.each([
    [40, 20],
    [60, 30],
    [70, 30],
    [99, 24],
    [100, 24],
    [160, 50],
    [50, 4],
    [50, 1],
    [60, 20],
    [90, 20],
    [90, 35],
    [120, 35],
    [140, 40],
    [160, 45],
    [160, 50],
  ])("returns exactly height lines within width at %ix%i", (width, height) => {
    for (let selected = 0; selected < sample.files.length; selected++) {
      for (const focus of ["files", "diff"] as const) {
        const lines = render(at(selected, { focus }), width, height)
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("title row is 'Changes · branch main' with hints on the right and totals below", () => {
    const title = text(titleRow(raw(at(0), 120, 20))).trim()
    expect(title).toStartWith("Changes · branch main")
    expect(title).toContain("esc back")
    expect(text(raw(at(0), 120, 20)[1]!)).toContain("6 files +5 −3")
    expect(title).not.toContain("MENDCODE")
    expect(title).not.toContain("LIVE")
    expect(title).not.toContain("●")
    expect(text(titleRow(raw(at(0), 100, 20, report(sample.files, { branch: undefined } as never))))).toContain("Changes · working tree")
  })

  test("hints live in the header and bordered panels fill the page", () => {
    const lines = plain(raw(at(0), 120, 20))
    for (const hint of ["↑↓ file", "tab focus", "r refresh", "esc back"]) expect(lines[0]).toContain(hint)
    expect(lines[3]).toMatch(/┌.*Files.*┐.*┌.*Diff.*┐/)
    expect(lines[18]).toContain("└")
    expect(lines.at(-1)!.trim()).toBe("")
  })

  test("summary totals count omitted files and show Partial", () => {
    const lines = raw(at(0), 120, 20, report(sample.files, { omittedFiles: 4 }))
    expect(text(lines[1]!)).toContain("10 files")
    expect(lines[1]!.find((span) => span.text.includes("Partial"))).toMatchObject({ fg: "warning", bold: true })
    expect(text(raw(at(0), 120, 20)[1]!)).not.toContain("Partial")
  })

  test.each([[60, 20], [80, 30], [120, 40], [160, 50]])("fills exactly %ix%i for both focuses, with and without files", (width, height) => {
    for (const focus of ["files", "diff"] as const) {
      for (const data of [sample, report([])]) {
        const lines = render(at(0, { focus }), width, height, data)
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(line)).toBe(width)
      }
    }
  })

  test("medium and wide layout puts Files and Diff in the shared bordered grid", () => {
    const lines = plain(raw(at(0), 160, 30))
    const joined = lines.join("\n")
    expect(joined).toMatch(/[┌┐└┘│]/)
    expect(lines[2]).not.toContain("1 Files")
    expect(lines.some((line) => /\bFiles\b.*\bDiff\b/.test(line))).toBe(true)
    expect(lines.map(filesColumn).some((line) => line.includes("src/a.ts"))).toBe(true)
    expect(lines.map(diffColumn).some((line) => line.includes("@@ -10,4 +10,5 @@"))).toBe(true)
    expect(joined).toContain("src/gone.ts")
  })

  test("the focused wide section title is primary and the other is plain text", () => {
    const titleSpan = (focus: ChangesPageState["focus"], word: string) => raw(at(0, { focus }), 160, 30).flat().find((span) => span.text === word && span.bold)
    expect(titleSpan("files", "Files")).toMatchObject({ fg: "primary" })
    expect(titleSpan("files", "Diff")).toMatchObject({ fg: "primary" })
    expect(titleSpan("diff", "Diff")).toMatchObject({ fg: "primary" })
  })

  test("compact pages (below 70) have Files and Diff tabs and show one at a time", () => {
    const files = raw(at(0), 60, 24)
    expect(text(tabsRow(files))).toContain("1 Files")
    expect(text(tabsRow(files))).toContain("2 Diff")
    expect(tabsRow(files).find((span) => span.bg === "element")?.text).toContain("Files")
    expect(plain(files).map(unwrapPanel).some((line) => line.includes("src/a.ts"))).toBe(true)
    expect(plain(files).join("\n")).not.toContain("@@ -10,4 +10,5 @@")
    const diff = raw(inDiff(0), 60, 24)
    expect(tabsRow(diff).find((span) => span.bg === "element")?.text).toContain("Diff")
    expect(plain(diff).join("\n")).toContain("@@ -10,4 +10,5 @@")
    expect(plain(diff).map(unwrapPanel).filter((line) => line.startsWith("❯")).length).toBe(0)
    expect(plain(diff).map(unwrapPanel).some((line) => line.startsWith("M src/a.ts"))).toBe(true)
  })

  test("compact header hints follow the focused pane", () => {
    const files = plain(raw(at(0), 60, 24)).join("\n")
    expect(files).toContain("enter diff")
    expect(files).toContain("esc back")
    const diff = plain(raw(inDiff(0), 60, 24)).join("\n")
    expect(diff).toContain("c comment")
    expect(diff).toContain("esc back")
  })

  test("an empty report shows no tabs", () => {
    expect(plain(raw(at(0), 100, 20, report([]))).join("\n")).not.toContain("1 Files")
  })

  test("selected file has the pointer and others do not", () => {
    const rows = plain(raw(at(2), 100, 20)).map(unwrapPanel)
    expect(rows.filter((line) => line.includes("❯"))).toHaveLength(1)
    expect(rows.find((line) => line.includes("❯"))).toContain("logo.png")
  })

  test("status letters and counts are colored", () => {
    const lines = raw(at(0), 180, 40)
    const row = (path: string) => lines.find((line) => line.some((span) => span.text.includes(path)))!
    expect(row("src/a.ts").find((span) => span.text === "M")?.fg).toBe("warning")
    expect(row("src/a.ts").find((span) => span.text.trim() === "+3")?.fg).toBe("success")
    expect(row("src/a.ts").find((span) => span.text.trim() === "−2")?.fg).toBe("error")
    expect(row("src/gone.ts").find((span) => span.text === "D")?.fg).toBe("error")
    expect(row("new-name.ts").find((span) => span.text === "R")?.fg).toBe("heading")
  })

  test("selection scrolls the file list to stay visible", () => {
    const many = report(Array.from({ length: 40 }, (_, i) => file({ path: `src/file-${i}.ts`, diff: "@@ -1 +1 @@\n+x" })))
    const rows = plain(raw(at(30), 60, 30, many)).map(unwrapPanel)
    expect(rows.filter((line) => line.includes("❯"))).toHaveLength(1)
    expect(rows.find((line) => line.includes("❯"))).toContain("file-30.ts")
    const wideRows = plain(raw(at(39), 160, 20, many)).map(unwrapPanel)
    expect(wideRows.find((line) => line.includes("❯"))).toContain("file-39.ts")
  })

  test("omitted files add a trailing line in the list", () => {
    const rows = plain(raw(at(0), 160, 24, report(sample.files, { omittedFiles: 7 }))).map(unwrapPanel)
    expect(rows.some((line) => line.includes("+7 more files"))).toBe(true)
    expect(plain(raw(at(0), 160, 24)).map(unwrapPanel).some((line) => line.includes("more files"))).toBe(false)
  })

  test("long paths are middle-ellipsized in the list", () => {
    const long = report([file({ path: `${"deep/".repeat(20)}file.ts`, additions: 10, deletions: 10, diff: "@@ -1 +1 @@\n+x" })])
    const rows = plain(raw(at(0), 100, 12, long)).map(unwrapPanel)
    const row = rows.find((line) => line.includes("file.ts"))!
    expect(row).toContain("…")
  })

  test("renames show old → new when there is room, and the new path only when the pane is cramped", () => {
    const roomy = plain(raw(at(1), 90, 20)).map(unwrapPanel)
    expect(roomy.some((line) => line.includes("src/old-name.ts → src/new-name.ts"))).toBe(true)
    const cramped = plain(raw(at(1), 120, 30)).map(filesColumn)
    expect(cramped.some((line) => line.includes("→"))).toBe(false)
    expect(cramped.some((line) => line.includes("new-name.ts"))).toBe(true)
  })

  test("binary files show a notice", () => {
    const rows = plain(raw(inDiff(2), 100, 12)).map(unwrapPanel)
    expect(rows.some((line) => line.includes("binary file"))).toBe(true)
    expect(rows.some((line) => line.includes("bin"))).toBe(true)
  })

  test("truncated diffs end with a notice when scrolled to the end", () => {
    const rows = plain(raw(inDiff(3), 100, 30)).map(unwrapPanel)
    expect(rows.some((line) => line.includes("diff truncated"))).toBe(true)
    expect(plain(raw(inDiff(0), 100, 20)).map(unwrapPanel).some((line) => line.includes("diff truncated"))).toBe(false)
  })

  test("files without a textual diff say so", () => {
    expect(plain(raw(inDiff(1), 100, 12)).map(unwrapPanel).some((line) => line.includes("no textual changes"))).toBe(true)
  })

  test("empty report renders a centered no changes message when there is room, and always fits exactly", () => {
    for (const [width, height] of [[100, 16], [50, 12], [160, 24]] as const) {
      const lines = render(at(0), width, height, report([]))
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width)
      expect(lines.filter((line) => line.includes("no changes"))).toHaveLength(1)
    }
    const tiny = render(at(0), 160, 3, report([]))
    expect(tiny).toHaveLength(3)
    for (const line of tiny) expect(textWidth(line)).toBeLessThanOrEqual(160)
  })

  test("colors follow the diff line kind", () => {
    const lines = raw(inDiff(0), 100, 30)
    const kind = (needle: string) => lines.find((line) => text(line).includes(needle))!
    expect(kind("added line one").find((span) => span.text === "added line one")?.fg).toBe("success")
    expect(kind("removed line").find((span) => span.text === "removed line")?.fg).toBe("error")
    expect(kind("context one").find((span) => span.text === "context one")?.fg).toBe("body")
    expect(kind("@@ -10,4").find((span) => span.text.startsWith("@ -10"))?.fg).toBe("heading")
  })

  test("gutter numbers follow the @@ headers", () => {
    const rows = plain(raw(inDiff(0), 100, 30)).map(diffColumn)
    const row = (needle: string) => rows.find((line) => line.includes(needle))!
    expect(row("context one")).toMatch(/^\s*10\s+10\s+ context one/)
    expect(row("removed line")).toMatch(/^\s*11\s+-removed line/)
    expect(row("added line one")).toMatch(/^\s+11\s+\+added line one/)
    expect(row("added line two")).toMatch(/^\s+12\s+\+added line two/)
    expect(row("context two")).toMatch(/^\s*12\s+13\s+ context two/)
    expect(row("old b")).toMatch(/^\s*40\s+-old b/)
    expect(row("new b")).toMatch(/^\s+41\s+\+new b/)
  })

  test("gutter is dropped when the pane is narrower than 60", () => {
    const rows = plain(raw(inDiff(0), 50, 24)).map(unwrapPanel)
    const line = rows.find((row) => row.includes("added line one"))!
    expect(line).toStartWith("+added line one")
  })

  test("scrolled diffs keep correct gutter numbers", () => {
    const rows = plain(raw(inDiff(0, { scroll: 4 }), 100, 30)).map(unwrapPanel)
    expect(rows.some((line) => line.includes("context two"))).toBe(true)
    expect(rows.some((line) => line.includes("context one"))).toBe(false)
    expect(rows.find((line) => line.includes("context two"))).toMatch(/12\s+13/)
  })

  test("long diff lines wrap with a continuation marker and never overflow", () => {
    const long = report([file({ path: "a.ts", diff: `@@ -1 +1 @@\n+${"word ".repeat(60)}\n context after` })])
    for (const width of [40, 60, 100, 160]) {
      const lines = render(inDiff(0), width, 30, long)
      expect(lines.filter((line) => line.includes("…")).length).toBeGreaterThan(0)
      expect(lines.some((line) => line.includes("context after"))).toBe(true)
      for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("tabs expand to two spaces and control characters are stripped", () => {
    const messy = report([file({ path: "a.ts", diff: "@@ -1 +1 @@\n+\tindent\x07bell\x1b[31mred\r" })])
    const rows = plain(raw(inDiff(0), 100, 30, messy)).map(unwrapPanel)
    const row = rows.find((line) => line.includes("indent"))!
    expect(row).toContain("+  indentbell[31mred")
    expect(row).not.toMatch(/[\t\x07\x1b\r]/)
  })

  test("wide characters do not overflow", () => {
    const wide = report([file({ path: "日本語/ファイル.ts", diff: `@@ -1 +1 @@\n+${"日本語".repeat(40)}` })])
    for (const width of [40, 70, 160]) for (const line of render(at(0), width, 20, wide)) expect(textWidth(line)).toBeLessThanOrEqual(width)
  })

  test("renders a 5,000-line diff at 160x50 quickly", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `-old ${i}` : i % 3 === 1 ? `+new ${i} ${"x".repeat(40)}` : ` ctx ${i}`))
    const huge = report([file({ path: "huge.ts", diff: `@@ -1,5000 +1,5000 @@\n${rows.join("\n")}` })])
    renderChangesPage({ report: huge, state: at(0), width: 160, height: 50 })
    const started = performance.now()
    const lines = renderChangesPage({ report: huge, state: at(0, { scroll: 4000 }), width: 160, height: 50 })
    expect(performance.now() - started).toBeLessThan(budgetMs(50))
    expect(lines).toHaveLength(50)
  })

  test("a single very long line only wraps what is visible", () => {
    const one = report([file({ path: "min.js", diff: `@@ -1 +1 @@\n+${"a".repeat(2_000_000)}` })])
    const started = performance.now()
    const lines = renderChangesPage({ report: one, state: inDiff(0), width: 80, height: 20 })
    expect(performance.now() - started).toBeLessThan(budgetMs(200))
    expect(lines).toHaveLength(20)
  })
})

describe("replay", () => {
  const press = (state: ChangesPageState, ...keys: string[]) => keys.reduce((current, key) => changesPageKey(current, key, sample).state, state)
  const step = (state: ChangesPageState) => ({ file: sample.files[state.selected]!.path, row: state.cursor })

  test("R starts at the hunk under the cursor and steps through every hunk of every file", () => {
    const on = press(inDiff(0), "R")
    expect(on.replay).toBe(true)
    expect(step(on)).toEqual({ file: "src/a.ts", row: 0 })
    const walked = [on]
    for (let i = 0; i < 4; i++) walked.push(press(walked.at(-1)!, "]"))
    expect(walked.map(step)).toEqual([
      { file: "src/a.ts", row: 0 },
      { file: "src/a.ts", row: 6 },
      { file: "src/big.ts", row: 0 },
      { file: "notes.txt", row: 0 },
      { file: "src/gone.ts", row: 0 },
    ])
    expect(changesPageKey(walked.at(-1)!, " ", sample).state.notice).toBe("last step")
  })
  test("[ steps back, g and G jump to the ends, n and p move between files", () => {
    const last = press(inDiff(0), "R", "G")
    expect(step(last)).toEqual({ file: "src/gone.ts", row: 0 })
    expect(step(press(last, "["))).toEqual({ file: "notes.txt", row: 0 })
    expect(step(press(last, "p", "p", "p"))).toEqual({ file: "src/a.ts", row: 0 })
    expect(changesPageKey(press(last, "g"), "[", sample).state.notice).toBe("first step")
    expect(step(press(inDiff(0), "R", "n"))).toEqual({ file: "src/big.ts", row: 0 })
  })
  test("starting from a later file or row picks the step that contains the cursor", () => {
    expect(step(press(inDiff(0, { cursor: 7 }), "R"))).toEqual({ file: "src/a.ts", row: 6 })
    expect(step(press(at(4), "R"))).toEqual({ file: "notes.txt", row: 0 })
  })
  test("esc leaves replay first and R toggles it off; a report without hunks does not start", () => {
    const on = press(inDiff(0), "R")
    expect(changesPageKey(on, "\x1b", sample).state.replay).toBe(false)
    expect(changesPageKey(on, "\x1b", sample).action).toEqual({ type: "none" })
    expect(press(on, "R").replay).toBe(false)
    const bare = report([file({ path: "logo.png", binary: true })])
    const result = changesPageKey(createChangesPageState(), "R", bare)
    expect(result.state).toMatchObject({ replay: false, notice: "no hunks to replay" })
  })
  test("comments in replay target the hunk on screen", () => {
    const state = press(inDiff(0), "R", "]")
    const composing = changesPageKey(state, "C", sample).state
    expect(composing.mode).toBe("compose")
    expect(composing.target).toMatchObject({ path: "src/a.ts" })
  })
  test("the pane shows only the current hunk with its step counter", () => {
    const first = render(press(inDiff(0), "R"), 120, 24).join("\n")
    expect(first).toContain("replay step 1/5 · hunk 1/2 of this file")
    expect(first).toContain("+added line two")
    expect(first).not.toContain("old b")
    const second = render(press(inDiff(0), "R", "]"), 120, 24).join("\n")
    expect(second).toContain("step 2/5 · hunk 2/2 of this file")
    expect(second).toContain("+new b")
    expect(second).not.toContain("added line two")
    expect(second).toContain("R exit")
    expect(second).toContain("esc exit replay")
  })
  test("fits narrow pages and every line stays within the width", () => {
    for (const width of [40, 60, 90]) {
      const lines = raw(press(inDiff(0), "R", "]"), width, 20)
      expect(lines).toHaveLength(20)
      for (const line of lines) expect(textWidth(line.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
    expect(render(press(inDiff(0), "R", "]"), 50, 20).join("\n")).toContain("step 2/5")
  })
  test("a read-only source (message changes) replays too", () => {
    const scoped = report(sample.files, { scope: "message" })
    const state = changesPageKey(inDiff(0), "R", scoped).state
    const frame = render(state, 120, 24, scoped).join("\n")
    expect(frame).toContain("step 1/5")
    expect(frame).not.toContain("c comment")
  })
})
