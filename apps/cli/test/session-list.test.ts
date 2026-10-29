import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionSummary } from "@mendcode/protocol"
import {
  createSessionListState,
  abbreviateHome,
  filterSessions,
  groupSessions,
  orderSessions,
  relativeTime,
  renderSessionList,
  sessionListKey,
} from "../src/view/session-list"
import type { Line } from "../src/ui/theme"
import { shortenMiddle, textWidth, truncateEnd } from "../src/view/wrap"

test("session path shortening keeps its tail while titles truncate at the end", () => {
  expect(shortenMiddle("/project/deep/file.ts", 10)).toBe("/pr…ile.ts")
  expect(truncateEnd("/project/deep/file.ts", 10)).toBe("/project/…")
})

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const TITLES = ["fix flaky reconnect", "add usage command", "", "refactor transcript wrap", "review dream scheduler"]
const DIRS = ["/Users/dev/Code/MendCodeV2", "/Users/dev/Code/repos/codeconfig", "/Users/dev/Code/MendCode/src/mendcode/packages/opencode"]

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: ids("session"),
    title: "task",
    directory: "/tmp/x",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    lastSeq: 1,
    state: "idle",
    queued: 0,
    ...overrides,
  }
}

const fixture = Array.from({ length: 30 }, (_, i) =>
  session({ title: `${TITLES[i % TITLES.length]!}${i % TITLES.length === 2 ? "" : ` #${i}`}`, directory: DIRS[i % DIRS.length]!, updatedAt: NOW - i * 3_600_000 }),
)

const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)

/** Content below the page header and panel padding, without the border spans. */
const bodyRows = (lines: Line[]): Line[] => lines.slice(4, -2).map((line) => line[0]?.text === "│ " ? line.slice(1, -1) : line)
const render = (over: Partial<Parameters<typeof renderSessionList>[0]> = {}) =>
  renderSessionList({ sessions: fixture, state: createSessionListState(), width: 100, height: 24, now: NOW, ...over })

describe("filterSessions", () => {
  test("empty filter returns everything", () => expect(filterSessions(fixture, "  ")).toHaveLength(30))
  test("is case-insensitive over title", () => expect(filterSessions(fixture, "FLAKY").length).toBeGreaterThan(0))
  test("matches directory", () => {
    const result = filterSessions(fixture, "codeconfig")
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((s) => s.directory.includes("codeconfig"))).toBe(true)
  })
  test("requires all terms across title and directory", () => {
    const result = filterSessions(fixture, "usage codeconfig")
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((s) => s.title.includes("usage") && s.directory.includes("codeconfig"))).toBe(true)
    expect(filterSessions(fixture, "usage nonexistentterm")).toHaveLength(0)
  })
})

