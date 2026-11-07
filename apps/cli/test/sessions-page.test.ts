import { afterEach, describe, expect, test } from "bun:test"
import type { SessionSummary } from "@mendcode/protocol"
import { createSessionListState, filterSessions, type SessionListState } from "../src/view/session-list"
import { findTerm, SESSION_PAGE } from "../src/view/session-query"
import { folderEntries, renderSessionList, SEARCH_PLACEHOLDER, sessionListKey, sessionsHints } from "../src/view/sessions-page"
import type { Line } from "../src/ui/theme"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const DIRS = ["/Users/dev/Code/MendCodeV2", "/Users/dev/Code/kontrolog", "/Users/dev/Notes/Obsidian", "/Users/dev/Code/solar-hmi"]
const make = (over: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: ids("session"), title: "task", directory: DIRS[0]!, createdAt: NOW, updatedAt: NOW, lastSeq: 1, state: "idle", queued: 0, ...over })
const many = Array.from({ length: 60 }, (_, i) => make({ title: `session number ${i}`, directory: DIRS[i % DIRS.length]!, updatedAt: NOW - i * 60_000 }))
const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
const press = (state: SessionListState, keys: string[], sessions = many) => keys.reduce((current, key) => sessionListKey(current, key, sessions).state, state)
const draw = (state: SessionListState, sessions = many, size = { width: 160, height: 45 }) => plain(renderSessionList({ sessions, state, home: "/Users/dev", now: NOW, ...size }))

describe("/sessions header and search row", () => {
  test("the header keeps a few keys and ? lists every one", () => {
    const rows = draw(createSessionListState())
    expect(rows[0]).toMatch(/^Sessions\s+enter open · \/ search · tab folder · \? keys · esc back$/)
    expect(rows.join("\n")).not.toContain("^A")
    const keys = draw(press(createSessionListState(), ["?"])).join("\n")
    for (const key of ["^A", "settle, restore", "^B", "pin", "^L", "this folder, all", "tab", "pick a folder", "home end"]) expect(keys).toContain(key)
    expect(sessionsHints({ selected: 0, filter: "x" })).toEndWith("esc clear")
  })

  test("row two is the scope toggle and only counters that are not zero", () => {
    const working = [...many.slice(0, 3), make({ state: "generating" })]
    const row = draw(createSessionListState(DIRS[0]), working)[1]!
    expect(row).toMatch(/^● this folder {3}· all projects {2}\^L/)
    expect(row).toContain("1 working")
    expect(row).not.toMatch(/approval|unarchived|0 /)
  })

  test("a visible search row with a placeholder; typing fills it and / never doubles", () => {
    expect(draw(createSessionListState()).some((line) => line.includes(`/ ▏${SEARCH_PLACEHOLDER}`))).toBe(true)
    const slash = sessionListKey(createSessionListState(), "/", many)
    expect(slash.state.filter).toBe("")
    expect(slash.action).toEqual({ type: "none" })
    const typed = press(createSessionListState(), [..."/glass"])
    expect(typed.filter).toBe("glass")
    const rows = draw(typed).join("\n")
    expect(rows).toContain("/ glass▏")
    expect(rows).not.toContain("/ /")
    // A pasted "/path" loses only the leading slash; a slash inside a path is kept.
    expect(press(createSessionListState(), ["/Code/kontrolog"]).filter).toBe("Code/kontrolog")
  })

  test("? types into a query that has started, and esc clears the query before it closes", () => {
    const state = press(createSessionListState(), ["a", "?"])
    expect(state.filter).toBe("a?")
    expect(state.keys).toBeUndefined()
    expect(sessionListKey(state, "\x1b", many).state.filter).toBe("")
  })
})

describe("/sessions search matches title, folder and id", () => {
  test("a full or a short id finds its session", () => {
    const target = many[41]!
    expect(filterSessions(many, target.sessionId).map((session) => session.sessionId)).toEqual([target.sessionId])
    expect(filterSessions(many, target.sessionId.slice(0, 16).toLowerCase())).toContainEqual(target)
  })

  test("a folder path matches its sessions", () => {
    expect(filterSessions(many, "notes/obsidian").every((session) => session.directory === DIRS[2])).toBe(true)
    expect(filterSessions(many, "notes/obsidian")).toHaveLength(15)
  })

  test("the daemon is asked for the longest plain word, never for a regular expression", () => {
    expect(findTerm("tema glassmorphism")).toBe("glassmorphism")
    expect(findTerm("re:gla+ss")).toBeUndefined()
    expect(findTerm("tag:x")).toBeUndefined()
  })
})

