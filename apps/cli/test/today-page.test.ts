import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { NOW, TODAY_DEMO } from "../../../benchmarks/fixtures/today-page-fixture"
import { createTodayState, renderTodayPage, todayPageKey, todaySummary, TODAY_TABS, type TodayData, type TodayTab } from "../src/view/today-page"
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
    expect(todaySummary(TODAY_DEMO, NOW)).toBe("Since you left 14h ago: 6 sessions ran in 3 projects and 4 finished. 4 things need you, 4 sessions can be picked up and Dream proposes 3 changes.")
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
})
