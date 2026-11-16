import { describe, expect, test } from "bun:test"
import type { BotListReport } from "@mendcode/protocol"
import { glyphSet } from "../src/ui/theme"
import { ICON_SIDEBAR_WIDTH, SIDEBAR_WIDTH, sidebarKind } from "../src/view/sidebar"
import { multiStops, renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import { textWidth } from "../src/view/wrap"
import { plain } from "./session-ui-harness"

const NOW = new Date(2026, 10, 15, 15, 0).getTime()
const MINUTE = 60_000
const session = (sessionId: string, title: string, directory: string, over: Record<string, unknown> = {}) => ({ sessionId, title, directory, state: "idle", queued: 0, updatedAt: NOW - MINUTE, ...over })
const sessions = [
  session("s1", "Chrome", "/work/app"),
  session("s2", "Client reconnect", "/work/app", { state: "generating", updatedAt: NOW - 10 * MINUTE }),
  session("s3", "Other project", "/other/api", { state: "waiting_approval" }),
  session("s4", "Docs pass", "/other/api", { updatedAt: NOW - 3 * 60 * MINUTE }),
  session("s5", "Marketing", "/work/site"),
]
const bots: BotListReport = {
  bots: [
    { name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, file: "/d/calm.md", state: "working", projects: [{ directory: "/work/app", state: "working", sessions: [{ sessionId: "s1" as never, title: "Chrome", status: "running", updatedAt: NOW }] }] },
    { name: "scout", description: "", identity: { origin: "mendcode" }, file: "/d/scout.md", state: "idle", projects: [] },
    { name: "hermes-1", description: "", identity: { shape: "square", color: "info", origin: "hermes" }, file: "/d/h.md", state: "waiting", projects: [] },
    { name: "oops", description: "", identity: { shape: "triangle", color: "error", origin: "mendcode" }, file: "/d/o.md", state: "problem", projects: [] },
  ],
  external: [],
  problems: [],
}
const base: MultiInput = { sessions: sessions as never, current: "s1", directory: "/work/app", focused: false, height: 30, now: NOW, bots, sections: ["projects", "bots", "sessions"], scope: "all", icons: false, open: new Map(), glyphs: glyphSet("unicode") }
const draw = (over: Partial<MultiInput> = {}) => renderMultiSidebar({ ...base, ...over })
const text = (over: Partial<MultiInput> = {}) => draw(over).rows.map(plain)

describe("the sidebar's size", () => {
  test("sidebarKind: the full list from wide, icons from normal only with bots on, never when hidden or minimal", () => {
    const kind = (width: number, over: Partial<Parameters<typeof sidebarKind>[0]> = {}) => sidebarKind({ mode: "auto", width, minimal: false, bots: false, iconsOnly: false, ...over })
    expect(kind(120)).toBe("full")
    expect(kind(109)).toBe("none")
    expect(kind(80)).toBe("none")
    expect(kind(120, { bots: true })).toBe("full")
    expect(kind(109, { bots: true })).toBe("icons")
    expect(kind(70, { bots: true })).toBe("icons")
    expect(kind(69, { bots: true })).toBe("none")
    expect(kind(120, { bots: true, iconsOnly: true })).toBe("icons")
    expect(kind(120, { mode: "hidden", bots: true })).toBe("none")
    expect(kind(120, { minimal: true, bots: true })).toBe("none")
    expect(ICON_SIDEBAR_WIDTH).toBeLessThan(SIDEBAR_WIDTH)
  })
})

describe("the bots section", () => {
  test("a row per bot: icon, name, origin, and the state as a symbol and a word", () => {
    const rows = text()
    const calm = rows.find((row) => row.includes("calm"))!
    expect(calm).toMatch(/^ {3}● calm +mendcode +● working │$/)
    expect(rows.find((row) => row.includes("scout"))).toMatch(/◌ idle │$/)
    expect(rows.find((row) => row.includes("hermes-1"))).toMatch(/hermes +… waiting │$/)
    expect(rows.find((row) => row.includes("oops"))).toMatch(/▲ oops +mendcode +! problem │$/)
    for (const row of rows) expect(textWidth(row)).toBe(SIDEBAR_WIDTH)
  })

  test("the icon takes its theme role, the state never depends on color alone, and ASCII drops every unicode cell", () => {
    const line = draw().rows.find((row) => plain(row).includes("calm"))!
    expect(line.find((span) => span.text === "● ")?.fg).toBe("success")
    expect(line.find((span) => span.text === "● working")?.fg ?? line.find((span) => span.text.includes("working"))?.fg).toBe("primary")
    const ascii = text({ ascii: true, glyphs: glyphSet("ascii") })
    const row = ascii.find((line) => line.includes("calm"))!
    expect(row).toMatch(/\(\) calm +mendcode +\* working │$/)
    expect(ascii.find((line) => line.includes("hermes-1"))).toMatch(/\[\] hermes-1/)
    for (const line of ascii.filter((line) => /calm|scout|hermes|oops/.test(line))) expect(line).toMatch(/^[\x20-\x7e│]*$/)
  })

  test("a bot without a shape or color still gets one, the same each time", () => {
    const first = text().find((row) => row.includes("scout"))!
    expect(text().find((row) => row.includes("scout"))).toBe(first)
    expect(first).toMatch(/^ {3}[●■◆▲⬢] scout/)
  })

  test("no bots says how to make one", () => {
    expect(text({ bots: { bots: [], external: [], problems: [] }, sections: ["bots"] }).join("\n")).toContain("No bots · /bot new")
  })
})

describe("projects", () => {
  test("all projects by latest activity (the opened one at its rank), every group open", () => {
    const rows = text()
    const at = (needle: string) => rows.findIndex((row) => row.includes(needle))
    expect(at("▾ app")).toBeGreaterThan(-1)
    // Chrome is a chat of the bot calm: it lives under the bot, not in the group or its count.
    expect(rows[at("▾ app")]).toMatch(/▾ app +1 │$/)
    expect(at("Client reconnect")).toBeGreaterThan(at("▾ app"))
    expect(rows[at("▾ api")]).toMatch(/▾ api +2 │$/)
    expect(rows[at("▾ site")]).toMatch(/▾ site +1 │$/)
    expect(at("Other project")).toBeGreaterThan(at("▾ api"))
    // app's own latest message is 10 minutes old (Chrome is the bot's), so app ranks after api and site.
    expect(at("▾ app")).toBeGreaterThan(at("▾ site"))
    expect(at("▾ site")).toBeGreaterThan(at("▾ api"))
  })

  test("a group folded by choice shows its active count, and opens again", () => {
    const rows = text({ open: new Map([["/other/api", false], ["/work/app", false]]) })
    expect(rows.find((row) => row.includes("▸ api"))).toMatch(/▸ api +1 active │$/)
    expect(rows.some((row) => row.includes("Other project"))).toBe(false)
    expect(rows.some((row) => row.includes("▸ app"))).toBe(true)
    expect(rows.some((row) => row.includes("Client reconnect"))).toBe(false)
    expect(text({ open: new Map([["/other/api", true]]) }).some((row) => row.includes("Other project"))).toBe(true)
  })

  test("the opened folder only, as today's list under one group", () => {
    const rows = text({ scope: "folder" })
    expect(rows.some((row) => row.includes("▾ app"))).toBe(true)
    expect(rows.some((row) => row.includes("api") || row.includes("site"))).toBe(false)
  })

  test("a bot's chats are not in the project lists or their counts; they live under the bot", () => {
    const rows = text()
    const groups = rows.slice(rows.findIndex((row) => row.includes("▾ app")), rows.findIndex((row) => row.includes("calm")))
    expect(groups.some((row) => row.includes("Chrome"))).toBe(false)
    expect(rows.find((row) => row.includes("▾ app"))).toMatch(/▾ app +1 │$/)
    expect(rows.find((row) => row.includes("Client reconnect"))).toMatch(/ {2}Client reconnect/)
    // A session whose own `agent` names a bot is left out the same way, even when the report does not list it yet.
    const named = text({ sessions: [...sessions, session("s6", "Agent named", "/work/app", { agent: "scout" })] as never, current: "s6" })
    expect(named.find((row) => row.includes("▾ app"))).toMatch(/▾ app +1 │$/)
    expect(named.some((row) => row.includes("Agent named"))).toBe(true)
  })

  test("a bot's chats fold under a row of their own, every folder, newest first, a preview of three and a more row", () => {
    const many: BotListReport = { ...bots, bots: [{ ...bots.bots[0]!, projects: [
      { directory: "/work/app", state: "idle", sessions: [1, 2, 3].map((n) => ({ sessionId: `a${n}` as never, title: `App chat ${n}`, status: "idle", updatedAt: NOW - n * MINUTE })) },
      { directory: "/other/api", state: "idle", sessions: [4, 5].map((n) => ({ sessionId: `b${n}` as never, title: `Api chat ${n}`, status: "idle", updatedAt: NOW - n * MINUTE })) },
    ] }, ...bots.bots.slice(1)] }
    const closed = text({ bots: many, current: "s2" })
    expect(closed.find((row) => row.includes("chats"))).toMatch(/^ {3} {2}▸ chats +5 │$/)
    expect(closed.some((row) => row.includes("App chat"))).toBe(false)
    const opened = text({ bots: many, current: "s2", open: new Map([["bot:calm", true]]) })
    const chats = opened.filter((row) => /(App|Api) chat/.test(row)).map((row) => row.replace(/^ +· /, "").replace(/ +\d+m │$/, ""))
    expect(chats).toEqual(["App chat 1", "App chat 2", "App chat 3"])
    expect(opened.find((row) => row.includes("▾ chats"))).toBeDefined()
    expect(opened.find((row) => row.includes("+ 2 more"))).toBeDefined()
    expect(multiStops({ ...base, bots: many, current: "s2", open: new Map([["bot:calm", true]]) })).toContain("botmore:calm")
    const whole = text({ bots: many, current: "s2", open: new Map([["bot:calm", true]]), expanded: new Set(["bot:calm"]) })
    expect(whole.filter((row) => /(App|Api) chat/.test(row))).toHaveLength(5)
    expect(whole.some((row) => row.includes("show less"))).toBe(true)
    // The chat that is open opens its bot's chats by default; a fold by hand wins.
    expect(text({ bots: many, current: "a1" }).some((row) => row.includes("App chat 1"))).toBe(true)
    expect(text({ bots: many, current: "a1", open: new Map([["bot:calm", false]]) }).some((row) => row.includes("App chat 1"))).toBe(false)
  })

  test("a folded bot with a working chat says how many are active", () => {
    const busy = { ...bots, bots: [{ ...bots.bots[0]!, projects: [{ directory: "/work/app", state: "working" as const, sessions: [{ sessionId: "s2" as never, title: "Client reconnect", status: "running", updatedAt: NOW }] }] }, ...bots.bots.slice(1)] }
    expect(text({ bots: busy, current: "s5" }).find((row) => row.includes("chats"))).toMatch(/▸ chats +1 active │$/)
  })

  test("sessions without a bot are their own section when projects is not shown", () => {
    const only = text({ sections: ["sessions"] })
    expect(only.some((row) => row.includes("Client reconnect"))).toBe(true)
    expect(only.some((row) => row.includes("Chrome"))).toBe(false)
    expect(only.some((row) => row.includes("Other project"))).toBe(false)
  })

  test("order follows the sections list; scratch shows how to add one", () => {
    const rows = text({ sections: ["bots", "projects"] })
    expect(rows.findIndex((row) => row.includes("calm"))).toBeLessThan(rows.findIndex((row) => row.includes("▾ app")))
    const empty = text({ sections: [] }).join("\n")
    expect(empty).toContain("Nothing shown")
    expect(empty).toContain("/customize")
  })

  test("without bots on there is no bots section and no icon column", () => {
    const rows = text({ bots: undefined, sections: ["projects", "sessions"] })
    expect(rows.some((row) => row.includes("calm"))).toBe(false)
    expect(rows.find((row) => row.includes("Chrome"))).toMatch(/^ ▌ +· Chrome/)
  })
})

describe("a project previews a few sessions", () => {
  /** `count` titled sessions of one folder, newest first (the title carries the rank). */
  const many = (count: number, over: (index: number) => Record<string, unknown> = () => ({})) => Array.from({ length: count }, (_, index) => session(`m${index}`, `Task ${index}`, "/work/app", { updatedAt: NOW - (index + 1) * MINUTE, lastSeq: 9, ...over(index) }))
  const tall = (over: Partial<MultiInput> = {}) => text({ sessions: many(75) as never, current: "m0", height: 40, sections: ["projects"], ...over })
  const taskRows = (rows: string[]) => rows.filter((row) => /Task \d+/.test(row))

  test("75 sessions draw 5 and a row that counts the 70 hidden ones", () => {
    const rows = tall()
    expect(taskRows(rows)).toHaveLength(5)
    expect(rows.some((row) => /^ {3}\s+\+ 70 more\s*│$/.test(row))).toBe(true)
    expect(rows.find((row) => row.includes("▾ app"))).toMatch(/75 │$/)
    for (const row of rows) expect(textWidth(row)).toBe(SIDEBAR_WIDTH)
  })

  test("a project with no more than the limit has no extra row", () => {
    const rows = tall({ sessions: many(5) as never })
    expect(taskRows(rows)).toHaveLength(5)
    expect(rows.some((row) => /more|show less/.test(row))).toBe(false)
  })

  test("the preview count is honored", () => {
    expect(taskRows(tall({ previewCount: 2 }))).toHaveLength(2)
    expect(tall({ previewCount: 2 }).some((row) => row.includes("+ 73 more"))).toBe(true)
    expect(taskRows(tall({ previewCount: 20 }))).toHaveLength(20)
  })

  test("the current session stays visible past the limit, once, in its place", () => {
    const rows = tall({ current: "m40" })
    const tasks = taskRows(rows)
    expect(tasks).toHaveLength(6)
    expect(tasks.filter((row) => row.includes("Task 40 "))).toHaveLength(1)
    expect(tasks.at(-1)).toContain("Task 40")
    expect(rows.some((row) => row.includes("+ 69 more"))).toBe(true)
    // A current session already inside the preview is not drawn twice.
    expect(taskRows(tall({ current: "m2" }))).toHaveLength(5)
  })

  test("working and waiting sessions stay visible past the limit", () => {
    const rows = tall({ sessions: many(75, (index) => index === 30 ? { state: "generating" } : index === 50 ? { state: "waiting_approval" } : {}) as never })
    const tasks = taskRows(rows)
    expect(tasks).toHaveLength(7)
    expect(tasks.some((row) => row.includes("Task 30"))).toBe(true)
    expect(tasks.some((row) => row.includes("Task 50"))).toBe(true)
    expect(rows.some((row) => row.includes("+ 68 more"))).toBe(true)
  })

  test("the more row is a stop and a hit; expanding lists everything and the row becomes show less", () => {
    const input = { ...base, sessions: many(75) as never, current: "m0", height: 120, sections: ["projects"] as MultiInput["sections"] }
    expect(multiStops(input)).toEqual(["group:/work/app", "m0", "m1", "m2", "m3", "m4", "more:/work/app"])
    const out = renderMultiSidebar(input)
    const hit = out.hits.find((candidate) => candidate.id === "more:/work/app")!
    expect(plain(out.rows[hit.row]!)).toContain("+ 70 more")
    const open = { ...input, expanded: new Set(["/work/app"]) }
    expect(multiStops(open)).toHaveLength(77)
    expect(multiStops(open).at(-1)).toBe("more:/work/app")
    const rows = renderMultiSidebar(open).rows.map(plain)
    expect(taskRows(rows)).toHaveLength(75)
    expect(rows.some((row) => row.includes("show less"))).toBe(true)
    expect(rows.some((row) => row.includes("more"))).toBe(false)
  })

  test("a short list that was expanded and shrank again shows no show less", () => {
    const rows = tall({ sessions: many(3) as never, expanded: new Set(["/work/app"]) })
    expect(rows.some((row) => /more|show less/.test(row))).toBe(false)
  })

  test("the order stays: pinned first, then the latest activity", () => {
    const rows = tall({ sessions: many(75, (index) => index === 60 ? { lifecycle: { pinnedAt: NOW } } : {}) as never })
    const tasks = taskRows(rows)
    expect(tasks[0]).toContain("Task 60")
    expect(tasks[1]).toContain("Task 0 ")
  })

  test("the opened project previews the setting, the others at most three, and a folded group stays folded", () => {
    const other = Array.from({ length: 9 }, (_, index) => session(`o${index}`, `Elsewhere ${index}`, "/other/api", { lastSeq: 9 }))
    const rows = text({ sessions: [...many(9), ...other] as never, current: "m0", height: 60, sections: ["projects"] })
    expect(rows.filter((row) => /Elsewhere \d/.test(row))).toHaveLength(3)
    expect(rows.filter((row) => row.includes("+ 4 more"))).toHaveLength(1)
    expect(rows.filter((row) => row.includes("+ 6 more"))).toHaveLength(1)
    const folded = text({ sessions: [...many(9), ...other] as never, current: "m0", height: 60, sections: ["projects"], open: new Map([["/other/api", false]]) })
    expect(folded.some((row) => /Elsewhere/.test(row))).toBe(false)
  })
})

describe("sessions nobody used stay out of the sidebar", () => {
  const blank = (id: string, over: Record<string, unknown> = {}) => session(id, "", "/work/app", { lastSeq: 2, ...over })
  const rows = (list: unknown[], over: Partial<MultiInput> = {}) => text({ sessions: [session("t1", "Real work", "/work/app", { lastSeq: 14 }), ...list] as never, current: "t1", height: 40, sections: ["projects"], ...over })

  test("an untitled session that never got past its first events is not listed or counted", () => {
    const out = rows([blank("e1"), blank("e2")])
    expect(out.some((row) => row.includes("Untitled session"))).toBe(false)
    expect(out.find((row) => row.includes("▾ app"))).toMatch(/1 │$/)
    expect(multiStops({ ...base, sessions: [session("t1", "Real work", "/work/app", { lastSeq: 14 }), blank("e1")] as never, current: "t1", sections: ["projects"] })).toEqual(["group:/work/app", "t1"])
  })

  test("the current one is kept even when it is empty", () => {
    const out = rows([blank("e1")], { current: "e1" })
    expect(out.filter((row) => row.includes("Untitled session"))).toHaveLength(1)
  })

  test("an untitled session that did something stays: it works, waits, has a draft or messages queued, or has more events", () => {
    const out = rows([blank("w", { state: "generating" }), blank("q", { queued: 2 }), blank("d", { draft: { preview: "hello there", chars: 11, attachments: 0, images: 0, updatedAt: NOW } }), blank("u", { lastSeq: 23 })])
    expect(out.filter((row) => row.includes("Untitled session") || row.includes("hello there") || row.includes("Draft"))).toHaveLength(4)
  })

  test("a titled session with few events stays", () => {
    expect(rows([session("n1", "Hello", "/work/app", { lastSeq: 2 })]).some((row) => row.includes("Hello"))).toBe(true)
  })

  test("a session opened here today that has taken part since stays, even when its pushed summary says it is empty", () => {
    const pushed = (updatedAt: number) => session("p1", "", "/work/app", { lastSeq: 0, updatedAt })
    const visits = (updatedAt: number, at = NOW - 60 * MINUTE) => new Map([["p1", { at, updatedAt }]])
    // Opened and left alone: still hidden. Used after it was opened: shown. Opened more than a day ago: the rule is back.
    expect(rows([pushed(NOW - 90 * MINUTE)], { visits: visits(NOW - 90 * MINUTE) }).some((row) => row.includes("Untitled session"))).toBe(false)
    expect(rows([pushed(NOW - 5 * MINUTE)], { visits: visits(NOW - 90 * MINUTE) }).some((row) => row.includes("Untitled session"))).toBe(true)
    expect(rows([pushed(NOW - 5 * MINUTE)], { visits: visits(NOW - 90 * MINUTE, NOW - 25 * 60 * MINUTE) }).some((row) => row.includes("Untitled session"))).toBe(false)
    expect(rows([pushed(NOW - 5 * MINUTE)]).some((row) => row.includes("Untitled session"))).toBe(false)
  })
})

describe("a folder used today stays listed after the opened folder moves on", () => {
  // The owner's sequence: MendCode opened in a new folder X (no git root), a chat there, then a switch to a session in another folder.
  const x = session("x1", "Notes in X", "/new/x", { updatedAt: NOW - 20 * MINUTE })
  const probe = { isProject: (directory: string) => directory !== "/new/x", eligible: () => true, count: 1 }
  test("X and its chat are still shown with a cap of one project, and at the re-rank after the switch", () => {
    const after = text({ sessions: [...sessions, x] as never, current: "s1", directory: "/work/app", sections: ["projects"], projects: probe })
    expect(after.some((row) => row.includes("▾ x"))).toBe(true)
    expect(after.some((row) => row.includes("Notes in X"))).toBe(true)
    // Without the day's grace (the old rule) the folder is gone from the list but for the chat's own /sessions page.
    const old = text({ sessions: [...sessions, x] as never, current: "s1", directory: "/work/app", sections: ["projects"], projects: { isProject: probe.isProject, count: 1 } })
    expect(old.some((row) => row.includes("Notes in X"))).toBe(false)
  })
})

describe("the icon and one space", () => {
  const picture = { capability: { images: true } as never, slot: "bot-icon", stateOf: (() => "sleeping") as never, make: (({ row, col }: { row: number; col: number }) => ({ slot: "p", key: `${row}:${col}`, image: {} as never, row, col, cols: 2, rows: 1 })) as never }
  test("a picture is its two cells and exactly one space, the text column the same on every row", () => {
    const rows = text({ faces: picture, bots: { ...bots, bots: [{ ...bots.bots[0]!, projects: [{ directory: "/work/app", state: "idle", sessions: [{ sessionId: "s2" as never, title: "Client reconnect", status: "idle", updatedAt: NOW }] }] }, ...bots.bots.slice(1)] }, current: "s2" })
    expect(rows.find((row) => row.includes("calm"))).toMatch(/^ {3} {3}calm/)
    expect(rows.find((row) => row.includes("scout"))).toMatch(/^ {3} {3}scout/)
    const chat = rows.find((row) => row.includes("Client reconnect"))!
    // lead (3 cells), the 4-space indent, the mark, then the title in the column every chat row uses
    expect(chat).toMatch(/^ ▌ {5}[·•] Client reconnect/)
  })
  test("a glyph is its cell and one space", () => {
    expect(text().find((row) => row.includes("calm"))).toMatch(/^ {3}● calm/)
    expect(text({ ascii: true, glyphs: glyphSet("ascii") }).find((row) => row.includes("calm"))).toMatch(/^ {3}\(\) calm/)
  })
})

describe("keyboard stops and mouse hits agree with what is drawn", () => {
  test("stops run in drawing order: bots, groups and their visible sessions, never a hidden one", () => {
    expect(multiStops(base)).toEqual(["group:/other/api", "s3", "s4", "group:/work/site", "s5", "group:/work/app", "s2", "bot:calm", "botchats:calm", "s1", "bot:scout", "bot:hermes-1", "bot:oops"])
    expect(multiStops({ ...base, sections: ["bots", "projects"], open: new Map([["/other/api", false]]) })).toEqual(["bot:calm", "botchats:calm", "s1", "bot:scout", "bot:hermes-1", "bot:oops", "group:/other/api", "group:/work/site", "s5", "group:/work/app", "s2"])
  })

  test("each hit names a stop on the row that draws it", () => {
    const out = draw()
    for (const hit of out.hits) {
      expect(multiStops(base)).toContain(hit.id)
      expect(plain(out.rows[hit.row]!)).not.toBe("")
    }
    expect(out.hits.map((hit) => hit.id)).toEqual(multiStops(base))
    const calm = out.hits.find((hit) => hit.id === "bot:calm")!
    expect(plain(out.rows[calm.row]!)).toContain("calm")
  })

  test("the selected row has the fill and the margin mark only while focused", () => {
    const row = (over: Partial<MultiInput>) => draw(over).rows.find((line) => plain(line).includes("scout"))!
    expect(row({ focused: true, selected: "bot:scout" }).every((span) => span.bg === "element" || span.text === "│")).toBe(true)
    expect(plain(row({ focused: true, selected: "bot:scout" }))).toMatch(/^ › /)
    expect(row({ focused: false, selected: "bot:scout" }).some((span) => span.bg === "element")).toBe(false)
  })
})

describe("icons only", () => {
  test("a narrow column: an icon and a state symbol per bot, a symbol per session, and the name of the selected one", () => {
    const out = draw({ icons: true, height: 20 })
    for (const row of out.rows) expect(textWidth(plain(row))).toBe(ICON_SIDEBAR_WIDTH)
    const rows = out.rows.map(plain)
    expect(rows.some((row) => row.includes("calm"))).toBe(false)
    expect(rows.filter((row) => /[●■◆▲⬢]/.test(row)).length).toBeGreaterThanOrEqual(4)
    const selected = draw({ icons: true, height: 20, focused: true, selected: "bot:scout" }).rows.map(plain)
    expect(selected.some((row) => row.includes("scout"))).toBe(true)
  })

  test("its stops still reach every bot and the opened project's sessions", () => {
    expect(multiStops({ ...base, icons: true })).toEqual(["s2", "bot:calm", "bot:scout", "bot:hermes-1", "bot:oops"])
    expect(multiStops({ ...base, icons: true, sections: ["bots", "projects"] })).toEqual(["bot:calm", "bot:scout", "bot:hermes-1", "bot:oops", "s2"])
  })
})

describe("fit", () => {
  test("a short window keeps the selected row in view and counts what is left out", () => {
    const rows = text({ height: 8, focused: true, selected: "bot:oops" })
    expect(rows).toHaveLength(8)
    expect(rows.some((row) => row.includes("oops"))).toBe(true)
    expect(rows.at(-1)).toMatch(/more/)
  })
})
