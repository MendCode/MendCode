import { describe, expect, test } from "bun:test"
import type { MemoryEntry } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createMemoryPageState, memoryPageKey, renderMemoryPage, visibleMemories, type MemoryPageState } from "../src/view/memory-page"
import { textWidth } from "../src/view/wrap"

const NOW = Date.UTC(2026, 8, 26, 12)
const HOUR = 3_600_000
const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
const titleRow = (lines: Line[]) => lines[1]!
const tabsRow = (lines: Line[]) => lines[2]!
const ruleRow = (lines: Line[]) => lines[3]!
/** A row without the page's one-cell margin or trailing padding. */
const unwrapPanel = (raw: string): string => raw.replace(/^ /, "").trimEnd()
/** The rows between the rule and the footer: what the page itself shows, not its key hints. */
function bodyOf(lines: Line[]): string[] {
  const rows = plain(lines)
  const footer = rows.findIndex((row) => row.trim() === "esc back")
  return rows.slice(5, footer < 0 ? rows.length : footer).map(unwrapPanel)
}

function entry(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { memoryId: id, scope: "project", directory: "/work/app", text: `text of ${id}`, category: "", status: "saved", source: "user", createdAt: NOW - 10 * HOUR, updatedAt: NOW - 2 * HOUR, ...patch } as MemoryEntry
}

const MEMORIES: MemoryEntry[] = [
  entry("p1", { status: "pending", source: "agent", text: "Use pnpm, never npm, in this repository", category: "tooling", updatedAt: NOW - 1 * HOUR }),
  entry("p2", { status: "pending", source: "agent", scope: "user", text: "Prefers terse answers without filler", category: "style", updatedAt: NOW - 3 * HOUR }),
  entry("s1", { text: "Tests run with bun test", category: "tooling", updatedAt: NOW - 30 * HOUR }),
  entry("s2", { text: "UI copy is English and terse", category: "style", updatedAt: NOW - 5 * HOUR }),
  entry("s3", { scope: "user", text: "Answer in Spanish in chat", updatedAt: NOW - 50 * HOUR }),
  entry("a1", { status: "archived", text: "Old rule about semicolons", updatedAt: NOW - 24 * 20 * HOUR }),
]

const start = () => createMemoryPageState()
const press = (state: MemoryPageState, ...keys: string[]) => {
  let current = state
  let action: ReturnType<typeof memoryPageKey>["action"] = { type: "none" }
  for (const key of keys) ({ state: current, action } = memoryPageKey(current, key, MEMORIES))
  return { state: current, action }
}
const render = (state: MemoryPageState, width = 100, height = 30, memories = MEMORIES) => renderMemoryPage({ memories, state, width, height, now: NOW, directory: "/work/app" })

