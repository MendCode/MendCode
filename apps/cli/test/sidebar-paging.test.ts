import { describe, expect, test } from "bun:test"
import { glyphSet } from "../src/ui/theme"
import { multiStops, renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import { plain } from "./session-ui-harness"

const NOW = new Date(2026, 10, 16, 15, 0).getTime()
const MINUTE = 60_000
const session = (sessionId: string, title: string, directory: string, age: number) => ({ sessionId, title, directory, state: "idle", queued: 0, updatedAt: NOW - age * MINUTE, lastSeq: 9 })

describe("the more-projects row reveals a page at a time", () => {
  const projects = Array.from({ length: 30 }, (_, n) => session(`p${n}`, `chat ${n}`, `/p/proj${String(n).padStart(2, "0")}`, n + 1))
  const base: MultiInput = { sessions: projects as never, current: "p0", directory: "/p/proj00", focused: false, height: 200, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), glyphs: glyphSet("unicode"), projects: { isProject: () => true, count: 3 } }
  const rows = (over: Partial<MultiInput> = {}) => renderMultiSidebar({ ...base, ...over }).rows.map(plain)
  const groups = (over: Partial<MultiInput> = {}) => rows(over).filter((row) => /[▾▸] proj/.test(row)).length

  test("closed, the cap shows; each page adds eight and the row keeps counting the rest", () => {
    expect(groups()).toBe(3)
    expect(rows().join("\n")).toMatch(/\+ 27 more projects/)
    expect(groups({ projectsRevealed: 8 })).toBe(11)
    expect(rows({ projectsRevealed: 8 }).join("\n")).toMatch(/\+ 19 more projects/)
  })

  test("once every project shows, the row is show fewer", () => {
    expect(groups({ projectsRevealed: 27 })).toBe(30)
    const all = rows({ projectsRevealed: 27 }).join("\n")
    expect(all).toContain("show fewer")
    expect(all).not.toContain("more projects")
  })

  test("an automatic count fills the height, and a page adds eight projects past the cut", () => {
    const auto = { projects: { isProject: () => true, count: 0 }, height: 24 }
    const listed = (over: Partial<MultiInput> = {}) => multiStops({ ...base, ...auto, ...over }).filter((id) => id.startsWith("group:")).length
    const cut = listed()
    expect(cut).toBeLessThan(30)
    expect(listed({ projectsRevealed: 8 })).toBe(cut + 8)
  })
})

describe("a project's more row reveals a page at a time", () => {
  const list = Array.from({ length: 30 }, (_, n) => session(`s${n}`, `task ${String(n).padStart(2, "0")}`, "/work/app", n + 1))
  const base: MultiInput = { sessions: list as never, current: "s0", directory: "/work/app", focused: false, height: 200, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), glyphs: glyphSet("unicode"), previewCount: 5 }
  const tasks = (over: Partial<MultiInput> = {}) => renderMultiSidebar({ ...base, ...over }).rows.map(plain).filter((row) => row.includes("task "))

  test("a page of eight joins the preview, the row keeps its count, and the whole list ends in show less", () => {
    expect(tasks()).toHaveLength(5)
    const paged = renderMultiSidebar({ ...base, revealed: new Map([["/work/app", 8]]) }).rows.map(plain)
    expect(paged.filter((row) => row.includes("task "))).toHaveLength(13)
    expect(paged.join("\n")).toMatch(/\+ 17 more/)
    const whole = renderMultiSidebar({ ...base, revealed: new Map([["/work/app", 25]]) }).rows.map(plain)
    expect(whole.filter((row) => row.includes("task "))).toHaveLength(30)
    expect(whole.join("\n")).toContain("show less")
  })

  test("the first newly revealed row follows the old last one in the stops", () => {
    const before = multiStops(base)
    const after = multiStops({ ...base, revealed: new Map([["/work/app", 8]]) })
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
    expect(after[before.length - 1]).toBe("s5")
  })
})
