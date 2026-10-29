import { describe, expect, test } from "bun:test"
import type { StorageReport } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createStoragePageState, formatBytes, renderStoragePage, storageConfirmClean, storageNote, storagePageKey } from "../src/view/storage-page"
import { textWidth } from "../src/view/wrap"

const NOW = Date.UTC(2026, 8, 26, 12)
const MB = 1024 * 1024
const GB = 1024 * MB
const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const titleRow = (lines: Line[]) => lines[1]!
const tabsRow = (lines: Line[]) => lines[2]!
/** A row without the page's one-cell margin on each side; trailing padding trimmed. */
const unwrapPanel = (raw: string): string => (raw.length > 1 ? raw.slice(1, -1) : raw).trimEnd()
const overview = createStoragePageState()
const sessionsTab = { tab: 1 }
const blobsTab = { tab: 2 }

function report(patch: Partial<StorageReport> = {}): StorageReport {
  return {
    dbBytes: 1.2 * GB, walBytes: 12 * MB, blobBytes: 5.6 * GB, blobs: 312, orphanBlobs: 4, orphanBytes: 120 * MB,
    sessions: 87, events: 84_120, eventBytes: 0.9 * GB, engineBytes: 0.2 * GB, otherBytes: 0.1 * GB, freeBytes: 20 * MB, autoVacuum: "incremental",
    topSessions: Array.from({ length: 10 }, (_, i) => ({
      sessionId: `ses_${i}` as never, title: i === 3 ? "" : `session number ${i} with a fairly long descriptive title`, directory: `/Users/dev/Code/project-${i}/packages/app`, updatedAt: NOW - i * 86_400_000, bytes: (4.1 - i * 0.3) * GB,
    })),
    ...patch,
  }
}

const render = (over: Partial<Parameters<typeof renderStoragePage>[0]> = {}) => renderStoragePage({ report: report(), state: createStoragePageState(), width: 100, height: 30, now: NOW, ...over })

describe("formatBytes", () => {
  test("uses base-1024 units with one decimal", () => {
    expect([0, 512, 1023, 1024, 1536, 12.4 * MB, 5.6 * GB, 2048 * GB].map(formatBytes)).toEqual(["0 B", "512 B", "1023 B", "1.0 KB", "1.5 KB", "12.4 MB", "5.6 GB", "2048.0 GB".replace("2048.0 GB", "2.0 TB")])
  })
  test("rolls 1023.96 KB over to 1.0 MB", () => expect(formatBytes(1024 * 1023.96)).toBe("1.0 MB"))
})