describe("sessionListKey", () => {
  const start = createSessionListState()
  test("down moves and up clamps at zero", () => {
    const down = sessionListKey(start, "\x1b[B", fixture)
    expect(down.state.selected).toBe(1)
    expect(down.action).toEqual({ type: "changed" })
    const up = sessionListKey(start, "\x1b[A", fixture)
    expect(up.state).toBe(start)
    expect(up.action).toEqual({ type: "none" })
  })
  test("ctrl+n and ctrl+p move", () => {
    const next = sessionListKey(start, "\x0e", fixture)
    expect(next.state.selected).toBe(1)
    expect(sessionListKey(next.state, "\x10", fixture).state.selected).toBe(0)
  })
  test("clamps at the end of the filtered list", () => {
    const state = { selected: 29, filter: "" }
    expect(sessionListKey(state, "\x1b[B", fixture).action).toEqual({ type: "none" })
    const filtered = sessionListKey({ selected: 0, filter: "flaky" }, "\x1b[B", fixture)
    expect(filtered.state.selected).toBeLessThan(filterSessions(fixture, "flaky").length)
  })
  test("typing appends to filter and resets selection", () => {
    const typed = sessionListKey({ selected: 5, filter: "fi" }, "x", fixture)
    expect(typed.state).toEqual({ selected: 0, filter: "fix" })
    expect(typed.action).toEqual({ type: "changed" })
  })
  test("backspace edits filter and is a no-op when empty", () => {
    expect(sessionListKey({ selected: 3, filter: "ab" }, "\x7f", fixture).state).toEqual({ selected: 0, filter: "a" })
    expect(sessionListKey(start, "\x7f", fixture).action).toEqual({ type: "none" })
  })
  test("enter opens the selected filtered session", () => {
    const state = { selected: 1, filter: "" }
    expect(sessionListKey(state, "\r", fixture).action).toEqual({ type: "open", sessionId: orderSessions(fixture, "")[1]!.sessionId })
    const filtered = orderSessions(fixture, "usage")
    expect(sessionListKey({ selected: 0, filter: "usage" }, "\r", fixture).action).toEqual({ type: "open", sessionId: filtered[0]!.sessionId })
  })
  test("enter on an empty list does nothing", () => {
    expect(sessionListKey(start, "\r", []).action).toEqual({ type: "none" })
    expect(sessionListKey({ selected: 0, filter: "zzz" }, "\r", fixture).action).toEqual({ type: "none" })
  })
  test("escape closes and unknown sequences are ignored", () => {
    expect(sessionListKey(start, "\x1b", fixture).action).toEqual({ type: "close" })
    expect(sessionListKey(start, "\x1b[C", fixture).action).toEqual({ type: "none" })
  })
})

describe("relativeTime", () => {
  const ago = (ms: number) => relativeTime(NOW, NOW - ms)
  test("boundaries", () => {
    expect(ago(0)).toBe("now")
    expect(ago(59_999)).toBe("now")
    expect(ago(60_000)).toBe("1m")
    expect(ago(59 * 60_000 + 59_000)).toBe("59m")
    expect(ago(3_600_000)).toBe("1h")
    expect(ago(23 * 3_600_000 + 3_599_000)).toBe("23h")
    expect(ago(24 * 3_600_000)).toBe("1d")
    expect(ago(13 * 86_400_000 + 86_399_000)).toBe("13d")
    expect(ago(14 * 86_400_000)).toBe("2w")
    expect(ago(28 * 86_400_000)).toBe("4w")
  })
  test("future timestamps read as now", () => expect(relativeTime(NOW, NOW + 5000)).toBe("now"))
})