describe("memory page keys", () => {
  test("starts on the pending tab with nothing selected filter or confirmation", () => {
    expect(start()).toEqual({ tab: "pending", selected: 0, filter: "", filtering: false, scroll: 0, confirmDelete: false, workspace: { view: "project" }, sharing: { scope: "project", scroll: 0 }, extraction: { selected: 0 }, dream: { selected: 0 }, graph: { mode: "ego" }, policies: { row: 0 }, evolution: { selected: 0 } })
  })

  test("tab cycles forward and shift-tab backward through pending, saved, archived, dream, graph, policies and evolution", () => {
    expect(press(start(), "\t").state.tab).toBe("saved")
    expect(press(start(), "\t", "\t").state.tab).toBe("archived")
    expect(press(start(), "\t", "\t", "\t").state.tab).toBe("dream")
    expect(press(start(), "\t", "\t", "\t", "\t").state.tab).toBe("graph")
    expect(press(start(), "\t", "\t", "\t", "\t", "\t").state.tab).toBe("policies")
    expect(press(start(), "\t", "\t", "\t", "\t", "\t", "\t").state.tab).toBe("evolution")
    expect(press(start(), "\t", "\t", "\t", "\t", "\t", "\t", "\t").state.tab).toBe("extraction")
    expect(press(start(), "\t", "\t", "\t", "\t", "\t", "\t", "\t", "\t").state.tab).toBe("sharing")
    expect(press(start(), "\t", "\t", "\t", "\t", "\t", "\t", "\t", "\t", "\t").state.tab).toBe("pending")
    expect(press(start(), "\x1b[Z").state.tab).toBe("sharing")
    expect(press(start(), "\x1b[Z", "\x1b[Z").state.tab).toBe("extraction")
  })

  test("digits 4 to 7 jump to Dream, Graph, Policies and Evolution from every tab", () => {
    for (const from of ["pending", "saved", "archived", "dream", "graph", "policies", "evolution"] as const) {
      const at = { ...start(), tab: from }
      expect(memoryPageKey(at, "4", MEMORIES).state.tab).toBe("dream")
      expect(memoryPageKey(at, "5", MEMORIES).state.tab).toBe("graph")
      expect(memoryPageKey(at, "6", MEMORIES).state.tab).toBe("policies")
      expect(memoryPageKey(at, "7", MEMORIES).state.tab).toBe("evolution")
    }
  })

  test("1 2 and 3 jump to tabs and reset the selection", () => {
    const moved = press(start(), "j", "3")
    expect(moved.state).toMatchObject({ tab: "archived", selected: 0 })
    expect(press(start(), "2").state.tab).toBe("saved")
    expect(press(moved.state, "1").state.tab).toBe("pending")
  })

  test("arrows j and k move within bounds and never wrap", () => {
    expect(press(start(), "\x1b[B").state.selected).toBe(1)
    expect(press(start(), "j", "j", "j").state.selected).toBe(1)
    expect(press(start(), "k").state.selected).toBe(0)
    expect(press(start(), "\x1b[B", "\x1b[A").state.selected).toBe(0)
  })

  test("moving with no effect returns the same state object", () => {
    const state = start()
    expect(memoryPageKey(state, "k", MEMORIES).state).toBe(state)
    expect(memoryPageKey(state, "\x07", MEMORIES).state).toBe(state)
  })

  test("a approves the selected pending proposal, newest first", () => {
    expect(press(start(), "a").action).toEqual({ type: "approve", memoryId: "p1" })
    expect(press(start(), "j", "a").action).toEqual({ type: "approve", memoryId: "p2" })
  })

  test("a does nothing outside the pending tab", () => {
    expect(press(start(), "2", "a").action).toEqual({ type: "none" })
    expect(press(start(), "2", "a").state.filtering).toBe(false)
  })

  test("x rejects a pending proposal and archives a saved memory but does nothing when archived", () => {
    expect(press(start(), "x").action).toEqual({ type: "reject", memoryId: "p1" })
    expect(press(start(), "2", "x").action).toEqual({ type: "reject", memoryId: "s2" })
    expect(press(start(), "3", "x").action).toEqual({ type: "none" })
  })

  test("r restores only from the archived tab", () => {
    expect(press(start(), "3", "r").action).toEqual({ type: "restore", memoryId: "a1" })
    expect(press(start(), "r").action).toEqual({ type: "none" })
    expect(press(start(), "2", "r").action).toEqual({ type: "none" })
  })

  test("e emits an edit action with the current text", () => {
    expect(press(start(), "e").action).toEqual({ type: "edit", memoryId: "p1", text: "Use pnpm, never npm, in this repository" })
    expect(press(start(), "3", "e").action).toEqual({ type: "edit", memoryId: "a1", text: "Old rule about semicolons" })
  })

  test("actions on an empty tab do nothing", () => {
    const empty = memoryPageKey(start(), "a", []).action
    expect(empty).toEqual({ type: "none" })
    expect(memoryPageKey(start(), "d", []).state.confirmDelete).toBe(false)
    expect(memoryPageKey(start(), "e", []).action).toEqual({ type: "none" })
  })

  test("escape closes when there is no filter", () => {
    expect(press(start(), "\x1b").action).toEqual({ type: "close" })
  })
})

describe("memory page delete confirmation", () => {
  test("d asks for confirmation and emits nothing yet", () => {
    const result = press(start(), "d")
    expect(result.action).toEqual({ type: "none" })
    expect(result.state.confirmDelete).toBe(true)
  })

  test("a second d confirms the delete of the selected memory", () => {
    const result = press(start(), "j", "d", "d")
    expect(result.action).toEqual({ type: "delete", memoryId: "p2" })
    expect(result.state.confirmDelete).toBe(false)
  })

  test("y also confirms", () => {
    expect(press(start(), "d", "y").action).toEqual({ type: "delete", memoryId: "p1" })
  })

  test("any other key cancels without acting and is consumed", () => {
    for (const key of ["n", "a", "x", "\x1b", "j"]) {
      const result = press(start(), "d", key)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state.confirmDelete).toBe(false)
      expect(result.state.selected).toBe(0)
    }
  })

  test("escape while confirming cancels instead of closing", () => {
    expect(press(start(), "d", "\x1b").action.type).toBe("none")
  })

  test("switching tabs is not possible mid confirmation and a cancelled prompt leaves the tab", () => {
    expect(press(start(), "d", "2").state.tab).toBe("pending")
  })
})

