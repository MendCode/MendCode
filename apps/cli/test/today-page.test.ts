import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { NOW, TODAY_DEMO } from "../../../benchmarks/fixtures/today-page-fixture"
import type { TodayTriageGroup } from "@mendcode/protocol"
import { createTodayState, MAX_TRIAGE_ITEMS, renderTodayPage, TAB_MEANING, todayPageKey, todaySummary, triageItems, TODAY_TABS, type TodayData, type TodayState, type TodayTab, type TodayTriageView } from "../src/view/today-page"
import { lineWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")
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
    expect(text).toContain("enter open session · m pin for today · t triage")
    expect(text).toContain("keys     enter open session · m pin for today")
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

  test("the rows sent are the page's rows, attention first, capped", () => {
    const items = triageItems(TODAY_DEMO)
    expect(items[0]).toMatchObject({ id: "attention:a1", tab: "attention", kind: "approval" })
    expect(items.map((item) => item.tab)).toEqual([...Array(4).fill("attention"), ...Array(4).fill("pickup"), ...Array(3).fill("memory")])
    const many = { ...TODAY_DEMO, memory: Array.from({ length: 80 }, (_, i) => ({ ...TODAY_DEMO.memory[0]!, id: `m${i}` })) }
    expect(triageItems(many)).toHaveLength(MAX_TRIAGE_ITEMS)
  })
})
