import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "@mendcode/protocol"
import { renderSessionSidebar, sessionMark, SIDEBAR_WIDTH } from "../src/view/sidebar"
import { renderMultiSidebar, type MultiInput, type MultiSession } from "../src/view/sidebar-multi"
import { mergeActivity, type ActivityEvent } from "../src/view/session-activity"
import { glyphSet } from "../src/ui/theme"

const NOW = 1_800_000_000_000
const plain = (line: Array<{ text: string }>) => line.map((span) => span.text).join("")
type Row = { sessionId: string; title: string; state: string; queued: number; updatedAt: number; [key: string]: unknown }
const row = (sessionId: string, title: string, over: Partial<Row> = {}): Row => ({ sessionId, title, state: "idle", queued: 0, updatedAt: NOW - 60_000, ...over })
const single = (sessions: Row[], over: Partial<Parameters<typeof renderSessionSidebar>[0]> = {}) =>
  renderSessionSidebar({ sessions: sessions as never, current: "none", focused: false, height: 24, now: NOW, glyphs: glyphSet("unicode"), spinner: "⠹", ...over })
const multiSession = (id: string, extra: Partial<MultiSession> = {}): MultiSession => ({ sessionId: id, title: `chat ${id}`, directory: "/work/app", updatedAt: NOW - 60_000, state: "idle", queued: 0, lastSeq: 9, ...extra })
const multi = (sessions: MultiSession[]) => renderMultiSidebar({ current: "none", directory: "/work/app", focused: false, height: 30, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), projects: { isProject: () => true, count: Number.POSITIVE_INFINITY }, spinner: "⠹", sessions } as MultiInput)
const lineWith = (rows: Array<Array<{ text: string; fg?: string }>>, text: string) => rows.find((line) => plain(line).includes(text))!

describe("the left list shows sub-agents at work and compaction", () => {
  test("a resting session whose sub-agents work spins, with their live count in the working colour", () => {
    expect(sessionMark({ sessionId: "p", title: "", state: "idle", queued: 0, updatedAt: 0, agents: 2 }, false)).toBe("running")
    expect(sessionMark({ sessionId: "p", title: "", state: "error", queued: 0, updatedAt: 0, agents: 1 }, false)).toBe("running")
    expect(sessionMark({ sessionId: "p", title: "", state: "waiting_approval", queued: 0, updatedAt: 0, agents: 1 }, false)).toBe("approval")
    const out = single([row("p", "Parent", { agents: 2 }), row("q", "Plain")])
    const line = lineWith(out.rows, "Parent")
    expect(plain(line).startsWith(" ")).toBe(true)
    expect(line.find((span) => span.text.startsWith("⠹"))).toMatchObject({ fg: "primary" })
    expect(line.find((span) => span.text === " ↳2")).toMatchObject({ fg: "primary" })
    expect(plain(lineWith(out.rows, "Plain"))).not.toContain("↳")
    for (const line of out.rows) expect(plain(line).length).toBeLessThanOrEqual(SIDEBAR_WIDTH)
  })

  test("the live count replaces the dim count of listed children while they work; ASCII draws ^", () => {
    const idle = single([row("p", "Parent"), row("c", "Child", { parentId: "p" })])
    expect(lineWith(idle.rows, "Parent").find((span) => span.text === " ↳1")).toMatchObject({ fg: "muted" })
    const busy = single([row("p", "Parent", { agents: 3 }), row("c", "Child", { parentId: "p", state: "generating" })])
    expect(lineWith(busy.rows, "Parent").find((span) => span.text === " ↳3")).toMatchObject({ fg: "primary" })
    expect(plain(lineWith(single([row("p", "Parent", { agents: 1 })], { ascii: true }).rows, "Parent"))).toContain(" ^1")
  })

  test("compacting takes the time's place, and the selected row says how many sub-agents work", () => {
    const out = single([row("a", "Native", { state: "compacting", since: NOW - 5_000 }), row("b", "Claude", { state: "generating", compacting: true, since: NOW - 5_000 }), row("c", "Working", { state: "generating", since: NOW - 5_000 })])
    expect(lineWith(out.rows, "Native").find((span) => span.text === "compacting")).toMatchObject({ fg: "info" })
    expect(plain(lineWith(out.rows, "Claude"))).toContain("compacting")
    expect(plain(lineWith(out.rows, "Working"))).toContain("5s")
    expect(plain(lineWith(out.rows, "Working"))).not.toContain("compacting")
    const picked = single([row("b", "Claude", { state: "generating", compacting: true, agents: 2 })], { focused: true, selected: "b" })
    expect(picked.rows.map(plain).join("\n")).toContain("  2 sub-agents working ")
    expect(plain(lineWith(picked.rows, "Claude"))).toContain("compacting ↳2")
  })

  test("the multi-folder list draws the same on a session row", () => {
    const rows = multi([multiSession("p", { agents: 2 }), multiSession("k", { state: "generating", compacting: true })]).rows
    const parent = lineWith(rows, "chat p")
    expect(parent.find((span) => span.text.startsWith("⠹"))).toMatchObject({ fg: "primary" })
    expect(parent.find((span) => span.text === " ↳2")).toMatchObject({ fg: "primary" })
    expect(lineWith(rows, "chat k").find((span) => span.text === "compacting")).toMatchObject({ fg: "info" })
  })

  test("each push replaces the live fields: gone from it means none works and nothing compacts", () => {
    const listed = [{ sessionId: "p", title: "Parent", directory: "/r", createdAt: 0, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0 }] as SessionSummary[]
    const push = (over: Partial<ActivityEvent>): ActivityEvent => ({ type: "session.activity", gseq: 1, at: 1, sessionId: "p", directory: "/r", title: "Parent", state: "idle", updatedAt: 2, ...over } as ActivityEvent)
    const busy = mergeActivity(listed, push({ agents: 2, compacting: true }), { cap: 10, keep: "p" })
    expect(busy[0]).toMatchObject({ agents: 2, compacting: true })
    const calm = mergeActivity(busy, push({}), { cap: 10, keep: "p" })
    expect(calm[0]!.agents).toBeUndefined()
    expect(calm[0]!.compacting).toBeUndefined()
  })
})
