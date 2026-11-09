import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { markAnimates, renderSessionSidebar, SETTLED_ROW, SIDEBAR_WIDTH, sessionMark, sidebarStops } from "../src/view/sidebar"
import { glyphSet } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, plain } from "./session-ui-harness"

afterAll(cleanTemps)

const NOW = new Date(2026, 10, 6, 15, 0).getTime()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
type Row = { sessionId: string; title: string; state: string; queued: number; updatedAt: number; [key: string]: unknown }
const row = (sessionId: string, title: string, over: Partial<Row> = {}): Row => ({ sessionId, title, state: "idle", queued: 0, updatedAt: NOW, ...over })
const draw = (sessions: Row[], over: Partial<Parameters<typeof renderSessionSidebar>[0]> = {}) =>
  renderSessionSidebar({ sessions: sessions as never, current: "none", focused: false, height: 24, now: NOW, glyphs: glyphSet("unicode"), ...over })
const lineOf = (out: ReturnType<typeof draw>, text: string) => out.rows.find((line) => plain(line).includes(text))!
const textOf = (out: ReturnType<typeof draw>) => out.rows.map(plain)

describe("one row per session with a state symbol", () => {
  test("every state has its symbol and colour role, most urgent first", () => {
    const out = draw([
      row("a", "Waiting", { state: "waiting_approval" }),
      row("b", "Working", { state: "tool" }),
      row("c", "Broken", { state: "error" }),
      row("d", "Replied"),
      row("e", "Queued", { queued: 2 }),
      row("f", "Resting"),
    ], { unread: ["d"], spinner: "⠹" })
    const mark = (title: string) => lineOf(out, title).find((span) => span.text.trim() && span.text !== " ")!
    expect(mark("Waiting")).toMatchObject({ text: "? ", fg: "warning" })
    expect(mark("Working")).toMatchObject({ text: "⠹ ", fg: "primary" })
    expect(mark("Broken")).toMatchObject({ text: "✗ ", fg: "error" })
    expect(mark("Replied")).toMatchObject({ text: "● ", fg: "success" })
    expect(mark("Queued")).toMatchObject({ text: "… ", fg: "muted" })
    expect(mark("Resting")).toMatchObject({ text: "· ", fg: "muted" })
    expect(sessionMark({ sessionId: "x", title: "", state: "waiting_approval", queued: 3, updatedAt: 0 }, true)).toBe("approval")
    expect(sessionMark({ sessionId: "x", title: "", state: "idle", queued: 0, updatedAt: 0, archivedAt: 1 }, true)).toBe("settled")
  })

  test("only running and approval rows animate; without the tick they are still and approval stays warning", () => {
    expect((["approval", "running", "error", "unread", "queued", "settled", "idle"] as const).filter(markAnimates)).toEqual(["approval", "running"])
    const still = draw([row("a", "Working", { state: "generating" }), row("b", "Waiting", { state: "waiting_approval" })])
    expect(plain(lineOf(still, "Working"))).toContain(`${glyphSet("unicode").running} Working`)
    expect(lineOf(still, "Waiting").find((span) => span.text === "? ")?.fg).toBe("warning")
    const off = draw([row("b", "Waiting", { state: "waiting_approval" })], { spinner: "⠼", blink: false })
    expect(lineOf(off, "Waiting").find((span) => span.text === "? ")?.fg).toBe("muted")
  })

  test("titles stay in one column, the meta sits on the right edge with two blanks before it, and every row is the sidebar's width", () => {
    const out = draw([
      row("a", "A title that is far too long to fit in a thirty eight column sidebar", { lifecycle: { pr: { number: 412, state: "OPEN" } }, updatedAt: NOW - 4 * MINUTE }),
      row("b", "Short", { updatedAt: NOW - 3 * 60 * MINUTE }),
      row("c", "Child", { parentId: "b" }),
    ])
    for (const line of out.rows) expect(textWidth(plain(line))).toBe(SIDEBAR_WIDTH)
    const long = plain(lineOf(out, "A title"))
    expect(long).toContain("…")
    expect(long).toMatch(/… {2,}4m #412 │$/)
    expect(plain(lineOf(out, "Short"))).toMatch(/ 3h ↳1 │$/)
    expect(plain(lineOf(out, "Short")).indexOf("Short")).toBe(plain(lineOf(out, "A title")).indexOf("A title"))
    expect(lineOf(out, "#412").find((span) => span.text === " #412")?.fg).toBe("success")
  })

  test("groups are Pinned, Today, Earlier and a folded Settled row, with a blank row before every heading but the first", () => {
    const out = draw([
      row("p", "Pinned one", { lifecycle: { pinnedAt: 1 }, updatedAt: NOW - 5 * DAY }),
      row("t", "From today", { updatedAt: NOW - 30 * MINUTE }),
      row("e", "From before", { updatedAt: NOW - 2 * DAY }),
      row("s1", "Settled one", { archivedAt: 1, state: "error" }),
      row("s2", "Settled two", { archivedAt: 1 }),
    ], { header: false })
    const text = textOf(out).map((line) => line.replace("│", "").trim().replace(/ +/g, " "))
    expect(text.slice(0, 11)).toEqual(["Pinned", "· Pinned one 5d", "", "Today", "· From today 30m", "", "Earlier", "· From before 2d", "", "✗ Settled · 2 ▸", ""])
    expect(lineOf(out, "Today").find((span) => span.text === "Today")).toMatchObject({ fg: "muted" })
    // The folded row shows the most urgent symbol among the settled sessions, and their titles stay out until it is opened.
    expect(plain(lineOf(out, "Settled · 2"))).toContain("✗ Settled")
    expect(textOf(out).join("\n")).not.toContain("Settled one")
    expect(out.hits.find((hit) => hit.sessionId === SETTLED_ROW)).toBeDefined()
    const open = draw([row("s1", "Settled one", { archivedAt: 1 })], { settledOpen: true })
    expect(textOf(open).join("\n")).toContain("Settled one")
    expect(sidebarStops([{ sessionId: "a" }, { sessionId: "s", archivedAt: 1 }], false)).toEqual(["a", SETTLED_ROW])
    expect(sidebarStops([{ sessionId: "a" }, { sessionId: "s", archivedAt: 1 }], true)).toEqual(["a", SETTLED_ROW, "s"])
    expect(sidebarStops([{ sessionId: "a" }], false)).toEqual(["a"])
  })

  test("the current row carries the bar; the selected row has the fill across the whole row, a › mark and the only detail line", () => {
    const sessions = [row("a", "Open one"), row("b", "Picked one", { tool: "Bash", queued: 1, lifecycle: { pr: { number: 9, state: "MERGED" } } }), row("c", "Other one", { tool: "Read" })]
    const out = draw(sessions, { current: "a", selected: "b", focused: true })
    expect(plain(lineOf(out, "Open one")).startsWith(" ▌ ")).toBe(true)
    const picked = lineOf(out, "Picked one")
    expect(plain(picked).startsWith(" › ")).toBe(true)
    expect(picked.slice(0, -1).every((span) => span.bg === "element")).toBe(true)
    expect(picked.at(-1)).toMatchObject({ text: "│", fg: "border" })
    const text = textOf(out).join("\n")
    expect(text).toContain("tool Bash · 1 queued · PR merg…")
    expect(text).not.toContain("tool Read")
    // Without focus nothing is selected: no fill and no detail line.
    const unfocused = draw(sessions, { current: "a", selected: "b" })
    expect(lineOf(unfocused, "Picked one").some((span) => span.bg === "element")).toBe(false)
    expect(textOf(unfocused).join("\n")).not.toContain("tool Bash")
  })

  test("the header counts what works and what waits, and a long list keeps the selected row in view", () => {
    const busy = draw([row("a", "One", { state: "tool" }), row("b", "Two", { state: "waiting_approval" })], { spinner: "⠹" })
    expect(plain(busy.rows[0]!)).toMatch(/Sessions +⠹ 1  \? 1 │$/)
    const many = Array.from({ length: 30 }, (_, at) => row(`s${at}`, `Session ${at}`, { updatedAt: NOW - at * MINUTE }))
    const out = draw(many, { height: 12, selected: "s25", focused: true })
    expect(out.rows).toHaveLength(12)
    expect(textOf(out).join("\n")).toContain("Session 25")
    expect(plain(out.rows.at(-1)!)).toMatch(/↑ ↓ \d+ more/)
  })

  test("ASCII glyphs keep every symbol drawable", () => {
    const out = draw([row("a", "Resting"), row("b", "Queued", { queued: 1 }), row("c", "Child", { parentId: "a" })], { glyphs: glyphSet("ascii"), ascii: true })
    expect(plain(lineOf(out, "Resting"))).toContain(". Resting")
    expect(plain(lineOf(out, "Resting"))).toContain("^1")
    expect(plain(lineOf(out, "Queued"))).toContain("~ Queued")
  })
})

describe("the sessions sidebar in the app", () => {
  const asReply = (reply: unknown) => reply as CommandReply
  function sidebarApp() {
    const h = appHarness({
      width: 160,
      height: 36,
      directory: "/work/app",
      reply: (command) => command.type === "session.list"
        ? asReply({ ok: true, result: { sessions: [
          { sessionId: h.sessionId, directory: "/work/app", title: "Open here", createdAt: 0, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 },
          { sessionId: "other", directory: "/work/app", title: "Elsewhere", createdAt: 0, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 },
          { sessionId: "done", directory: "/work/app", title: "Put away", createdAt: 0, updatedAt: NOW - DAY, lastSeq: 0, state: "idle", queued: 0, archivedAt: NOW },
        ] } })
        : undefined,
    })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
    // Settings arriving is what asks for the session list.
    h.app.applySettings({} as never)
    h.app.render()
    return h
  }
  const side = (h: ReturnType<typeof sidebarApp>) => h.text().map((line) => line.slice(0, SIDEBAR_WIDTH))
  const activity = (over: Record<string, unknown>) => ({ type: "session.activity", gseq: 2, at: NOW, sessionId: "other", directory: "/work/app", title: "Elsewhere", state: "idle", updatedAt: NOW, ...over }) as never

  test("nothing is unread at the start; a reply finished elsewhere afterwards shows the unread dot", async () => {
    const h = sidebarApp()
    await Bun.sleep(5)
    h.app.render()
    expect(side(h).find((line) => line.includes("Elsewhere"))).toContain("· Elsewhere")
    h.app.onGlobal(activity({ state: "generating", updatedAt: NOW + 1_000 }))
    h.app.render()
    expect(side(h).find((line) => line.includes("Elsewhere"))).not.toContain("● Elsewhere")
    h.app.onGlobal(activity({ state: "idle", updatedAt: NOW + 2_000 }))
    h.app.render()
    expect(side(h).find((line) => line.includes("Elsewhere"))).toContain("● Elsewhere")
  })

  test("a running session elsewhere moves its symbol on the existing pulse; an idle list draws no frames by itself", async () => {
    const h = sidebarApp()
    await Bun.sleep(50)
    h.app.render()
    const resting = h.frames.length
    await Bun.sleep(300)
    expect(h.frames.length).toBe(resting)
    h.app.onGlobal(activity({ state: "tool", updatedAt: NOW + 1_000 }))
    h.app.render()
    const first = side(h).find((line) => line.includes("Elsewhere"))!
    await Bun.sleep(300)
    expect(side(h).find((line) => line.includes("Elsewhere"))).not.toBe(first)
    h.app.onGlobal(activity({ state: "idle", updatedAt: NOW + 2_000 }))
    h.app.render()
    // A frame already asked for may still land; after it nothing more is drawn.
    await Bun.sleep(50)
    const settled = h.frames.length
    await Bun.sleep(300)
    expect(h.frames.length).toBe(settled)
  })

  test("the keyboard stops on the Settled row, Enter unfolds it and a click folds it again", async () => {
    const h = sidebarApp()
    await Bun.sleep(5)
    h.app.render()
    expect(side(h).join("\n")).not.toContain("Put away")
    await h.app.onKey("\x1b[D")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    expect(side(h).join("\n")).toContain("Put away")
    expect(h.sentOf("session.open")).toHaveLength(0)
    const settledRow = side(h).findIndex((line) => line.includes("Settled · 1"))
    await h.app.onKey(`\x1b[<0;6;${settledRow + 1}M`)
    await h.app.onKey(`\x1b[<0;6;${settledRow + 1}m`)
    expect(side(h).join("\n")).not.toContain("Put away")
  })
})