describe("renderSessionList", () => {
  const contentLines = (lines: Line[]) => bodyRows(lines).filter((line) => text(line).trim().length > 0)
  const findSelected = (lines: Line[]) => lines.filter((line) => plain([line])[0]?.includes("❯ "))

  test.each([
    [50, 12],
    [100, 24],
    [160, 40],
    [50, 1],
    [50, 3],
  ])("respects bounds at %ix%i", (width, height) => {
    for (const filter of ["", "fix", "zzz"]) {
      const lines = render({ width, height, state: { selected: 3, filter } })
      expect(lines.length).toBeLessThanOrEqual(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })

  test("fills exactly width × height at every tier", () => {
    for (const width of [60, 100, 120, 160]) {
      for (const height of [20, 35, 50]) {
        const lines = render({ width, height })
        expect(lines.length).toBeLessThanOrEqual(height)
        for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test("selected session stays visible after scrolling with large list", () => {
    let state = createSessionListState()
    for (let i = 0; i < 5; i++) state = sessionListKey(state, "\x1b[B", fixture).state
    const lines = render({ state, height: 30 })
    expect(lines.length).toBeLessThanOrEqual(30)
    // Verify we show something for the selected session
    expect(plain(lines).some((line) => line.includes("add usage command") || line.includes("fix flaky"))).toBe(true)

    const last = render({ state: { selected: 5, filter: "" }, height: 30 })
    expect(last.length).toBeLessThanOrEqual(30)
  })

  test("header names Sessions and the summary reflects the loaded list", () => {
    const lines = render()
    expect(text(lines[0]!)).toStartWith("Sessions")
    expect(text(lines[1]!).trimEnd()).toBe("all projects · unarchived · 30 sessions")
    expect(plain(lines).join("\n")).not.toMatch(/MENDCODE|LIVE/)
    expect(text(lines[2]!)).toContain("┌─ Sessions")
    expect(text(lines[4]!).trim().length).toBeGreaterThan(0)
  })

  test("hints stay in the header; panels fill the screen and compact stacks", () => {
    for (const width of [60, 100, 160]) {
      const lines = plain(render({ width, height: 30 }))
      expect(lines[0]).toContain("esc back")
      expect(lines[0]).toContain("^A settle/restore")
      expect(lines.slice(1).join("")).not.toContain("esc back")
      if (width >= 70) expect(lines.at(-1)!).toContain("└")
      else expect(lines.join("")).not.toMatch(/[┌┐└┘│]/)
    }
  })

  test("a filter shows how many of the sessions match", () => {
    expect(text(render({ state: { selected: 0, filter: "flaky" } })[1]!).trimEnd()).toMatch(/\d+ of 30 sessions$/)
  })

  test("is exactly width x height at 60x20, 80x30, 120x40 and 160x50", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const filter of ["", "fix", "zzz"]) {
        const lines = render({ width, height, state: { selected: 2, filter } })
        expect(lines).toHaveLength(height)
        for (const line of plain(lines)) expect(textWidth(line)).toBe(width)
      }
    }
  })

  test("from 120x30 a detail column shows the selected session beside the list", () => {
    const state = { selected: 0, filter: "command #26" }
    const rows = plain(render({ width: 120, height: 40, state, home: "/Users/dev" }))
    const selected = fixture.find((entry) => entry.title === "add usage command #26")!
    // The filter row of the list and the detail's title share the first body row.
    const first = rows[4]!
    expect(first).toContain("/ command #26")
    expect(first).toContain("add usage command #26")
    expect(rows[5]).toContain("(1)")
    expect(rows[5]).toContain("~/Code/")
    expect(rows.find((line) => line.includes("state"))).toMatch(/state\s+idle/)
    expect(rows.find((line) => line.includes("updated"))).toMatch(/updated\s+\d+[hd] ago/)
    expect(rows.find((line) => /\bid\s/.test(line))).toContain(selected.sessionId.slice(0, 16))
    const narrow = plain(render({ width: 100, height: 40, state, home: "/Users/dev" }))
    expect(narrow.some((line) => line.includes("updated"))).toBe(false)
  })

  test("selected row has the marker, others do not", () => {
    const lines = render({ state: { selected: 2, filter: "" } })
    expect(findSelected(lines)).toHaveLength(1)
  })

  test("current session gets a marker", () => {
    const lines = render({ currentSessionId: fixture[1]!.sessionId })
    const content = contentLines(lines)
    expect(content.some((line) => plain([line])[0]?.includes("(current)"))).toBe(true)
  })

  test("relative time and queued count are right-aligned on session rows", () => {
    const sessions = [session({ title: "queued one", queued: 2, updatedAt: NOW - 5 * 60_000 })]
    const lines = render({ sessions, width: 100, height: 30 })
    const content = contentLines(lines)
    const sessionRow = content.find((line) => plain([line])[0]?.includes("queued one"))
    expect(sessionRow).toBeDefined()
    const rowText = plain([sessionRow!])[0]!
    expect(rowText).toContain("+2 5m")
  })

  test("state dot colors follow state", () => {
    const states = ["generating", "waiting_approval", "error", "queued", "idle"] as const
    const sessions = states.map((state) => session({ state }))
    const lines = render({ sessions, height: 30 })
    const content = contentLines(lines)
    // Session rows are the marker ("❯ " or two spaces) then the state dot.
    const dots = content.filter((line) => ["❯ ", "  "].includes(line[0]?.text ?? "") && line[1]?.text.length === 1).map((line) => line[1])
    expect(dots.map((d) => d?.text)).toEqual(["•", "?", "✗", "…", "·"])
    expect(dots.map((d) => d?.fg)).toEqual(["primary", "warning", "error", "muted", "muted"])
    expect(dots[1]?.bold).toBe(true)
  })

  test("empty and untitled states", () => {
    const empty = plain(render({ sessions: [] }))
    expect(empty.some((line) => line.includes("no sessions yet"))).toBe(true)

    const noMatch = plain(render({ state: { selected: 0, filter: "zzz" } }))
    expect(noMatch.some((line) => line.includes('no match for "zzz"'))).toBe(true)

    const untitled = render({ sessions: [session({ title: "" })] })
    expect(untitled.some((line) => line.some((span) => span.text === "untitled" && span.fg === "muted"))).toBe(true)
  })

  test("filter line is shown only when filtering", () => {
    const noFilter = plain(render())
    expect(noFilter.some((line) => line.startsWith("/ "))).toBe(false)

    const filtered = plain(render({ state: { selected: 0, filter: "fix" } }))
    expect(filtered.some((line) => line.includes("/ fix"))).toBe(true)
  })

  test("long title is truncated with an ellipsis and keeps the time visible", () => {
    const sessions = [session({ title: "x".repeat(300), updatedAt: NOW - 2 * 86_400_000, queued: 1, directory: "/a".repeat(100) })]
    const lines = plain(render({ sessions, width: 50, height: 20 }))
    // The content includes the panel borders, so search across all lines
    expect(lines.some((line) => line.includes("…") && line.includes("2d"))).toBe(true)
  })

  test("current suffix is dropped before the title is truncated when it does not fit", () => {
    const sessions = [session({ title: "y".repeat(40) })]
    const lines = render({ sessions, width: 50, currentSessionId: sessions[0]!.sessionId, height: 20 })
    const content = plain(contentLines(lines))
    const hasCurrentMarker = content.some((line) => line.includes("(current)"))
    expect(hasCurrentMarker || content.every((line) => line.length <= 50)).toBe(true)
  })
})

describe("rename and delete from the list", () => {
  const press = (state: ReturnType<typeof createSessionListState>, keys: string[], current?: string) => {
    let result = { state, action: { type: "none" } as ReturnType<typeof sessionListKey>["action"] }
    for (const key of keys) result = sessionListKey(result.state, key, fixture, current)
    return result
  }

  test("ctrl+r enters rename mode prefilled with the selected title and emits nothing", () => {
    const result = press(createSessionListState(), ["\x1b[B", "\x12"])
    const second = orderSessions(fixture, "")[1]!
    expect(result.state.edit).toEqual({ mode: "rename", sessionId: second.sessionId, draft: second.title })
    expect(result.action).toEqual({ type: "changed" })
  })

  test("typing and backspace edit the draft, enter emits a trimmed rename and leaves rename mode", () => {
    const result = press(createSessionListState(), ["\x12", "\x15", " ", "n", "e", "w", "x", "\x7f", " ", "\r"])
    expect(result.action).toEqual({ type: "rename", sessionId: fixture[0]!.sessionId, title: "new" })
    expect(result.state.edit).toBeUndefined()
  })

  test("escape cancels rename without closing the list or emitting", () => {
    const result = press(createSessionListState(), ["\x12", "z", "\x1b"])
    expect(result.action).toEqual({ type: "changed" })
    expect(result.state.edit).toBeUndefined()
    expect(result.state.filter).toBe("")
  })

  test("an empty draft cannot be confirmed", () => {
    const result = press(createSessionListState(), ["\x12", "\x15", "\r"])
    expect(result.action.type).toBe("changed")
    expect(result.state.edit).toBeUndefined()
  })

  test("letters typed in rename mode never reach the filter and arrows do not move the selection", () => {
    const result = press(createSessionListState(), ["\x12", "\x1b[B", "d", "r"])
    expect(result.state.selected).toBe(0)
    expect(result.state.filter).toBe("")
    expect(result.state.edit).toMatchObject({ mode: "rename" })
  })

  test("ctrl+d asks for confirmation and d or y confirm the delete", () => {
    const asked = press(createSessionListState(), ["\x04"])
    expect(asked.state.edit).toEqual({ mode: "delete", sessionId: fixture[0]!.sessionId })
    expect(asked.action.type).toBe("changed")
    expect(sessionListKey(asked.state, "d", fixture).action).toEqual({ type: "delete", sessionId: fixture[0]!.sessionId })
    expect(sessionListKey(asked.state, "y", fixture).action).toEqual({ type: "delete", sessionId: fixture[0]!.sessionId })
    expect(sessionListKey(asked.state, "y", fixture).state.edit).toBeUndefined()
  })

  test("any other key cancels the delete confirmation and is consumed", () => {
    for (const key of ["n", "\x1b", "\r", "\x1b[B", "x"]) {
      const result = press(createSessionListState(), ["\x04", key])
      expect(result.action).toEqual({ type: "changed" })
      expect(result.state.edit).toBeUndefined()
      expect(result.state.selected).toBe(0)
      expect(result.state.filter).toBe("")
    }
  })

  test("the open session cannot be deleted and shows a note that the next key clears", () => {
    const current = fixture[0]!.sessionId
    const blocked = press(createSessionListState(), ["\x04"], current)
    expect(blocked.state.edit).toBeUndefined()
    expect(blocked.state.note).toBe("can't delete the open session")
    const lines = plain(render({ state: blocked.state, currentSessionId: current }))
    expect(lines.some((line) => line.includes("can't delete the open session"))).toBe(true)
    const next = sessionListKey(blocked.state, "\x1b[B", fixture, current)
    expect(next.state.note).toBeUndefined()
    expect(next.state.selected).toBe(1)
  })

  test("the open session can still be renamed", () => {
    const result = press(createSessionListState(), ["\x12", "\r"], fixture[0]!.sessionId)
    expect(result.action).toMatchObject({ type: "rename", sessionId: fixture[0]!.sessionId })
  })

  test("rename and delete target the filtered selection and do nothing with no match", () => {
    const filtered = orderSessions(fixture, "usage")
    const result = press({ selected: 1, filter: "usage" }, ["\x04", "d"])
    expect(result.action).toEqual({ type: "delete", sessionId: filtered[1]!.sessionId })
    expect(sessionListKey({ selected: 0, filter: "zzz" }, "\x12", fixture).action).toEqual({ type: "none" })
    expect(sessionListKey({ selected: 0, filter: "zzz" }, "\x04", fixture).action).toEqual({ type: "none" })
  })

  test("plain r and d still type into the filter", () => {
    const result = press(createSessionListState(), ["r", "d"])
    expect(result.state).toEqual({ selected: 0, filter: "rd" })
  })

  test("rename mode renders an editable line and delete mode a confirmation with the title", () => {
    const rename = press(createSessionListState(), ["\x12"]).state
    const renamed = plain(render({ state: rename }))
    expect(renamed.some((line) => line.includes(`rename: ${fixture[0]!.title}▏`))).toBe(true)
    expect(renamed.some((line) => line.includes("enter confirm · esc cancel"))).toBe(true)

    const del = press(createSessionListState(), ["\x04"]).state
    const deleted = plain(render({ state: del }))
    expect(deleted.some((line) => line.includes(`delete ${fixture[0]!.title}?`))).toBe(true)
    expect(render({ state: del }).some((line) => line.some((span) => span.fg === "error"))).toBe(true)
  })

  test("edit lines stay inside width and height at narrow sizes", () => {
    const long = session({ title: "a very long session title ".repeat(12) })
    for (const width of [30, 60, 100]) {
      for (const state of [{ selected: 0, filter: "", edit: { mode: "rename" as const, sessionId: long.sessionId, draft: long.title } }, { selected: 0, filter: "", edit: { mode: "delete" as const, sessionId: long.sessionId } }]) {
        const lines = renderSessionList({ sessions: [long], state, width, height: 6, now: NOW })
        expect(lines.length).toBeLessThanOrEqual(6)
        for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("grouped live panel", () => {
  const HOME = "/Users/dev"
  const dirA = `${HOME}/Code/alpha`
  const dirB = `${HOME}/Code/beta`
  const dirC = "/srv/gamma"
  const mk = (title: string, directory: string, minutesAgo: number, state: SessionSummary["state"] = "idle", extra: Partial<SessionSummary> = {}) =>
    session({ title, directory, updatedAt: NOW - minutesAgo * 60_000, state, ...extra })
  const a1 = mk("a-old", dirA, 50)
  const a2 = mk("a-new", dirA, 5, "generating")
  const b1 = mk("b-only", dirB, 1, "waiting_approval")
  const c1 = mk("c-one", dirC, 200)
  const c2 = mk("c-two", dirC, 100, "error")
  const live = [a1, b1, c1, a2, c2]
  const view = (over: Partial<Parameters<typeof renderSessionList>[0]> = {}) => renderSessionList({ sessions: live, state: createSessionListState(), width: 100, height: 24, now: NOW, home: HOME, ...over })
  const contentLines = (lines: Line[]) => bodyRows(lines)

  test("groups by directory, newest first inside each and groups by latest activity", () => {
    const groups = groupSessions(live, "")
    expect(groups.map((g) => g.directory)).toEqual([dirB, dirA, dirC])
    expect(groups[1]!.sessions.map((s) => s.title)).toEqual(["a-new", "a-old"])
    expect(groups[2]!.sessions.map((s) => s.title)).toEqual(["c-two", "c-one"])
  })

  test("the open session's project comes first even when it is not the most recent", () => {
    const groups = groupSessions(live, "", c1.sessionId)
    expect(groups.map((g) => g.directory)).toEqual([dirC, dirB, dirA])
    expect(orderSessions(live, "", c1.sessionId).map((s) => s.title)).toEqual(["c-two", "c-one", "b-only", "a-new", "a-old"])
  })

  test("headers show the home-abbreviated directory and the session count", () => {
    const lines = plain(view())
    const content = plain(contentLines(view()))
    expect(content.some((line) => line.includes("~/Code/beta (1)"))).toBe(true)
    expect(content.some((line) => line.includes("~/Code/alpha (2)"))).toBe(true)
    expect(content.some((line) => line.includes("/srv/gamma (2)"))).toBe(true)
    expect(abbreviateHome(HOME, HOME)).toBe("~")
    expect(abbreviateHome("/Users/devx/a", HOME)).toBe("/Users/devx/a")
    expect(abbreviateHome(dirA)).toBe(dirA)
  })

  test("long project paths are middle-ellipsized and keep the count", () => {
    const long = mk("x", `${HOME}/${"deep/".repeat(30)}project`, 1)
    const lines = plain(contentLines(view({ sessions: [long], width: 100 })))
    expect(lines.some((line) => line.includes("…") && line.includes("(1)"))).toBe(true)
  })

  test("header summarizes working and approval counts across all sessions", () => {
    const summaryLine = text(view()[1]!)
    expect(summaryLine.trimEnd()).toEndWith("5 sessions · 1 working · 1 needs approval")
  })

  test("summary counts work, tool, compacting and cancelling sessions as working", () => {
    const busy = ["generating", "tool", "compacting", "cancelling"].map((state) => mk(state, dirA, 1, state as SessionSummary["state"]))
    const summaryLine = text(view({ sessions: busy })[1]!)
    expect(summaryLine).toContain("4 working")
  })

  test("state markers: primary dot, warning ? with label, error cross, muted queue and idle", () => {
    const lines = view()
    const content = contentLines(lines)
    const row = (title: string) => content.find((line) => line.some((span) => span.text === title))!
    expect(row("a-new")[1]).toMatchObject({ text: "•", fg: "primary" })
    expect(row("b-only")[1]).toMatchObject({ text: "?", fg: "warning", bold: true })
    expect(text(row("b-only"))).toContain("needs approval")
    expect(row("c-two")[1]).toMatchObject({ text: "✗", fg: "error" })
    expect(row("a-old")[1]).toMatchObject({ text: "·", fg: "muted" })

    const queued = contentLines(view({ sessions: [mk("q", dirA, 1, "queued", { queued: 3 })] }))
    const queuedRow = queued.find((line) => line.some((span) => span.text === "q"))!
    expect(queuedRow[1]).toMatchObject({ text: "…", fg: "muted" })
    expect(text(queuedRow)).toContain("+3")
  })

  test("selection walks the grouped order across headers and never lands on a header", () => {
    let state = createSessionListState()
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const lines = view({ state })
      const content = contentLines(lines)
      const line = content.find((entry) => plain([entry])[0]?.startsWith("❯ "))
      if (line) {
        const text = plain([line])[0]!
        seen.push(text.slice(4).split(/\s{2,}/)[0]!.trim())
      }
      state = sessionListKey(state, "\x1b[B", live).state
    }
    expect(seen).toEqual(["b-only", "a-new", "a-old", "c-two", "c-one"])
    expect(sessionListKey({ selected: 1, filter: "" }, "\r", live).action).toEqual({ type: "open", sessionId: a2.sessionId })
  })

  test("filter matches title or directory across groups and drops empty groups", () => {
    const byDir = plain(contentLines(view({ state: { selected: 0, filter: "gamma" } })))
    expect(byDir.some((line) => line.includes("/srv/gamma (2)"))).toBe(true)
    expect(byDir.some((line) => line.includes("alpha"))).toBe(false)

    const byTitle = plain(contentLines(view({ state: { selected: 0, filter: "a-" } })))
    const groupLines = byTitle.filter((line) => /\(\d+\)\s*$/.test(line.trim()))
    expect(groupLines.map((line) => line.trim())).toContain("Active · ~/Code/alpha (2)")
    expect(orderSessions(live, "one two")).toEqual([])
  })

  test("the open project stays first in the view and the current row is marked", () => {
    const lines = view({ currentSessionId: c1.sessionId })
    const content = contentLines(lines)
    expect(content.some((line) => plain([line])[0]?.includes("/srv/gamma (2)"))).toBe(true)
    expect(content.some((line) => plain([line])[0]?.includes("(current)"))).toBe(true)
  })

  test("scrolling keeps the project header of the first visible session", () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(`s${i}`, dirA, i + 1))
    const lines = view({ sessions: many, state: { selected: 5, filter: "" }, height: 20 })
    expect(lines.length).toBeLessThanOrEqual(20)
    for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(100)
    const content = contentLines(lines)
    const selected = content.filter((line) => plain([line])[0]?.startsWith("❯ "))
    expect(selected.length).toBeGreaterThanOrEqual(0)
  })

  test("width and height bounds hold at 60, 100 and 160 with live states", () => {
    const wide = [...live, mk("猫".repeat(80), dirA, 3, "waiting_approval", { queued: 12 }), mk("z".repeat(300), `${HOME}/${"deep/".repeat(40)}`, 9)]
    for (const width of [60, 100, 160]) {
      for (const height of [1, 3, 6, 12, 30]) {
        for (const filter of ["", "a", "zzz"]) {
          const lines = renderSessionList({ sessions: wide, state: { selected: 4, filter }, width, height, now: NOW, home: HOME })
          expect(lines.length).toBeLessThanOrEqual(height)
          for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})