describe("memory page filtering", () => {
  test("slash starts filtering and typed keys extend the filter even when they are commands", () => {
    const result = press(start(), "/", "a", "x")
    expect(result.state).toMatchObject({ filtering: true, filter: "ax" })
    expect(result.action).toEqual({ type: "none" })
  })

  test("a non command printable key starts filtering with that character", () => {
    expect(press(start(), "z").state).toMatchObject({ filtering: true, filter: "z" })
  })

  test("filter matches text or category case-insensitively with all terms", () => {
    expect(visibleMemories(MEMORIES, "saved", "TOOLING").map((m) => m.memoryId)).toEqual(["s1"])
    expect(visibleMemories(MEMORIES, "saved", "english terse").map((m) => m.memoryId)).toEqual(["s2"])
    expect(visibleMemories(MEMORIES, "saved", "english bun")).toEqual([])
    expect(visibleMemories(MEMORIES, "saved", "STYLE").map((m) => m.memoryId)).toEqual(["s2"])
  })

  test("sort is newest update first", () => {
    expect(visibleMemories(MEMORIES, "saved", "").map((m) => m.memoryId)).toEqual(["s2", "s1", "s3"])
  })

  test("backspace edits the filter and resets the selection", () => {
    const result = press(start(), "j", "/", "u", "s", "\x7f")
    expect(result.state).toMatchObject({ filter: "u", selected: 0 })
  })

  test("enter ends filtering mode and returns commands to normal", () => {
    const result = press(start(), "/", "p", "\r", "a")
    expect(result.state.filtering).toBe(false)
    expect(result.action).toEqual({ type: "approve", memoryId: "p1" })
  })

  test("acts on the filtered selection", () => {
    const result = press(start(), "/", "t", "e", "r", "s", "e", "\r", "a")
    expect(result.action).toEqual({ type: "approve", memoryId: "p2" })
  })

  test("escape clears the filter first and closes on the second press", () => {
    const filtered = press(start(), "/", "u")
    const cleared = press(filtered.state, "\x1b")
    expect(cleared.action).toEqual({ type: "none" })
    expect(cleared.state).toMatchObject({ filter: "", filtering: false })
    expect(press(cleared.state, "\x1b").action).toEqual({ type: "close" })
  })

  test("the filter persists across tab switches", () => {
    expect(press(start(), "/", "s", "t", "\t").state.filter).toBe("st")
  })

  test("scroll follows the selection when moving past the visible rows", () => {
    let state = start()
    const many = Array.from({ length: 10 }, (_, i) => entry(`m${i}`, { updatedAt: NOW - i * HOUR }))
    for (let i = 0; i < 6; i++) state = memoryPageKey({ ...state, tab: "saved" }, "j", many, 3).state
    expect(state.selected).toBe(6)
    expect(state.scroll).toBe(4)
    for (let i = 0; i < 6; i++) state = memoryPageKey(state, "k", many, 3).state
    expect(state.scroll).toBe(0)
  })
})

const lineText = (line: Line) => line.map((span) => span.text).join("")

