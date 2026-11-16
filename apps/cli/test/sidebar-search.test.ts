import { describe, expect, test } from "bun:test"
import type { BotListReport } from "@mendcode/protocol"
import { buildSearchIndex, matchPositions, renderSidebarSearch, resultIds, runSearch, SEARCH_TOP, type SearchSession, type SearchSources } from "../src/view/sidebar-search"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"

const NOW = 1_800_000_000_000
const MINUTE = 60_000
let serial = 0
const session = (title: string, over: Partial<SearchSession> = {}): SearchSession => ({ sessionId: `ses_${++serial}`, title, directory: "/work/app", updatedAt: NOW - serial * MINUTE, state: "idle", queued: 0, ...over })
const sources = (sessions: SearchSession[], over: Partial<SearchSources> = {}): SearchSources => ({ sessions: [sessions], home: "/home/me", tmpRoots: ["/tmp"], ...over })
const titles = (index: ReturnType<typeof buildSearchIndex>) => resultIds(index).map((id) => index.label[index.id.indexOf(id)])

describe("ranking", () => {
  test("prefix beats word start beats contiguous beats subsequence, whatever the recency", () => {
    const index = buildSearchIndex(sources([
      session("a fixed sidebar"),
      session("findings"),
      session("the fix"),
      session("prefix in the middle"),
    ]))
    runSearch(index, "fi")
    // `findings` starts with it; `a fixed sidebar` and `the fix` have it at a word start (the newer first); `prefix…` holds it inside a word.
    expect(titles(index).slice(0, 4)).toEqual(["findings", "a fixed sidebar", "the fix", "prefix in the middle"])
    runSearch(index, "fsb")
    expect(titles(index)).toEqual(["a fixed sidebar"])
  })

  test("equal matches fall back to the most recent activity", () => {
    const index = buildSearchIndex(sources([session("deploy old", { updatedAt: NOW - 90 * MINUTE }), session("deploy new", { updatedAt: NOW - MINUTE })]))
    runSearch(index, "deploy")
    expect(titles(index)).toEqual(["deploy new", "deploy old"])
  })

  test("an empty query lists everything by recency, sessions, projects and bots together", () => {
    const index = buildSearchIndex(sources([session("one", { updatedAt: NOW - 5 * MINUTE }), session("two", { updatedAt: NOW - MINUTE })]))
    runSearch(index, "")
    expect(titles(index)).toEqual(["two", "app", "one"])
  })

  test("projects match by folder name, and by path below the name; bots by name", () => {
    const report = { bots: [{ name: "scout", description: "", identity: { origin: "mendcode" }, file: "", state: "idle", projects: [] }], external: [], problems: [] } as unknown as BotListReport
    const index = buildSearchIndex(sources([session("notes", { directory: "/home/me/Code/mendcode" }), session("api work", { directory: "/srv/scout-api" })], { bots: report }))
    runSearch(index, "scout")
    // The bot's name starts with it; the folder `scout-api` too (an older activity); nothing else holds it.
    expect(resultIds(index)).toEqual(["bot:scout", "group:/srv/scout-api"])
    runSearch(index, "code/mend")
    expect(resultIds(index)).toEqual(["group:/home/me/Code/mendcode"])
  })

  test("home, hidden and temp folders are no projects; a hidden project is left out; archived sessions too", () => {
    const index = buildSearchIndex(sources([
      session("x", { directory: "/home/me" }),
      session("y", { directory: "/tmp/run-1" }),
      session("z", { directory: "/home/me/.config/thing" }),
      session("w", { directory: "/srv/gone" }),
      session("old", { directory: "/srv/kept", archivedAt: NOW }),
    ], { hidden: new Set(["/srv/gone"]) }))
    runSearch(index, "")
    expect(resultIds(index).filter((id) => id.startsWith("group:"))).toEqual([])
    expect(titles(index)).not.toContain("old")
  })

  test("typing on narrows the previous matches; deleting widens again", () => {
    const index = buildSearchIndex(sources([session("alpha"), session("alphabet"), session("beta")]))
    runSearch(index, "al")
    expect(index.hitCount).toBe(2)
    runSearch(index, "alphab")
    expect(titles(index)).toEqual(["alphabet"])
    runSearch(index, "a")
    expect(index.hitCount).toBe(4)
  })
})

describe("smart case", () => {
  test("a lowercase query ignores case; an uppercase letter makes it exact", () => {
    const index = buildSearchIndex(sources([session("Release notes"), session("release script")]))
    runSearch(index, "release")
    expect(index.hitCount).toBe(2)
    runSearch(index, "Release")
    expect(titles(index)).toEqual(["Release notes"])
    runSearch(index, "rElease")
    expect(index.hitCount).toBe(0)
  })

  test("camelCase humps are word starts", () => {
    const index = buildSearchIndex(sources([session("sidebarSearch"), session("research notes")]))
    runSearch(index, "search")
    expect(titles(index)[0]).toBe("sidebarSearch")
  })
})

