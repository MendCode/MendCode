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
  test("all projects: the opened one first and open, the others folded with an active count", () => {
    const rows = text()
    const at = (needle: string) => rows.findIndex((row) => row.includes(needle))
    expect(at("▾ app")).toBeGreaterThan(-1)
    expect(at("Chrome")).toBeGreaterThan(at("▾ app"))
    expect(at("Client reconnect")).toBeGreaterThan(at("Chrome"))
    expect(rows[at("▸ api")]).toMatch(/▸ api +1 active │$/)
    expect(rows[at("▸ site")]).toMatch(/▸ site +1 │$/)
    expect(at("Other project")).toBe(-1)
    expect(at("▸ api")).toBeGreaterThan(at("Client reconnect"))
  })

  test("a folded group opens by choice, and the opened one folds", () => {
    const rows = text({ open: new Map([["/other/api", true], ["/work/app", false]]) })
    expect(rows.some((row) => row.includes("▾ api"))).toBe(true)
    expect(rows.some((row) => row.includes("Other project"))).toBe(true)
    expect(rows.some((row) => row.includes("▸ app"))).toBe(true)
    expect(rows.some((row) => row.includes("Chrome"))).toBe(false)
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

describe("keyboard stops and mouse hits agree with what is drawn", () => {
  test("stops run in drawing order: bots, groups and their visible sessions, never a hidden one", () => {
    expect(multiStops(base)).toEqual(["group:/work/app", "s1", "s2", "group:/other/api", "group:/work/site", "bot:calm", "bot:scout", "bot:hermes-1", "bot:oops"])
    expect(multiStops({ ...base, sections: ["bots", "projects"], open: new Map([["/other/api", true]]) })).toEqual(["bot:calm", "bot:scout", "bot:hermes-1", "bot:oops", "group:/work/app", "s1", "s2", "group:/other/api", "s3", "s4", "group:/work/site"])
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
