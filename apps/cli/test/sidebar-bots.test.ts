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
  test("all projects: the opened one first, every group open", () => {
    const rows = text()
    const at = (needle: string) => rows.findIndex((row) => row.includes(needle))
    expect(at("▾ app")).toBeGreaterThan(-1)
    expect(at("Chrome")).toBeGreaterThan(at("▾ app"))
    expect(at("Client reconnect")).toBeGreaterThan(at("Chrome"))
    expect(rows[at("▾ api")]).toMatch(/▾ api +2 │$/)
    expect(rows[at("▾ site")]).toMatch(/▾ site +1 │$/)
    expect(at("Other project")).toBeGreaterThan(at("▾ api"))
    expect(at("▾ api")).toBeGreaterThan(at("Client reconnect"))
  })

  test("a group folded by choice shows its active count, and opens again", () => {
    const rows = text({ open: new Map([["/other/api", false], ["/work/app", false]]) })
    expect(rows.find((row) => row.includes("▸ api"))).toMatch(/▸ api +1 active │$/)
    expect(rows.some((row) => row.includes("Other project"))).toBe(false)
    expect(rows.some((row) => row.includes("▸ app"))).toBe(true)
    expect(rows.some((row) => row.includes("Chrome"))).toBe(false)
    expect(text({ open: new Map([["/other/api", true]]) }).some((row) => row.includes("Other project"))).toBe(true)
  })

  test("the opened folder only, as today's list under one group", () => {
    const rows = text({ scope: "folder" })
    expect(rows.some((row) => row.includes("▾ app"))).toBe(true)
    expect(rows.some((row) => row.includes("api") || row.includes("site"))).toBe(false)
  })

  test("a bot's session carries the bot's icon in its project list; the others keep a blank where it would be", () => {
    const rows = text()
    expect(rows.find((row) => row.includes("Chrome"))).toMatch(/● Chrome +1m │$/)
    expect(rows.find((row) => row.includes("Client reconnect"))).toMatch(/ {2}Client reconnect/)
    expect(draw().rows.find((row) => plain(row).includes("Chrome"))!.find((span) => span.text === "● " && span.fg === "success")).toBeDefined()
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
})

describe("keyboard stops and mouse hits agree with what is drawn", () => {
  test("stops run in drawing order: bots, groups and their visible sessions, never a hidden one", () => {
    expect(multiStops(base)).toEqual(["group:/work/app", "s1", "s2", "group:/other/api", "s3", "s4", "group:/work/site", "s5", "bot:calm", "bot:scout", "bot:hermes-1", "bot:oops"])
    expect(multiStops({ ...base, sections: ["bots", "projects"], open: new Map([["/other/api", false]]) })).toEqual(["bot:calm", "bot:scout", "bot:hermes-1", "bot:oops", "group:/work/app", "s1", "s2", "group:/other/api", "group:/work/site", "s5"])
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
    expect(multiStops({ ...base, icons: true })).toEqual(["s1", "s2", "bot:calm", "bot:scout", "bot:hermes-1", "bot:oops"])
    expect(multiStops({ ...base, icons: true, sections: ["bots", "projects"] })).toEqual(["bot:calm", "bot:scout", "bot:hermes-1", "bot:oops", "s1", "s2"])
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