describe("highlights", () => {
  test("the chars that matched, contiguous or scattered", () => {
    expect(matchPositions("Fix the sidebar", "side")).toEqual([8, 9, 10, 11])
    expect(matchPositions("Fix the sidebar", "fsb")).toEqual([0, 8, 12])
    expect(matchPositions("Fix the sidebar", "Side")).toBeUndefined()
    expect(matchPositions("Fix the sidebar", "")).toEqual([])
  })

  test("the drawn row marks matched chars in the primary role, bold and underlined", () => {
    const index = buildSearchIndex(sources([session("Fix the sidebar")]))
    runSearch(index, "side")
    const drawn = renderSidebarSearch({ index, query: "side", selected: 0, width: SIDEBAR_WIDTH, height: 12, now: NOW, current: "none" })
    const row = drawn.rows[drawn.hits[0]!.row]!
    const marked = row.filter((span) => span.fg === "primary" && span.bold && span.underline).map((span) => span.text).join("")
    expect(marked).toBe("side")
  })
})

describe("drawing", () => {
  const text = (rows: ReturnType<typeof renderSidebarSearch>["rows"]) => rows.map((row) => row.map((span) => span.text).join(""))

  test("the field on top, the matches with their kind, the selected one marked, every row the sidebar's width", () => {
    const report = { bots: [{ name: "fixer", description: "", identity: { origin: "mendcode" }, file: "", state: "working", projects: [] }], external: [], problems: [] } as unknown as BotListReport
    const index = buildSearchIndex(sources([session("Fix the sidebar", { updatedAt: NOW - 2 * MINUTE }), session("notes", { directory: "/srv/fixtures" })], { bots: report }))
    runSearch(index, "fix")
    const drawn = renderSidebarSearch({ index, query: "fix", selected: 1, width: SIDEBAR_WIDTH, height: 12, now: NOW, current: "none" })
    const rows = text(drawn.rows)
    expect(rows).toHaveLength(12)
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(SIDEBAR_WIDTH)
    expect(rows[0]).toMatch(/^ {3}\/ fix +3 │$/)
    expect(drawn.hits.map((hit) => hit.id)).toEqual(["ses_" + (serial - 1), "bot:fixer", "group:/srv/fixtures"].sort((a, b) => resultIds(index).indexOf(a) - resultIds(index).indexOf(b)))
    const selected = rows[drawn.hits[1]!.row]!
    expect(selected.startsWith(" › ")).toBe(true)
    expect(rows.some((row) => /Fix the sidebar +2m │$/.test(row))).toBe(true)
    expect(rows.some((row) => /fixtures +project │$/.test(row))).toBe(true)
    expect(rows.some((row) => /fixer +● working │$/.test(row))).toBe(true)
  })

  test("no match says so", () => {
    const index = buildSearchIndex(sources([session("alpha")]))
    runSearch(index, "zzz")
    const rows = text(renderSidebarSearch({ index, query: "zzz", selected: 0, width: SIDEBAR_WIDTH, height: 8, now: NOW, current: "none" }).rows)
    expect(rows.join("\n")).toContain("No match")
  })

  test("the window follows the selection past the sidebar's height", () => {
    const index = buildSearchIndex(sources(Array.from({ length: 40 }, (_, at) => session(`task ${at}`))))
    runSearch(index, "task")
    const drawn = renderSidebarSearch({ index, query: "task", selected: 30, width: SIDEBAR_WIDTH, height: 12, now: NOW, current: "none" })
    expect(drawn.hits.some((hit) => hit.id === resultIds(index)[30])).toBe(true)
  })

  test("at most SEARCH_TOP results are kept, the count says how many matched", () => {
    const index = buildSearchIndex(sources(Array.from({ length: SEARCH_TOP + 10 }, (_, at) => session(`job ${at}`))))
    runSearch(index, "job")
    expect(index.topCount).toBe(SEARCH_TOP)
    expect(index.hitCount).toBe(SEARCH_TOP + 10)
  })
})

describe("cost", () => {
  test("a keystroke over 2,000 sessions, 60 projects and 25 bots stays far under a frame", () => {
    const words = ["fix", "sidebar", "search", "daemon", "release", "notes", "bot", "store", "render", "keys", "lane", "test", "perf", "merge", "docs"]
    const many = Array.from({ length: 2000 }, (_, at) => session(`${words[at % 15]} ${words[(at * 7) % 15]} ${words[(at * 11) % 15]} #${at}`, { directory: `/home/me/Code/project-${at % 60}`, updatedAt: NOW - at * MINUTE }))
    const report = { bots: Array.from({ length: 25 }, (_, at) => ({ name: `bot-${at}`, description: "", identity: { origin: "mendcode" }, file: "", state: "idle", projects: [] })), external: [], problems: [] } as unknown as BotListReport
    const index = buildSearchIndex(sources(many, { bots: report }))
    const queries = ["s", "si", "sid", "side", "sideb", "sidebar", "sidebar ", "sidebar s", "sidebar se", "sidebar sea", "f", "fx", "fxs", "r", "re", "rel", "z"]
    for (const query of queries) runSearch(index, query)
    const times: number[] = []
    for (let round = 0; round < 20; round++) for (const query of queries) {
      const at = Bun.nanoseconds()
      runSearch(index, query)
      times.push(Bun.nanoseconds() - at)
    }
    times.sort((a, b) => a - b)
    // The budget is 1 ms on the owner's Mac; the ceiling leaves room for a slow CI runner.
    expect(times[Math.floor(times.length * 0.95)]! / 1e6).toBeLessThan(5)
  })
})