describe("/sessions finds sessions past the loaded page", () => {
  const page = Array.from({ length: SESSION_PAGE }, (_, i) => make({ title: `recent ${i}`, updatedAt: NOW - i }))
  const older = make({ title: "Tema glassmorphism con colores mejorados para Obsidian", directory: DIRS[2]!, updatedAt: NOW - 90 * 86_400_000 })

  test("typing asks the daemon (bounded) and lists what it found under its folder", async () => {
    const h = appHarness({ dataDir: tempDir(), reply: (command) => {
      if (command.type !== "session.list") return undefined
      const find = (command as { find?: string }).find
      return { ok: true, result: { sessions: find ? [older].filter((session) => session.title.toLowerCase().includes(find)) : page } }
    } })
    h.app.applySettings({ onboarded: true })
    await h.type("/sessions\r")
    expect(h.text().join("\n")).not.toContain("glassmorphism")
    await h.type("glass")
    const asked = h.sentOf("session.list").at(-1) as { find?: string; limit?: number }
    expect(asked.find).toBe("glass")
    expect(asked.limit).toBeLessThanOrEqual(50)
    const screen = h.text().join("\n")
    expect(screen).toContain("Tema glassmorphism")
    expect(screen).toContain("Obsidian (1)")
  })

  test("a page that holds every session does not ask the daemon", async () => {
    const few = page.slice(0, 5)
    const h = appHarness({ dataDir: tempDir(), reply: (command) => (command.type === "session.list" ? { ok: true, result: { sessions: few } } : undefined) })
    h.app.applySettings({ onboarded: true })
    await h.type("/sessions\r")
    const before = h.sentOf("session.list").length
    await h.type("recent")
    expect(h.sentOf("session.list")).toHaveLength(before)
  })
})

describe("/sessions scrolling", () => {
  test("End and repeated ↓ reach the last session with its row on screen, at every size", () => {
    for (const [width, height] of [[160, 45], [100, 30], [80, 24], [60, 20]] as const) {
      for (const keys of [["\x1b[F"], Array.from({ length: 80 }, () => "\x1b[B"), ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~"]]) {
        const state = press(createSessionListState(), keys)
        const rows = draw(state, many, { width, height })
        expect(rows).toHaveLength(height)
        const selected = rows.filter((row) => row.includes("❯ "))
        expect(selected).toHaveLength(1)
        // The last of the grouped order: the oldest session of the last folder.
        expect(selected[0]).toContain("session number 59")
      }
    }
    expect(press(createSessionListState(), ["\x1b[F", "\x1b[H"]).selected).toBe(0)
  })

  test("the selection stays on its session when a push reorders the list", () => {
    const state = press(createSessionListState(), Array.from({ length: 20 }, () => "\x1b[B"))
    const chosen = state.selectedId!
    // Another terminal works in the oldest session: it moves to the top of a folder that moves first.
    const pushed = many.map((session) => (session.sessionId === many[59]!.sessionId ? { ...session, updatedAt: NOW + 10_000, state: "generating" as const } : session))
    const rows = draw(state, pushed)
    const title = many.find((session) => session.sessionId === chosen)!.title
    expect(rows.find((row) => row.includes("❯ "))).toContain(title)
    expect(sessionListKey(state, "\r", pushed).action).toEqual({ type: "open", sessionId: chosen })
  })
})

describe("/sessions folder picker", () => {
  test("Tab lists the folders present, typing filters them, Enter shows only that folder", () => {
    const opened = sessionListKey(createSessionListState(), "\t", many)
    expect(opened.state.folders).toEqual({ query: "", selected: 0 })
    expect(folderEntries(many, opened.state).map((entry) => entry.directory)).toEqual([undefined, ...DIRS])
    const picker = draw(opened.state).join("\n")
    expect(picker).toContain("Pick a folder")
    expect(picker).toContain("All folders")
    expect(picker).toContain("~/Code/kontrolog")
    const typed = press(opened.state, [..."kontro"])
    expect(folderEntries(many, typed).map((entry) => entry.directory)).toEqual([DIRS[1]])
    const picked = sessionListKey(typed, "\r", many)
    expect(picked.action).toEqual({ type: "reload" })
    expect(picked.state).toMatchObject({ scope: "project", directory: DIRS[1] })
    expect(picked.state.folders).toBeUndefined()
    const rows = draw(picked.state)
    expect(rows[1]).toMatch(/^● ~\/Code\/kontrolog/)
    expect(rows.join("\n")).not.toContain("~/Code/solar-hmi (")
  })

  test("from a folder's list the picker asks for every project's and Esc goes back to the folder", () => {
    const start = createSessionListState(DIRS[0])
    const opened = sessionListKey(start, "\t", many)
    expect(opened.action).toEqual({ type: "reload" })
    expect(opened.state.scope).toBe("all")
    const back = sessionListKey(opened.state, "\x1b", many)
    expect(back.action).toEqual({ type: "reload" })
    expect(back.state).toMatchObject({ scope: "project", directory: DIRS[0] })
    expect(back.state.folders).toBeUndefined()
  })
})