describe("storage page keys", () => {
  test("esc and q close, r refreshes", () => {
    expect(storagePageKey({}, "\x1b").action).toEqual({ type: "close" })
    expect(storagePageKey({}, "q").action).toEqual({ type: "close" })
    expect(storagePageKey({}, "r").action).toEqual({ type: "refresh" })
  })

  test("c asks the app for a dry run and v asks for a vacuum confirmation", () => {
    expect(storagePageKey({}, "c").action).toEqual({ type: "previewClean" })
    const vacuum = storagePageKey({}, "v")
    expect(vacuum.action).toEqual({ type: "none" })
    expect(vacuum.state.confirm).toEqual({ kind: "vacuum" })
  })

  test("y confirms a clean with its days, then the prompt is gone", () => {
    const asked = storageConfirmClean({ kind: "clean", days: 90, sessions: 12, bytes: 3 * GB })
    const result = storagePageKey(asked, "y")
    expect(result.action).toEqual({ type: "clean", days: 90 })
    expect(result.state).toEqual({})
  })

  test("z and w ask the app for a dry run; y then runs the pass that was previewed", () => {
    expect(storagePageKey({}, "z").action).toEqual({ type: "previewCompact" })
    expect(storagePageKey({}, "w").action).toEqual({ type: "previewWorktrees" })
    expect(storagePageKey(storageConfirmClean({ kind: "compact", rows: 1200, deltas: 30_000 }), "y").action).toEqual({ type: "compact" })
    expect(storagePageKey(storageConfirmClean({ kind: "worktrees", removed: 3, bytes: 2 * GB }), "y").action).toEqual({ type: "worktrees" })
    expect(storagePageKey(storageConfirmClean({ kind: "worktrees", removed: 3, bytes: 2 * GB }), "n").action).toEqual({ type: "none" })
  })

  test("the prompts say what will happen and how big it is", () => {
    const compact = plain(render({ state: storageConfirmClean({ kind: "compact", rows: 1200, deltas: 30_000 }) })).map(unwrapPanel)
    expect(compact.some((line) => line === "pack old data and drop 30,000 finished streaming deltas (1,200 rows)? nothing is lost. y/n")).toBe(true)
    const trees = plain(render({ state: storageConfirmClean({ kind: "worktrees", removed: 3, bytes: 2 * GB }) })).map(unwrapPanel)
    expect(trees.some((line) => line === "remove 3 merged, clean, unused worktrees or trash entries (≈2.0 GB)? y/n")).toBe(true)
  })

  test("the overview shows what compression saves and the worktree cleanup setting", () => {
    const packed = plain(render({ report: report({ compressedRows: 5_000, savedBytes: 250 * MB, trashBytes: 3 * MB }) })).map(unwrapPanel)
    expect(packed.find((line) => line.startsWith("compression"))).toMatch(/5,000 rows packed · saves 250.0 MB · z moves older data/)
    expect(packed.find((line) => line.startsWith("worktrees"))).toContain("off · set worktreeGcDays in settings to enable · w now · trash 3.0 MB")
    expect(plain(render({ worktreeGcDays: 14 })).map(unwrapPanel).find((line) => line.startsWith("worktrees"))).toContain("idle > 14 days go daily 03:30")
    expect(plain(render({ report: report({ compressedRows: 0 }) })).map(unwrapPanel).find((line) => line.startsWith("compression"))).toContain("nothing packed yet")
  })

  test("y confirms a vacuum", () => {
    expect(storagePageKey({ confirm: { kind: "vacuum" } }, "y").action).toEqual({ type: "vacuum" })
  })

  test("any other key cancels a pending question without acting or closing", () => {
    for (const key of ["n", "\x1b", "c", "r", "v", "x", "\r"]) {
      const result = storagePageKey({ confirm: { kind: "vacuum" } }, key)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state).toEqual({})
    }
  })

  test("tab and shift-tab cycle Overview, Sessions and Blobs and 1 to 3 jump", () => {
    expect(storagePageKey({}, "\t").state).toEqual({ tab: 1 })
    expect(storagePageKey({ tab: 1 }, "\t").state).toEqual({ tab: 2 })
    expect(storagePageKey({ tab: 2 }, "\t").state).toEqual({})
    expect(storagePageKey({}, "\x1b[Z").state).toEqual({ tab: 2 })
    expect(storagePageKey({ tab: 1 }, "\x1b[Z").state).toEqual({})
    expect(storagePageKey({}, "3").state).toEqual({ tab: 2 })
    expect(storagePageKey({ tab: 2 }, "1").state).toEqual({})
    expect(storagePageKey({}, "2").action).toEqual({ type: "none" })
  })

  test("jumping to the tab already shown returns the same state object", () => {
    const state = { tab: 1 }
    expect(storagePageKey(state, "2").state).toBe(state)
    const first = {}
    expect(storagePageKey(first, "1").state).toBe(first)
  })

  test("actions keep the tab and cancelling or confirming a question returns to it", () => {
    expect(storagePageKey({ tab: 2 }, "r").state).toEqual({ tab: 2 })
    expect(storagePageKey({ tab: 2 }, "c").state).toEqual({ tab: 2 })
    const asked = storagePageKey({ tab: 1 }, "v").state
    expect(asked).toEqual({ tab: 1, confirm: { kind: "vacuum" } })
    expect(storagePageKey(asked, "y")).toEqual({ state: { tab: 1 }, action: { type: "vacuum" } })
    expect(storagePageKey(asked, "n").state).toEqual({ tab: 1 })
    expect(storagePageKey({ tab: 2 }, "\x1b").action).toEqual({ type: "close" })
  })

  test("a tab key clears a note like any other key", () => {
    expect(storagePageKey({ tab: 1, note: "done" }, "3").state).toEqual({ tab: 2 })
    expect(storagePageKey({ note: "done" }, "1").state).toEqual({})
  })

  test("a note clears on the next key and unknown keys change nothing otherwise", () => {
    const noted = storageNote({}, "nothing older than 90 days")
    expect(storagePageKey(noted, "x").state).toEqual({})
    const plainState = {}
    expect(storagePageKey(plainState, "x").state).toBe(plainState)
  })
})

