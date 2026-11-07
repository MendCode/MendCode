import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { NOW, TODAY_DEMO } from "../../../benchmarks/fixtures/today-page-fixture"
import type { TodayTriageGroup } from "@mendcode/protocol"
import { createTodayState, MAX_TRIAGE_ITEMS, renderTodayPage, TAB_MEANING, todayPageKey, todaySummary, triageItems, TODAY_TABS, type TodayData, type TodayState, type TodayTab, type TodayTriageView } from "../src/view/today-page"
import { lineWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")
/** The page's text with its wrapping undone, for a sentence that may break across rows. */
const flat = (text: string) => text.replace(/\s+/g, " ")
const SIZES = [[80, 24], [120, 34], [180, 45], [60, 20]] as const
const EMPTY: TodayData = { summary: { lastVisit: NOW - 9 * 3600 * 1000, sessionsRan: 0, sessionsFinished: 0, projects: 1, dreamRuns: 0 }, attention: [], pickup: [], memory: [] }
const render = (tab: TodayTab, width: number, height: number, data = TODAY_DEMO, extra: { selected?: number; help?: boolean } = {}) =>
  renderTodayPage({ data, state: { ...createTodayState(), tab, ...extra }, width, height, now: NOW })

describe("renderTodayPage", () => {
  for (const tab of TODAY_TABS) {
    for (const [width, height] of SIZES) {
      test(`${tab} at ${width}x${height} is exactly the height and no row is wider than the width`, () => {
        for (const data of [TODAY_DEMO, EMPTY]) {
          const lines = render(tab, width, height, data)
          expect(lines).toHaveLength(height)
          for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(width)
        }
      })
    }
  }

  test("every selection of every tab fits at the smallest size", () => {
    for (const tab of TODAY_TABS) {
      const count = { attention: TODAY_DEMO.attention.length, pickup: TODAY_DEMO.pickup.length, memory: TODAY_DEMO.memory.length }[tab]
      for (let selected = 0; selected < count + 1; selected++) {
        const lines = render(tab, 80, 24, TODAY_DEMO, { selected })
        expect(lines).toHaveLength(24)
        for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(80)
      }
    }
  })

  test("the attention tab lists each item with why it is there and where it is managed", () => {
    const text = plain(render("attention", 180, 45))
    for (const item of TODAY_DEMO.attention) expect(text).toContain(item.title.slice(0, 20))
    expect(text).toContain("approval · shop-api · command waiting for your approval")
    expect(text).toContain("managed  session · ses_8f3a")
    expect(text).toContain("history")
    expect(text).toContain("evidence")
  })

  test("the pick up tab shows where each session was left and what was next", () => {
    const text = plain(render("pickup", 120, 34))
    expect(text).toContain("Coupon preview endpoint")
    expect(text).toContain("left off")
    expect(text).toContain("next")
  })

  test("the memory tab shows what Dream did and the memory before and after", () => {
    const text = plain(render("memory", 120, 34))
    expect(text).toContain("Dream dream_0412")
    expect(text).toContain("before → after")
    expect(text).toContain("- Tests need fixed dates")
    expect(text).toContain("+ Tests freeze the clock")
  })

  test("a tab with nothing says so instead of inventing rows", () => {
    expect(plain(render("attention", 120, 34, EMPTY))).toContain("nothing needs you")
    expect(plain(render("pickup", 120, 34, EMPTY))).toContain("nothing to pick up")
    expect(plain(render("memory", 120, 34, EMPTY))).toContain("no proposals")
    expect(plain(render("attention", 120, 34, EMPTY))).toContain("select an item")
  })

  test("the summary is built from counts and says when nothing is waiting", () => {
    expect(todaySummary(TODAY_DEMO, NOW)).toBe("Since you left 14h ago: 6 sessions ran in 3 projects and 4 finished. 4 things wait for your answer, 4 sessions were left half-done and Dream proposes 3 memory changes.")
    expect(todaySummary(TODAY_DEMO, NOW, 2)).toEndWith("2 rows pinned for today.")
    expect(todaySummary(EMPTY, NOW)).toContain("Nothing needs you, nothing is left to pick up and Dream has no proposals.")
  })

  test("? replaces the detail with the list of every key", () => {
    expect(plain(render("attention", 180, 34))).toContain("? keys")
    const text = plain(render("attention", 180, 34, TODAY_DEMO, { help: true }))
    expect(text).toContain("? hide keys")
    expect(text).toContain("scroll the detail")
  })

  test("the tab row carries the summary after the numbered tabs", () => {
    const row = plain(render("attention", 120, 34).slice(1, 2))
    expect(row).toContain("1 Attention 4")
    expect(row).toContain("since 14h ago · 3 projects")
    expect(plain(render("attention", 120, 34))).not.toContain("runs nothing")
  })

  test("[ ] scrolls the detail and moving resets it", () => {
    const first = plain(render("attention", 80, 24))
    const scrolled = renderTodayPage({ data: TODAY_DEMO, state: { ...createTodayState(), scroll: 4 }, width: 80, height: 24, now: NOW })
    expect(plain(scrolled)).not.toBe(first)
    const down = todayPageKey({ ...createTodayState(), scroll: 4 }, "]", TODAY_DEMO).state
    expect(down.scroll).toBe(8)
    expect(todayPageKey(down, "[", TODAY_DEMO).state.scroll).toBe(4)
    expect(todayPageKey(down, "j", TODAY_DEMO).state).toMatchObject({ selected: 1, scroll: 0 })
    expect(todayPageKey(down, "2", TODAY_DEMO).state).toMatchObject({ tab: "pickup", selected: 0, scroll: 0 })
  })

  test("enter opens where the item is managed and ? toggles the keys", () => {
    expect(todayPageKey(createTodayState(), "\r", TODAY_DEMO).action).toEqual({ type: "open", link: TODAY_DEMO.attention[0]!.link })
    expect(todayPageKey(createTodayState(), "?", TODAY_DEMO).state.help).toBe(true)
    expect(todayPageKey(createTodayState(), "\r", { ...TODAY_DEMO, attention: [] }).action).toEqual({ type: "none" })
  })

  test("real data without history or evidence leaves those headings out, and notes say what this client could not read", () => {
    const bare: TodayData = {
      ...EMPTY,
      notes: ["This client is read-only: memory proposals and contradictions are not listed."],
      attention: [{ ...TODAY_DEMO.attention[0]!, history: [], evidence: [] }],
      pickup: [{ ...TODAY_DEMO.pickup[0]!, state: "failed", history: [], evidence: [], link: { command: "session", ref: "ses_1", sessionId: "ses_1" } }],
    }
    const attention = plain(render("attention", 120, 34, bare))
    expect(attention).not.toContain("history")
    expect(attention).not.toContain("evidence")
    expect(attention).toContain("This client is read-only")
    expect(plain(render("pickup", 120, 34, bare))).toContain("failed")
    expect(todayPageKey({ ...createTodayState(), tab: "pickup" }, "\r", bare).action).toEqual({ type: "open", link: { command: "session", ref: "ses_1", sessionId: "ses_1" } })
    for (const [width, height] of SIZES) for (const line of render("attention", width, height, bare)) expect(lineWidth(line)).toBeLessThanOrEqual(width)
  })

  test("a selection past the end is clamped to the last row", () => {
    expect(plain(render("memory", 120, 34, TODAY_DEMO, { selected: 99 }))).toContain("Drop the staging upload bucket")
  })

  test("each tab says what it means, so Attention (blocked on you) and Pick up (half-done) read apart", () => {
    expect(plain(render("attention", 120, 34))).toContain(TAB_MEANING.attention)
    expect(plain(render("pickup", 120, 34))).toContain(TAB_MEANING.pickup)
    expect(plain(render("memory", 120, 34))).toContain(TAB_MEANING.memory)
    const text = plain(render("attention", 120, 34))
    expect(text).toContain("enter open session · m pin · x dismiss · X dismiss old · d dismissed · t triage")
    expect(text).toContain("keys     enter open session · m pin for today · x dismiss")
  })

  test("the tab strip draws each count once: after its label, never beside the shortcut, and equal to the listed rows", () => {
    for (const [width, height] of SIZES) {
      const tabs = renderTodayPage({ data: TODAY_DEMO, state: createTodayState(), width, height, now: NOW })[1]!
      const counted = tabs.filter((span) => /\d/.test(span.text) && !span.dim && !span.text.includes("since")).map((span) => span.text.trim())
      expect(counted.map((text) => text.replace(/^\D+/, ""))).toEqual(["4", "4", "3"])
      expect(counted.every((text) => /^[A-Z][a-z ]+ \d+$/.test(text))).toBe(true)
      expect(tabs.filter((span) => span.dim).map((span) => span.text.trim())).toEqual(["1", "2", "3"])
    }
  })
})

describe("dismiss, fold and the counts", () => {
  const review = (id: string, since: number, older = false) => ({ ...TODAY_DEMO.attention[1]!, id, title: `acme/shop#${id}`, since, ...(older ? { older: true } : {}) })
  const DAY = 24 * 3_600_000
  const data: TodayData = { ...TODAY_DEMO, attention: [...TODAY_DEMO.attention, review("9", NOW - 9 * DAY, true), review("12", NOW - 12 * DAY, true)] }

  test("older reviews fold under one line that o opens, and the tab, the summary and the list agree", () => {
    const text = plain(renderTodayPage({ data, state: createTodayState(), width: 120, height: 34, now: NOW }))
    expect(text).toContain(" 1 Attention 4 ")
    expect(flat(text)).toContain("4 things wait for your answer (2 older reviews folded)")
    expect(text).toContain("2 older reviews folded (untouched 7+ days)")
    expect(text).not.toContain("acme/shop#9")
    const open = todayPageKey(createTodayState(), "o", data, NOW).state
    const listed = plain(renderTodayPage({ data, state: open, width: 120, height: 34, now: NOW }))
    expect(listed).toContain(" 1 Attention 6 ")
    expect(listed).toContain("acme/shop#9")
    expect(listed).toContain("2 older reviews listed · o folds them")
    expect(flat(listed)).toContain("4 things wait for your answer (2 older reviews folded)")
    expect(triageItems(data).map((item) => item.id)).not.toContain("attention:9")
  })

  test("x dismisses the row until something newer happens on it; d lists the dismissed rows and x brings one back", () => {
    const first = todayPageKey(createTodayState(), "x", data, NOW)
    const key = `attention:${TODAY_DEMO.attention[0]!.id}`
    expect(first.action).toEqual({ type: "dismiss", rows: [{ key, at: TODAY_DEMO.attention[0]!.since }], on: true })
    expect(first.state.selected).toBe(0)
    const after = plain(renderTodayPage({ data, state: first.state, width: 120, height: 34, now: NOW }))
    expect(after).toContain(" 1 Attention 3 ")
    expect(flat(after)).toContain("3 things wait for your answer (2 older reviews folded, 1 row dismissed)")
    expect(after).not.toContain(TODAY_DEMO.attention[0]!.title)
    // A newer question on the same row brings it back by itself.
    const newer = { ...data, attention: data.attention.map((item, i) => (i === 0 ? { ...item, since: item.since + 1 } : item)) }
    expect(plain(renderTodayPage({ data: newer, state: first.state, width: 120, height: 34, now: NOW }))).toContain(TODAY_DEMO.attention[0]!.title)
    const list = todayPageKey(first.state, "d", data, NOW).state
    const dismissed = plain(renderTodayPage({ data, state: list, width: 120, height: 34, now: NOW }))
    expect(dismissed).toContain("Attention · dismissed")
    expect(dismissed).toContain(TODAY_DEMO.attention[0]!.title)
    expect(dismissed).toContain("x bring back")
    const back = todayPageKey(list, "x", data, NOW)
    expect(back.action).toEqual({ type: "dismiss", rows: [{ key, at: TODAY_DEMO.attention[0]!.since }], on: false })
    expect(back.state.dismissed).toEqual({})
    expect(todayPageKey(list, "\x1b", data, NOW)).toMatchObject({ action: { type: "none" }, state: { showDismissed: false } })
  })

  test("X asks once before dismissing every review untouched for N days; + - change N, anything else cancels", () => {
    const asked = todayPageKey(createTodayState(), "X", data, NOW)
    expect(asked.action).toEqual({ type: "none" })
    expect(plain(renderTodayPage({ data, state: asked.state, width: 120, height: 34, now: NOW }))).toContain("Dismiss 2 reviews untouched for 7+ days? y dismiss")
    const longer = todayPageKey(todayPageKey(asked.state, "+", data, NOW).state, "+", data, NOW).state
    expect(longer.confirm).toEqual({ days: 9 })
    expect(plain(renderTodayPage({ data, state: longer, width: 120, height: 34, now: NOW }))).toContain("Dismiss 2 reviews untouched for 9+ days?")
    const cancel = todayPageKey(asked.state, "n", data, NOW)
    expect(cancel).toMatchObject({ action: { type: "none" } })
    expect(cancel.state.confirm).toBeUndefined()
    const done = todayPageKey(asked.state, "y", data, NOW)
    expect(done.action).toEqual({ type: "dismiss", rows: [{ key: "attention:9", at: NOW - 9 * DAY }, { key: "attention:12", at: NOW - 12 * DAY }], on: true })
    expect(plain(renderTodayPage({ data, state: done.state, width: 120, height: 34, now: NOW }))).not.toContain("older reviews folded (untouched")
    // In the dismissed list X brings every row back, after the same one question.
    const list = todayPageKey(done.state, "d", data, NOW).state
    const restore = todayPageKey(todayPageKey(list, "X", data, NOW).state, "y", data, NOW)
    expect(restore.action).toMatchObject({ type: "dismiss", on: false })
    expect(restore.state.dismissed).toEqual({})
  })

  test("every view fits every size", () => {
    const dismissed = todayPageKey(createTodayState(), "x", data, NOW).state
    for (const state of [createTodayState(), { ...createTodayState(), showOlder: true }, { ...dismissed, showDismissed: true }, { ...createTodayState(), showDismissed: true }, { ...createTodayState(), confirm: { days: 7 } }]) {
      for (const [width, height] of SIZES) {
        const lines = renderTodayPage({ data, state, width, height, now: NOW })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("pins for today", () => {
  test("m pins the selected row: it moves under Today, the selection follows and the action names its key", () => {
    const state = { ...createTodayState(), selected: 2 }
    const result = todayPageKey(state, "m", TODAY_DEMO)
    expect(result.action).toEqual({ type: "mark", keys: ["attention:a3"], on: true })
    expect(result.state).toMatchObject({ marks: ["attention:a3"], selected: 0 })
    const text = plain(renderTodayPage({ data: TODAY_DEMO, state: result.state, width: 120, height: 34, now: NOW }))
    expect(text).toContain("Today · 1 pinned")
    expect(text).toContain("The rest")
    expect(text.indexOf("Choose how a coupon")).toBeLessThan(text.indexOf("Run db:migrate"))
    expect(text).toContain("pinned for today")
    expect(text).toContain("m unpin")
    expect(todaySummary(TODAY_DEMO, NOW, 1)).toContain("1 row pinned for today")
    const back = todayPageKey(result.state, "m", TODAY_DEMO)
    expect(back.action).toEqual({ type: "mark", keys: ["attention:a3"], on: false })
    expect(back.state.marks).toEqual([])
  })

  test("pinned rows fit every size, and enter still opens the pinned row's own link", () => {
    const state = { ...createTodayState(["attention:a4", "pickup:ses_a410"]) }
    for (const tab of TODAY_TABS) for (const [width, height] of SIZES) {
      const lines = renderTodayPage({ data: TODAY_DEMO, state: { ...state, tab }, width, height, now: NOW })
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(todayPageKey(state, "\r", TODAY_DEMO).action).toEqual({ type: "open", link: TODAY_DEMO.attention[3]!.link })
  })
})

describe("triage", () => {
  const groups: TodayTriageGroup[] = [
    { title: "2 approvals only run tests", reason: "both ask to run the test suite", example: "attention:a1", action: "review", ids: ["attention:a1", "attention:a2"] },
    { title: "3 memory proposals about tests", reason: "they touch the same facts", example: "memory:p1", action: "memory", ids: ["memory:p1", "memory:p2", "memory:p3"] },
    { title: "2 sessions to finish today", reason: "small and nearly done", example: "pickup:ses_5d90", action: "mark", ids: ["pickup:ses_5d90", "pickup:ses_e3c8"] },
  ]
  const ready = (extra: Partial<TodayTriageView> = {}): TodayState => ({ ...createTodayState(), triage: { open: true, status: "ready", model: "gpt-6-luna", sent: 11, groups, selected: 0, accepted: [], ...extra } })

  test("t asks for a triage only when there is none; with one it shows it again", () => {
    expect(todayPageKey(createTodayState(), "t", TODAY_DEMO).action).toEqual({ type: "triage" })
    const hidden = { ...ready(), triage: { ...ready().triage!, open: false } }
    const shown = todayPageKey(hidden, "t", TODAY_DEMO)
    expect(shown.action).toEqual({ type: "none" })
    expect(shown.state.triage?.open).toBe(true)
    expect(todayPageKey(ready(), "t", TODAY_DEMO).action).toEqual({ type: "triage" })
  })

  test("the proposal view names the model, each group's action, reason, example and rows", () => {
    const text = plain(renderTodayPage({ data: TODAY_DEMO, state: ready(), width: 120, height: 34, now: NOW }))
    expect(text).toContain("Today · Triage")
    expect(text).toContain("gpt-6-luna grouped 7 of 11 rows in one call")
    expect(text).toContain("2 approvals only run tests")
    expect(text).toContain("one by one")
    expect(text).toContain("review in /memory")
    expect(text).toContain("example  Run db:migrate on staging")
    expect(text).toContain("Attention: Review of fix/coupon-cap")
    for (const [width, height] of SIZES) for (const state of [ready(), ready({ status: "running", groups: [] }), ready({ status: "error", message: "offline", groups: [] })]) {
      const lines = renderTodayPage({ data: TODAY_DEMO, state, width, height, now: NOW })
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(plain(renderTodayPage({ data: TODAY_DEMO, state: ready({ status: "error", message: "the daemon is offline", groups: [] }), width: 120, height: 34, now: NOW }))).toContain("the daemon is offline")
  })

  test("accepting does only what the page offers: review lists the rows, mark pins them, memory opens /memory, nothing is approved", () => {
    const review = todayPageKey(ready(), "a", TODAY_DEMO)
    expect(review.action).toEqual({ type: "none" })
    expect(review.state).toMatchObject({ tab: "attention", filter: { keys: ["attention:a1", "attention:a2"] } })
    expect(review.state.triage).toMatchObject({ open: false, accepted: [0] })
    const listed = plain(renderTodayPage({ data: TODAY_DEMO, state: review.state, width: 120, height: 34, now: NOW }))
    expect(listed).toContain("group: 2 approvals only run tests")
    expect(listed).not.toContain("Choose how a coupon")
    expect(todayPageKey(review.state, "\x1b", TODAY_DEMO).state.filter).toBeUndefined()
    expect(todayPageKey(ready({ selected: 1 }), "a", TODAY_DEMO).action).toEqual({ type: "open", link: { command: "/memory" } })
    const mark = todayPageKey(ready({ selected: 2 }), "a", TODAY_DEMO)
    expect(mark.action).toEqual({ type: "mark", keys: ["pickup:ses_5d90", "pickup:ses_e3c8"], on: true })
    expect(mark.state.marks).toEqual(["pickup:ses_5d90", "pickup:ses_e3c8"])
    expect(todayPageKey(ready(), "\r", TODAY_DEMO).state.triage?.accepted).toEqual([])
    expect(todayPageKey(ready(), "\x1b", TODAY_DEMO)).toMatchObject({ action: { type: "none" }, state: { triage: { open: false } } })
  })

  test("[ and ] scroll the group panel while triage is open and keep it open", () => {
    const down = todayPageKey(ready(), "]", TODAY_DEMO)
    expect(down.state).toMatchObject({ scroll: 4, triage: { open: true, selected: 0 } })
    expect(todayPageKey(down.state, "[", TODAY_DEMO).state.scroll).toBe(0)
    expect(todayPageKey(ready(), "[", TODAY_DEMO).state.scroll).toBe(0)
  })

  test("the rows sent are the page's rows, attention first, capped", () => {
    const items = triageItems(TODAY_DEMO)
    expect(items[0]).toMatchObject({ id: "attention:a1", tab: "attention", kind: "approval" })
    expect(items.map((item) => item.tab)).toEqual([...Array(4).fill("attention"), ...Array(4).fill("pickup"), ...Array(3).fill("memory")])
    const many = { ...TODAY_DEMO, memory: Array.from({ length: 80 }, (_, i) => ({ ...TODAY_DEMO.memory[0]!, id: `m${i}` })) }
    expect(triageItems(many)).toHaveLength(MAX_TRIAGE_ITEMS)
  })
})
