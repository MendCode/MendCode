import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { markAnimates, renderSessionSidebar, SETTLED_MORE, SETTLED_ROW, SIDEBAR_WIDTH, sessionMark, sidebarStops } from "../src/view/sidebar"
import { mergeActivity } from "../src/view/session-activity"
import { autoSettled } from "../src/view/sidebar-marks"
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
    expect(long).toMatch(/… {2,}4m #412 open │$/)
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
  function sidebarApp(moreSettled = 0) {
    const h = appHarness({
      width: 160,
      height: 36,
      directory: "/work/app",
      reply: (command) => command.type === "session.list"
        ? asReply({ ok: true, result: { sessions: [
          { sessionId: h.sessionId, directory: "/work/app", title: "Open here", createdAt: 0, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 },
          { sessionId: "other", directory: "/work/app", title: "Elsewhere", createdAt: 0, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 },
          { sessionId: "done", directory: "/work/app", title: "Put away", createdAt: 0, updatedAt: NOW - DAY, lastSeq: 0, state: "idle", queued: 0, archivedAt: NOW },
          ...Array.from({ length: moreSettled }, (_, n) => ({ sessionId: `old${n}`, directory: "/work/app", title: `Old ${String(n).padStart(2, "0")}`, createdAt: 0, updatedAt: NOW - DAY - n, lastSeq: 0, state: "idle", queued: 0, archivedAt: NOW - n - 1 })),
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

  test("a running session elsewhere moves its symbol on a slow pulse (2 frames a second); an idle list draws no frames by itself", async () => {
    const h = sidebarApp()
    await Bun.sleep(50)
    h.app.render()
    const resting = h.frames.length
    await Bun.sleep(300)
    expect(h.frames.length).toBe(resting)
    h.app.onGlobal(activity({ state: "tool", updatedAt: NOW + 1_000 }))
    h.app.render()
    const first = side(h).find((line) => line.includes("Elsewhere"))!
    const before = h.frames.length
    await Bun.sleep(1_100)
    expect(side(h).find((line) => line.includes("Elsewhere"))).not.toBe(first)
    // The chat itself rests: two ticks in a second, not the 8 of a chat that works.
    expect(h.frames.length - before).toBeLessThanOrEqual(3)
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
    // The open session is the second stop; one down reaches Settled (a second would wrap to the first row).
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    expect(side(h).join("\n")).toContain("Put away")
    expect(h.sentOf("session.open")).toHaveLength(0)
    const settledRow = side(h).findIndex((line) => line.includes("Settled · 1"))
    await h.app.onKey(`\x1b[<0;6;${settledRow + 1}M`)
    await h.app.onKey(`\x1b[<0;6;${settledRow + 1}m`)
    expect(side(h).join("\n")).not.toContain("Put away")
  })

  test("Enter on the last + N more row selects the first session it revealed instead of losing the selection", async () => {
    // One live pair, then 11 settled: the shelf lists 10 and a `+ 1 more` row whose page takes the row away.
    const h = sidebarApp(10)
    await Bun.sleep(5)
    h.app.render()
    await h.app.onKey("\x1b[D")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    const selected = () => side(h).find((line) => /^ › /.test(line))
    for (let turn = 0; turn < 20 && !selected()?.includes("+ 1 more"); turn++) await h.app.onKey("\x1b[B")
    expect(selected()).toContain("+ 1 more")
    await h.app.onKey("\r")
    h.app.render()
    expect(side(h).join("\n")).not.toContain("more")
    expect(selected()).toContain("Old 09")
    expect(h.sentOf("session.open")).toHaveLength(0)
  })
})

describe("T3-style marks on the rows", () => {
  const pr = (state: string, extra: Record<string, unknown> = {}) => ({ lifecycle: { pr: { number: 812, url: "u", title: "t", state, branch: "feat/sidebar", checkedAt: NOW - DAY, ...extra } } })

  test("a running row counts up from its turn's start; an idle row keeps its age", () => {
    const out = draw([row("a", "Busy", { state: "tool", since: NOW - (2 * MINUTE + 14_000), updatedAt: NOW - 9 * DAY }), row("b", "Calm", { updatedAt: NOW - 3 * 60 * MINUTE }), row("c", "Busy no start", { state: "tool", updatedAt: NOW - 5 * MINUTE })], { header: false })
    expect(plain(lineOf(out, "Busy")).trimEnd()).toMatch(/2m14s │$/)
    expect(plain(lineOf(out, "Calm"))).toMatch(/ 3h │$/)
    // Without a start time the age shows, as before.
    expect(plain(lineOf(out, "Busy no start"))).toMatch(/ 5m │$/)
    const later = draw([row("a", "Busy", { state: "tool", since: NOW - 2 * MINUTE - 14_000 })], { now: NOW + 46_000 })
    expect(plain(lineOf(later, "Busy"))).toMatch(/3m00s │$/)
  })

  test("waiting marks differ: approval, question and plan; failure keeps its cross", () => {
    const out = draw([
      row("a", "Approve", { state: "waiting_approval", pending: "Run ls", pendingKind: "approval" }),
      row("b", "Ask", { state: "waiting_approval", pendingKind: "question" }),
      row("c", "Plan", { state: "waiting_approval", pendingKind: "plan" }),
      row("d", "Old daemon", { state: "waiting_approval" }),
      row("e", "Broken", { state: "error" }),
    ], { blink: true })
    const mark = (title: string) => { const span = lineOf(out, title).find((span) => span.text.trim() && span.text !== " ")!; return { ...span, text: span.text.trim() } }
    expect(mark("Approve")).toMatchObject({ text: "?", fg: "warning" })
    expect(mark("Ask")).toMatchObject({ text: "◎", fg: "info" })
    expect(mark("Plan")).toMatchObject({ text: "◈", fg: "accent" })
    expect(mark("Old daemon")).toMatchObject({ text: "?", fg: "warning" })
    expect(mark("Broken")).toMatchObject({ text: "✗", fg: "error" })
    expect(sessionMark({ sessionId: "x", title: "", state: "waiting_approval", queued: 0, updatedAt: 0, pendingKind: "question" }, false)).toBe("question")
    expect(markAnimates("question")).toBe(true)
    // The header counts every kind that waits for you.
    expect(plain(out.rows[0]!)).toContain("? 4")
    // Detail lines say what is asked.
    const picked = draw([row("b", "Ask", { state: "waiting_approval", pendingKind: "question" })], { current: "b", selected: "b", focused: true })
    expect(textOf(picked).join("\n")).toContain("asks you a question")
  })

  test("a PR shows its number and state word in the state colour; the word survives a long title", () => {
    const out = draw([row("a", "Add sidebar", pr("MERGED")), row("b", "Fix", pr("OPEN")), row("c", "Drop", pr("CLOSED")), row("d", "A very long title that cannot fit in the row at all", pr("MERGED", { number: 99999999 }))], { header: false })
    expect(plain(lineOf(out, "Add sidebar"))).toMatch(/ #812 merged │$/)
    expect(lineOf(out, "Add sidebar").find((span) => span.text === " merged")).toMatchObject({ fg: "accent" })
    expect(lineOf(out, "Fix").find((span) => span.text === " open")).toMatchObject({ fg: "success" })
    expect(lineOf(out, "Drop").find((span) => span.text === " closed")).toMatchObject({ fg: "error" })
    const long = plain(lineOf(out, "A very long"))
    expect(long).toContain("…")
    expect(long).toMatch(/merged │$/)
    expect(long).not.toContain("#9999")
  })

  test("the branch and worktree show on the selected row's detail line only", () => {
    const sessions = [row("a", "Open one", pr("OPEN")), row("b", "Other one")]
    const out = draw(sessions, { current: "x", selected: "a", focused: true, folder: { branch: "main", worktree: "wt-x" } })
    const text = textOf(out).join("\n")
    expect(text).toContain("feat/sidebar · worktree wt-x")
    expect(text).not.toContain("main ·")
    const plainRow = draw(sessions, { current: "x", folder: { branch: "main", worktree: "wt" } })
    expect(textOf(plainRow).join("\n")).not.toContain("worktree")
    // The folder's branch belongs to the open session only.
    const open = draw([row("b", "Other one", { queued: 1 })], { current: "b", selected: "b", focused: true, folder: { branch: "main" } })
    expect(textOf(open).join("\n")).toContain("main · 1 queued")
    const other = draw([row("b", "Other one", { queued: 1 })], { current: "x", selected: "b", focused: true, folder: { branch: "main" } })
    expect(textOf(other).join("\n")).not.toContain("main")
  })

  test("the Settled shelf shows 10, then `+ N more` reveals 25 at a time", () => {
    const settled = Array.from({ length: 43 }, (_, n) => row(`s${String(n).padStart(2, "0")}`, `Old thing ${String(n).padStart(2, "0")}`, { archivedAt: 1 }))
    const first = draw(settled, { settledOpen: true, height: 80 })
    expect(textOf(first).filter((line) => line.includes("Old thing")).length).toBe(10)
    expect(textOf(first).join("\n")).toContain("+ 33 more")
    const page = draw(settled, { settledOpen: true, settledShown: 35, height: 80 })
    expect(textOf(page).filter((line) => line.includes("Old thing")).length).toBe(35)
    expect(textOf(page).join("\n")).toContain("+ 8 more")
    expect(textOf(draw(settled, { settledOpen: true, settledShown: 60, height: 80 })).join("\n")).not.toContain("more")
    const hits = first.hits.map((hit) => hit.sessionId)
    expect(hits).toContain(SETTLED_MORE)
    const ids = settled.map((entry) => entry.sessionId)
    expect(sidebarStops(settled as never, true)).toEqual([SETTLED_ROW, ...ids.slice(0, 10), SETTLED_MORE])
    expect(sidebarStops(settled as never, true, 60)).toEqual([SETTLED_ROW, ...ids])
  })
})

describe("a merged or closed PR settles its session", () => {
  const settle = (over: Record<string, unknown>, current = "none") => autoSettled([{ sessionId: "a", state: "idle", queued: 0, updatedAt: NOW - DAY, lifecycle: { pr: { number: 1, url: "u", title: "t", state: "MERGED", branch: "b", checkedAt: NOW - 10 * MINUTE } }, ...over }] as never, current)[0] as { archivedAt?: number }

  test("merged and closed settle; open, running, waiting, queued, pinned and the open session stay", () => {
    expect(settle({}).archivedAt).toBe(NOW - 10 * MINUTE)
    expect(settle({ lifecycle: { pr: { number: 1, url: "u", title: "t", state: "CLOSED", branch: "b", checkedAt: NOW - 10 * MINUTE } } }).archivedAt).toBe(NOW - 10 * MINUTE)
    expect(settle({ lifecycle: { pr: { number: 1, url: "u", title: "t", state: "OPEN", branch: "b", checkedAt: NOW } } }).archivedAt).toBeUndefined()
    expect(settle({ state: "tool" }).archivedAt).toBeUndefined()
    expect(settle({ state: "waiting_approval" }).archivedAt).toBeUndefined()
    expect(settle({ queued: 1 }).archivedAt).toBeUndefined()
    expect(settle({ lifecycle: { pinnedAt: 1, pr: { number: 1, url: "u", title: "t", state: "MERGED", branch: "b", checkedAt: NOW } } }).archivedAt).toBeUndefined()
    expect(settle({}, "a").archivedAt).toBeUndefined()
  })

  test("new activity after the PR check brings it back", () => {
    expect(settle({ updatedAt: NOW - 5 * MINUTE }).archivedAt).toBeUndefined()
  })

  test("the settled session lands on the Settled shelf", () => {
    const sessions = autoSettled([row("a", "Shipped", { lifecycle: { pr: { number: 1, url: "u", title: "t", state: "MERGED", branch: "b", checkedAt: NOW } }, updatedAt: NOW - DAY }), row("b", "Live")] as never, "b")
    const out = draw(sessions as never, { header: false })
    expect(textOf(out).join("\n")).toContain("Settled · 1")
    expect(textOf(out).join("\n")).not.toContain("Shipped")
  })
})

describe("the pushed live detail reaches the list", () => {
  test("since and the kind of request follow each push and go with the turn", () => {
    const base = [row("a", "One")] as never
    const push = (extra: Record<string, unknown>) => ({ type: "session.activity", sessionId: "a", directory: "/d", title: "One", state: "tool", updatedAt: NOW, ...extra }) as never
    const running = mergeActivity(base, push({ since: NOW - 5_000, tool: "Bash" }), { cap: 50, keep: "a" })[0] as { since?: number; tool?: string }
    expect(running).toMatchObject({ since: NOW - 5_000, tool: "Bash" })
    const asking = mergeActivity([running] as never, push({ state: "waiting_approval", since: NOW - 5_000, pending: "Pick one", pendingKind: "question" }), { cap: 50, keep: "a" })[0] as { pendingKind?: string }
    expect(asking.pendingKind).toBe("question")
    const done = mergeActivity([asking] as never, push({ state: "idle" }), { cap: 50, keep: "a" })[0] as { since?: number; pendingKind?: string }
    expect(done.since).toBeUndefined()
    expect(done.pendingKind).toBeUndefined()
  })
})