describe("storage page rendering", () => {
  test("title row is 'Storage · size on disk' with sessions and events on the right, no brand and no live dot", () => {
    const title = text(titleRow(render())).trim()
    expect(title).toStartWith("Storage · 6.8 GB on disk")
    expect(title).toEndWith("87 sessions · 84,120 events")
    expect(title).not.toContain("MENDCODE")
    expect(title).not.toContain("LIVE")
    expect(title).not.toContain("●")
  })

  test("a rule follows the tabs and the footer keeps esc back and the keys", () => {
    const rows = plain(render())
    expect(rows[3]!.trim()).toMatch(/^─+$/)
    const back = rows.findIndex((row) => row.trim() === "esc back")
    expect(back).toBeGreaterThan(4)
    const keys = rows.slice(back + 1).join("\n")
    for (const hint of ["c clean", "v vacuum", "r refresh", "tab/1-3 tabs"]) expect(keys).toContain(hint)
  })

  test("tabs are Overview, Sessions and Blobs with the current one highlighted", () => {
    const row = text(tabsRow(render()))
    expect(row).toContain("1 Overview")
    expect(row).toContain("2 Sessions")
    expect(row).toContain("3 Blobs")
    for (const [state, label] of [[overview, "Overview"], [sessionsTab, "Sessions"], [blobsTab, "Blobs"]] as const) {
      const spans = tabsRow(render({ state }))
      expect(spans.find((span) => span.text.includes(label))).toMatchObject({ fg: "text", bg: "element", bold: true })
      expect(spans.filter((span) => span.bg === "element")).toHaveLength(1)
    }
  })

  test("no boxes and no section title repeating the page title", () => {
    for (const state of [overview, sessionsTab, blobsTab]) {
      const t = plain(render({ state })).join("\n")
      expect(t).not.toMatch(/[┌┐└┘│]/)
      expect(t.match(/Storage/g)).toHaveLength(1)
    }
  })

  test("each tab shows only its own part of the report", () => {
    const first = plain(render()).map(unwrapPanel).join("\n")
    expect(first).toContain("database")
    expect(first).toContain("auto-vacuum")
    expect(first).not.toContain("session number 0")
    expect(first).not.toContain("reclaimable")
    const second = plain(render({ state: sessionsTab })).map(unwrapPanel).join("\n")
    expect(second).toContain("session number 0")
    expect(second).not.toContain("database")
    const third = plain(render({ state: blobsTab })).map(unwrapPanel).join("\n")
    expect(third).toContain("reclaimable")
    expect(third).not.toContain("session number 0")
    expect(third).not.toContain("database")
  })

  test("overview breakdown rows have right-aligned sizes and proportional bars", () => {
    const lines = plain(render()).map(unwrapPanel)
    const blobs = lines.find((line) => line.startsWith("blobs (312 files)"))!
    const database = lines.find((line) => line.startsWith("database"))!
    const wal = lines.find((line) => line.startsWith("wal"))!
    expect(blobs).toMatch(/5\.6 GB █{8}░{2}$/)
    expect(database).toMatch(/1\.2 GB █{2}░{8}$/)
    expect(wal).toMatch(/12\.0 MB █░{9}$/)
    expect(new Set([blobs, database, wal].map(textWidth)).size).toBe(1)
    expect(lines.find((line) => line.startsWith("  events"))).toContain("921.6 MB")
    expect(lines.find((line) => line.startsWith("  engine history"))).toContain("204.8 MB")
    expect(lines.find((line) => line.startsWith("  other · 20.0 MB free"))).toContain("102.4 MB")
  })

  test("the blobs tab shows files, size, orphaned files and reclaimable bytes, in warning color only when there are orphans", () => {
    const rows = plain(render({ state: blobsTab })).map(unwrapPanel).join("\n")
    for (const shown of ["312", "5.6 GB", "4", "120.0 MB", "files", "size", "orphaned", "reclaimable"]) expect(rows).toContain(shown)
    const tone = (r: StorageReport) => render({ state: blobsTab, report: r }).flat().find((span) => span.text.includes("reclaimable") === false && span.text.trim() === (r.orphanBlobs > 0 ? "120.0 MB" : "0 B"))
    expect(tone(report())).toMatchObject({ fg: "warning", bold: true })
    expect(tone(report({ orphanBlobs: 0, orphanBytes: 0 }))).toMatchObject({ fg: "text", bold: true })
  })

  test("the overview ends with the vacuum mode and the auto-clean setting", () => {
    const rows = plain(render()).map(unwrapPanel)
    expect(rows.find((line) => line.startsWith("auto-vacuum"))).toMatch(/^auto-vacuum +incremental$/)
    const none = plain(render({ report: report({ autoVacuum: "none" }) })).map(unwrapPanel)
    expect(none.find((line) => line.startsWith("auto-vacuum"))).toContain("file never shrinks without a full vacuum")
    expect(rows.find((line) => line.startsWith("auto-clean"))).toContain("off · set retentionDays (≥ 7) in settings to enable")
    expect(plain(render({ retentionDays: 90 })).map(unwrapPanel).find((line) => line.startsWith("auto-clean"))).toMatch(/^auto-clean +sessions idle > 90 days, daily 03:30$/)
  })

  test("the sessions tab lists size, age, title and directory for the ten largest", () => {
    const lines = plain(render({ state: sessionsTab, width: 220, height: 40 })).map((line) => unwrapPanel(line.split("│")[1] ? `│${line.split("│")[1]}│` : line))
    const head = lines.findIndex((line) => /^ +size +age +session$/.test(line))
    expect(head).toBeGreaterThan(0)
    expect(lines[head + 1]).toMatch(/^ +4\.1 GB {2}now {2}session number 0/)
    expect(lines[head + 1]).toContain("(/Users/")
    expect(lines[head + 1]).toEndWith("packages/app)")
    expect(lines[head + 2]).toMatch(/3\.8 GB {3}1d/)
    expect(lines[head + 4]).toContain("untitled")
    expect(lines.slice(head + 1, head + 11).filter((line) => /GB|MB/.test(line)).length).toBe(10)
  })

  test("a clean confirmation is pinned near the bottom in warning color on any tab, and the status turns Confirm", () => {
    const state = { ...storageConfirmClean({ kind: "clean", days: 90, sessions: 12, bytes: 3.5 * GB }), tab: 1 }
    const lines = render({ state, height: 24 })
    expect(titleRow(lines).find((span) => span.text === "Confirm")).toMatchObject({ fg: "warning", bold: true })
    const rows = plain(lines).map(unwrapPanel)
    const idx = rows.findIndex((r) => r === "remove 12 sessions older than 90 days (≈3.5 GB)? y/n")
    expect(idx).toBeGreaterThan(0)
    expect(rows[idx + 1]).toBe("")
    expect(rows[idx + 2]).toBe("esc back")
    const span = lines.find((line) => text(line).includes("remove 12 sessions"))!.find((s) => s.text.includes("remove 12 sessions"))
    expect(span).toMatchObject({ fg: "warning" })
    expect(plain(render({ state: { confirm: { kind: "vacuum" } } })).map(unwrapPanel).some((line) => line === "full vacuum rewrites the 1.2 GB database and needs that much free disk. y/n")).toBe(true)
  })

  test("a note is shown under the tab's content", () => {
    expect(plain(render({ state: { note: "removed 3 sessions · freed 1.2 GB" }, height: 20 })).map(unwrapPanel).some((line) => line === "removed 3 sessions · freed 1.2 GB")).toBe(true)
  })

  test("loading and error states show one message and no tabs, and the status turns Error", () => {
    const loading = render({ report: undefined })
    expect(plain(loading).map(unwrapPanel).some((line) => line === "measuring storage…")).toBe(true)
    expect(text(tabsRow(loading)).trim()).toMatch(/^─+$/)
    const error = render({ report: undefined, error: "daemon too old" })
    expect(plain(error).map(unwrapPanel).some((line) => line === "daemon too old")).toBe(true)
    expect(titleRow(error).find((span) => span.text === "Error")).toMatchObject({ fg: "error", bold: true })
    const span = error.find((line) => text(line).includes("daemon too old"))!.find((s) => s.text.includes("daemon too old"))
    expect(span).toMatchObject({ fg: "warning" })
  })

  test("an empty store renders zero rows", () => {
    const empty = report({ topSessions: [], sessions: 0, events: 0, blobs: 0, blobBytes: 0, orphanBlobs: 0, orphanBytes: 0, eventBytes: 0, engineBytes: 0, otherBytes: 0, freeBytes: 0, dbBytes: 100 * 1024, walBytes: 0 })
    expect(plain(render({ report: empty, state: sessionsTab })).map(unwrapPanel)).toContain("no sessions")
    expect(plain(render({ report: empty })).map(unwrapPanel).find((line) => line.startsWith("blobs (0 files)"))).toMatch(/0 B {1,}░{10}$/)
  })

  test.each([[60, 20], [80, 30], [120, 40], [160, 50]])("fills exactly %ix%i on every tab", (width, height) => {
    for (const state of [overview, sessionsTab, blobsTab]) {
      for (const r of [report(), undefined]) {
        const lines = renderStoragePage({ report: r, state, width, height, now: NOW, retentionDays: 30 })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(text(line))).toBe(width)
      }
    }
  })

  test("output has exactly height lines and never exceeds the width at a range of sizes", () => {
    for (const width of [40, 60, 90, 100, 120, 140, 160]) {
      for (const height of [1, 3, 8, 14, 20, 30, 35, 50]) {
        for (const state of [overview, sessionsTab, blobsTab, { confirm: { kind: "vacuum" as const } }, { note: "n" }]) {
          for (const r of [report(), undefined]) {
            const lines = renderStoragePage({ report: r, state, width, height, now: NOW, retentionDays: 30 })
            expect(lines.length).toBe(height)
            for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test("on wide terminals the grid and title span the available width", () => {
    const lines = plain(render({ width: 160, height: 35 }))
    expect(lines[1]!.trimEnd()).toEndWith("84,120 events")
    const row = lines.find((line) => line.includes("database"))!
    expect(row.indexOf("│")).toBe(1)
  })

  test("wide characters in titles stay inside the width", () => {
    const wide = report({ topSessions: [{ sessionId: "ses_1" as never, title: "猫".repeat(80), directory: "/日本語/".repeat(20), updatedAt: NOW, bytes: 5 * MB }] })
    for (const width of [40, 60, 100]) for (const line of plain(render({ report: wide, state: sessionsTab, width, height: 30 }))) expect(textWidth(line)).toBeLessThanOrEqual(width)
  })

  test("short heights cut the tab from the bottom and keep the top rows", () => {
    const lines = plain(render({ height: 14 })).map(unwrapPanel)
    expect(lines.some((line) => line.startsWith("database"))).toBe(true)
    expect(lines.some((line) => line.startsWith("auto-vacuum"))).toBe(false)
  })
})