describe("memory page chrome", () => {
  test("title row is 'Memory · dir' with the counts on the right, no brand and no live dot", () => {
    const title = lineText(titleRow(render(start()))).trim()
    expect(title).toStartWith("Memory · dir /work/app")
    expect(title).toEndWith("2 pending · 3 saved · 1 archived")
    expect(title).not.toContain("MENDCODE")
    expect(title).not.toContain("LIVE")
    expect(title).not.toContain("●")
  })

  test("a rule row follows the tabs and the footer starts with esc back", () => {
    const lines = render(start())
    expect(lineText(ruleRow(lines)).trim()).toMatch(/^─+$/)
    const rows = plain(lines)
    const back = rows.findIndex((row) => row.trim() === "esc back")
    expect(back).toBeGreaterThan(4)
    expect(rows[back + 1]).toContain("a approve")
    expect(rows.slice(back + 1).join("\n")).toContain("tab/1-9 tabs")
  })

  test("a pending delete shows a bold warning status on the right", () => {
    const lines = render({ ...start(), confirmDelete: true })
    expect(lineText(titleRow(lines))).toContain("Confirm")
    expect(titleRow(lines).find((span) => span.text === "Confirm")).toMatchObject({ fg: "warning", bold: true })
  })

  test("hints in the footer change with the active tab", () => {
    expect(plain(render({ ...start(), tab: "saved" })).join("\n")).toContain("x archive")
    expect(plain(render({ ...start(), tab: "archived" })).join("\n")).toContain("r restore")
    expect(plain(render(start())).join("\n")).toContain("a approve")
  })

  test("tabs are numbered Pending, Saved and Archived and the active one is highlighted", () => {
    const row = lineText(tabsRow(render(start(), 180)))
    expect(row).toContain("1 Pending")
    expect(row).toContain("2 Saved")
    expect(row).toContain("3 Archived")
    for (const [tab, label] of [["pending", "Pending"], ["saved", "Saved"], ["archived", "Archived"]] as const) {
      const spans = tabsRow(render({ ...start(), tab }, 180))
      expect(spans.find((span) => span.text.includes(label))).toMatchObject({ fg: "text", bg: "element", bold: true })
      expect(spans.filter((span) => span.bg === "element")).toHaveLength(1)
    }
  })

  test("switching tabs shows that tab's entries only", () => {
    const pending = bodyOf(render(start())).join("\n")
    expect(pending).toContain("Use pnpm")
    expect(pending).not.toContain("Tests run with bun test")
    const saved = bodyOf(render(press(start(), "2").state)).join("\n")
    expect(saved).toContain("Tests run with bun test")
    expect(saved).not.toContain("Use pnpm")
    const archived = bodyOf(render(press(start(), "3").state)).join("\n")
    expect(archived).toContain("Old rule about semicolons")
  })

  test("no boxes and no section title repeating the page title", () => {
    const text = plain(render(start())).join("\n")
    expect(text).not.toMatch(/[┌┐└┘│]/)
    expect(text.match(/Memory/g)).toHaveLength(1)
  })

  test.each([[60, 20], [80, 30], [120, 40], [160, 50]])("fills exactly %ix%i on every tab", (width, height) => {
    for (const tab of ["pending", "saved", "archived"] as const) {
      const lines = render({ ...start(), tab }, width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(lineText(line))).toBe(width)
    }
  })

  test("output has exactly height lines within width for a range of sizes, including narrow and wide layouts", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`m${i}`, { status: "pending", text: `memory number ${i} `.repeat(6) + "猫".repeat(20), category: "cat", source: "agent", updatedAt: NOW - i * HOUR }))
    for (const width of [40, 60, 72, 90, 100, 120, 140, 160]) {
      for (const height of [3, 6, 12, 20, 24, 30, 35, 50]) {
        for (const confirmDelete of [false, true]) {
          for (const memories of [many, MEMORIES, []]) {
            const lines = render({ ...start(), selected: 7, confirmDelete }, width, height, memories)
            expect(lines.length).toBe(height)
            for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })
})

describe("memory page rows", () => {
  test("rows show text first then scope, category, agent marker and relative time", () => {
    const rows = plain(render(start())).map(unwrapPanel)
    const first = rows.findIndex((line) => line === "❯ Use pnpm, never npm, in this repository")
    expect(first).toBeGreaterThan(0)
    expect(rows[first + 1]).toMatch(/^ {2}new · project · tooling · agent +1h$/)
    expect(rows[first + 2]).toBe("  Prefers terse answers without filler")
    expect(rows[first + 3]).toMatch(/^ {2}new · user · style · agent +3h$/)
  })

  test("scope badges use heading for project and link for user, and the selected row is bold primary", () => {
    const lines = render(start())
    const body = lines
    const selectedRow = body.find((line) => plain([line])[0]!.includes("❯ Use pnpm"))!
    expect(selectedRow.find((span) => span.text === "❯ ")).toMatchObject({ fg: "warning", bold: true })
    expect(selectedRow.find((span) => span.text.startsWith("Use pnpm"))).toMatchObject({ fg: "primary", bold: true })
    const badgeRow = body.find((line) => plain([line])[0]!.includes("project · tooling"))!
    expect(badgeRow.find((span) => span.text === "new")).toMatchObject({ fg: "success", bold: true })
    expect(badgeRow.find((span) => span.text === "project")).toMatchObject({ fg: "heading" })
    const userRow = body.find((line) => plain([line])[0]!.includes("· user ·"))!
    expect(userRow.find((span) => span.text === "user")).toMatchObject({ fg: "link" })
  })

  test("saved rows omit the agent marker for user entries and show the directory of other projects", () => {
    const memories = [entry("s1", { directory: "/somewhere/else/entirely" }), entry("s2")]
    const text = plain(render({ ...start(), tab: "saved" }, 100, 20, memories)).map(unwrapPanel).join("\n")
    expect(text).toContain("/somewhere/else/entirely")
    expect(text).not.toContain("agent")
  })

  test("long text wraps to three lines and ends with an ellipsis", () => {
    const long = entry("s1", { text: "word ".repeat(80) })
    const rows = plain(render({ ...start(), tab: "saved" }, 80, 24, [long])).map(unwrapPanel)
    const first = rows.findIndex((line) => line.startsWith("❯ word"))
    expect(first).toBeGreaterThan(0)
    expect(rows[first + 2]).toEndWith("…")
    expect(rows[first + 3]).toStartWith("  project")
  })

  test("newlines in memory text collapse into spaces", () => {
    const rows = plain(render({ ...start(), tab: "saved" }, 60, 12, [entry("s1", { text: "line one\n\nline two" })])).map(unwrapPanel)
    expect(rows.some((line) => line === "❯ line one line two")).toBe(true)
  })

  test("empty states per tab", () => {
    const text = (tab: MemoryPageState["tab"]) => plain(render({ ...start(), tab }, 80, 14, [])).map(unwrapPanel).join("\n")
    expect(text("pending")).toContain("no pending proposals")
    expect(text("saved")).toContain("nothing saved yet · /remember <text>")
    expect(text("archived")).toContain("nothing archived")
  })

  test("filter line shows the query and a no-match message", () => {
    const rows = plain(render({ ...start(), filter: "zzz", filtering: true })).map(unwrapPanel)
    expect(rows.some((line) => line === "/ zzz▏")).toBe(true)
    expect(rows.some((line) => line === 'no match for "zzz"')).toBe(true)
    expect(plain(render({ ...start(), filter: "pnpm" })).map(unwrapPanel).some((line) => line === "/ pnpm")).toBe(true)
  })

  test("confirm delete pins an error colored prompt above the list, inside the panel", () => {
    const lines = render({ ...start(), confirmDelete: true }, 80, 14)
    const text = plain(lines).map(unwrapPanel)
    const row = text.findIndex((line) => line === "delete this memory? d/y confirm · any other key cancels")
    expect(row).toBeGreaterThan(0)
    const span = lines.find((line) => plain([line])[0]!.includes("delete this memory"))!.find((s) => s.text.includes("delete this memory"))
    expect(span).toMatchObject({ fg: "error", bold: true })
  })

  test("the selected row stays visible when the list scrolls", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`m${i}`, { text: `entry ${i}`, updatedAt: NOW - i * HOUR }))
    for (const selected of [0, 5, 17, 29]) {
      const text = plain(render({ ...start(), tab: "saved", selected, scroll: 0 }, 60, 14, many)).map(unwrapPanel)
      expect(text.some((line) => line === `❯ entry ${selected}`)).toBe(true)
    }
  })

  test("a stale scroll after deleting entries does not leave a gap at the end", () => {
    const few = Array.from({ length: 3 }, (_, i) => entry(`m${i}`, { text: `entry ${i}`, updatedAt: NOW - i * HOUR }))
    const text = plain(render({ ...start(), tab: "saved", selected: 0, scroll: 2 }, 60, 16, few)).map(unwrapPanel)
    expect(text.some((line) => line === "❯ entry 0")).toBe(true)
  })

  test("wrapping at width 40 80 and 140 keeps wide characters inside the width", () => {
    const wide = entry("s1", { text: "猫".repeat(60), category: "日本語" })
    for (const width of [40, 80, 140]) {
      for (const line of plain(render({ ...start(), tab: "saved" }, width, 16, [wide]))) expect(textWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("narrow and short sizes keep the title, the tabs and the list without boxes", () => {
    const lines = render(start(), 60, 20)
    expect(lineText(titleRow(lines))).toContain("Memory · dir /work/app")
    // Seven tabs no longer fit by name in 60 cells: the numbers stay (they are the keys), and the names return from 64.
    expect(lineText(tabsRow(lines))).toMatch(/1\s+2\s+3\s+4\s+5\s+6\s+7/)
    expect(lineText(tabsRow(render(start(), 90, 20)))).toContain("1 Pend")
    expect(bodyOf(lines).some((row) => row.startsWith("❯ Use pnpm"))).toBe(true)
    expect(plain(lines).join("\n")).not.toContain("┌")
  })
})

describe("memory page wide layout (width >= 120): list + full detail panel", () => {
  const at = (width: number, height = 35, state: MemoryPageState = start(), memories = MEMORIES) => renderMemoryPage({ memories, state, width, height, now: NOW, directory: "/work/app" })

  test("a Detail panel appears beside the list and shows the selected entry's full text", () => {
    const text = plain(at(140)).join("\n")
    expect(text).toContain("Detail")
    expect(text).toContain("Use pnpm, never npm, in this repository")
  })

  test("no detail panel below the wide threshold", () => {
    const text = plain(at(100)).join("\n")
    expect(text).not.toContain("Detail")
  })

  test("the detail panel says so when nothing is selected", () => {
    const text = plain(at(140, 35, start(), [])).join("\n")
    expect(text).toContain("no entry selected")
  })
})

describe("memory page revisions", () => {
  const saved = entry("s1", { text: "Package manager is npm for this repository", category: "commands", updatedAt: NOW - 30 * HOUR })
  const saved2 = entry("s2", { text: "Deploys go through Heroku and nothing else", category: "commands", updatedAt: NOW - 40 * HOUR })
  const update = entry("u1", { status: "pending", source: "agent", kind: "update", targetId: "s1", text: "Package manager is pnpm 11 for this repository, never npm", reason: "user switched to pnpm on 2026-09-20", category: "commands", updatedAt: NOW - HOUR })
  const archive = entry("r1", { status: "pending", source: "agent", kind: "archive", targetId: "s2", text: saved2.text, reason: "Heroku was retired", category: "commands", updatedAt: NOW - 2 * HOUR })
  const fresh = entry("n1", { status: "pending", source: "agent", text: "Releases are cut with bun run release", updatedAt: NOW - 3 * HOUR })
  const all = [saved, saved2, update, archive, fresh, entry("a1", { status: "archived", text: "Old rule about semicolons" })]
  const at = (width: number, height = 30, state: MemoryPageState = start(), memories = all) => renderMemoryPage({ memories, state, width, height, now: NOW, directory: "/work/app" })

  test("an update shows the old text as - and the new text as +, with the reason and an update badge", () => {
    const rows = plain(at(100)).map(unwrapPanel)
    const first = rows.findIndex((line) => line.includes("- Package manager is npm"))
    expect(first).toBeGreaterThan(0)
    expect(rows[first]).toStartWith("❯ - Package manager is npm")
    expect(rows[first + 1]).toStartWith("  + Package manager is pnpm 11")
    expect(rows[first + 2]).toContain("why user switched to pnpm")
    expect(rows[first + 3]).toMatch(/^ {2}update · project · commands · agent +1h$/)
  })
  test("the diff colors follow error for removed and success for added text", () => {
    const rows = at(100)
    const minusRow = rows.find((row) => row.some((span) => span.text === "- "))!
    const plusRow = rows.find((row) => row.some((span) => span.text === "+ "))!
    const minus = minusRow.find((span) => span.text === "- ")!
    const plus = plusRow.find((span) => span.text === "+ ")!
    expect(minus).toMatchObject({ fg: "error", bold: true })
    expect(plus).toMatchObject({ fg: "success", bold: true })
    expect(plusRow[plusRow.indexOf(plus) + 1]).toMatchObject({ fg: "success" })
  })
  test("an archive shows only the memory that would be retired, with its reason and badge", () => {
    const rows = plain(at(100, 30, { ...start(), selected: 1 })).map(unwrapPanel)
    expect(rows.some((line) => line.startsWith("❯ - Deploys go through Heroku"))).toBe(true)
    expect(rows.some((line) => line.trim().startsWith("+") && line.includes("Heroku"))).toBe(false)
    expect(rows.some((line) => line.includes("why Heroku was retired"))).toBe(true)
    expect(rows.some((line) => /^ {2}archive · project/.test(line))).toBe(true)
  })
  test("new proposals show a new badge and only the text", () => {
    const rows = plain(at(100, 30, { ...start(), selected: 2 })).map(unwrapPanel)
    expect(rows.some((line) => line.startsWith("❯ Releases are cut with bun run release"))).toBe(true)
    expect(rows.some((line) => /^ {2}new · project/.test(line))).toBe(true)
  })
  test("badge colors: new success, update warning, archive error", () => {
    const rows = at(100)
    const badge = (text: string) => rows.flat().find((span) => span.text === text)
    expect(badge("new")).toMatchObject({ fg: "success", bold: true })
    expect(badge("update")).toMatchObject({ fg: "warning", bold: true })
    expect(badge("archive")).toMatchObject({ fg: "error", bold: true })
  })
  test("a missing target is called out instead of throwing", () => {
    const rows = plain(at(100, 30, start(), [update, fresh])).map(unwrapPanel)
    expect(rows.some((line) => line.includes("- (the memory no longer exists)"))).toBe(true)
    expect(rows.some((line) => line.trim().startsWith("+ Package manager is pnpm"))).toBe(true)
  })
  test("badges only appear on the pending tab", () => {
    for (const tab of ["saved", "archived"] as const) {
      /** Only the page's own rows, not the footer hint text (which legitimately says "x archive"). */
      const text = bodyOf(at(100, 30, { ...start(), tab })).join("\n")
      expect(text).not.toMatch(/\b(update|archive) ·/)
      expect(text).not.toContain("- Package manager")
    }
  })
  test.each([40, 50, 60, 80, 100, 140])("every line fits at %i columns and the page is exactly the requested height", (width) => {
    for (const height of [6, 12, 20, 30]) {
      for (const selected of [0, 1, 2]) {
        const lines = at(width, height, { ...start(), selected })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(line.map((s) => s.text).join(""))).toBeLessThanOrEqual(width)
      }
    }
  })
  test("long texts and reasons are clipped with an ellipsis rather than overflowing", () => {
    const long = entry("u2", { status: "pending", kind: "update", targetId: "s1", text: "word ".repeat(80), reason: "because ".repeat(40), source: "agent" })
    const lines = plain(at(40, 30, start(), [saved, long]))
    expect(lines.some((line) => line.includes("…"))).toBe(true)
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(40)
  })
  test("the selection stays visible when revisions take several lines each", () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`u${i}`, { status: "pending", kind: "update", targetId: "s1", text: `Revised text number ${i} of the memory`, reason: "why", source: "agent", updatedAt: NOW - i * HOUR }))
    for (const selected of [0, 4, 7]) {
      const rows = plain(at(80, 20, { ...start(), selected, scroll: 0 }, [saved, ...many])).map(unwrapPanel)
      const markerRow = rows.findIndex((line) => line.startsWith("❯ "))
      expect(rows.filter((line) => line.startsWith("❯ ")).length).toBe(1)
      // The marker sits on the entry's first rendered line, which for an update is the "-" (old) side.
      expect(rows[markerRow]).toContain("Package manager is npm")
      expect(rows[markerRow + 1]).toContain(`Revised text number ${selected}`)
    }
  })
  test("keys: a accepts and x rejects a revision; e edits an update but not an archive", () => {
    const memories = [saved, saved2, update, archive]
    const key = (k: string, selected: number) => memoryPageKey({ ...start(), selected }, k, memories).action
    expect(key("a", 0)).toEqual({ type: "approve", memoryId: "u1" })
    expect(key("x", 0)).toEqual({ type: "reject", memoryId: "u1" })
    expect(key("e", 0)).toEqual({ type: "edit", memoryId: "u1", text: update.text })
    expect(key("a", 1)).toEqual({ type: "approve", memoryId: "r1" })
    expect(key("e", 1)).toEqual({ type: "none" })
  })
  test("the filter also searches reasons and kinds", () => {
    expect(visibleMemories(all, "pending", "heroku").map((m) => m.memoryId)).toEqual(["r1"])
    expect(visibleMemories(all, "pending", "switched").map((m) => m.memoryId)).toEqual(["u1"])
    expect(visibleMemories(all, "pending", "archive").map((m) => m.memoryId)).toEqual(["r1"])
  })
  test("the archived tab lists retired memories with restore", () => {
    const state = { ...start(), tab: "archived" as const }
    expect(plain(at(100, 20, state)).join("\n")).toContain("Old rule about semicolons")
    expect(memoryPageKey(state, "r", all).action).toEqual({ type: "restore", memoryId: "a1" })
    expect(plain(at(100, 20, state)).join("\n")).toContain("r restore")
  })
})
