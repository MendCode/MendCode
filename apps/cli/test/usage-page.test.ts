import { describe, expect, test } from "bun:test"
import type { UsageDay, UsageReport } from "@mendcode/protocol"
import { glyphs, type Line } from "../src/ui/theme"
import { compact, createUsagePageState, duration, rangeBounds, renderUsagePage, usagePageKey, usageSelectedSession, type UsagePageState } from "../src/view/usage-page"
import { textWidth } from "../src/view/wrap"

const TODAY = "2026-09-26"
const NOW = Date.UTC(2026, 8, 26, 12)
const DAY_MS = 86_400_000
const HOUR = 3_600_000

const dayOf = (offset: number) => new Date(Date.UTC(2026, 8, 26) - offset * DAY_MS).toISOString().slice(0, 10)
const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const joined = (lines: Line[]) => plain(lines).join("\n")

function usage(day: string, patch: Partial<UsageDay> = {}): UsageDay {
  return { day, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0, calls: 0, sessions: 0, ...patch }
}

function quota(patch: { usedPercent?: number; resetsAt?: number; fetchedAt?: number; windowMinutes?: number } = {}): UsageReport["quotas"][number] {
  return {
    gseq: 1,
    at: NOW,
    type: "quota.snapshot",
    provider: "codex",
    windows: [{ id: "7d", label: "7d", usedPercent: patch.usedPercent ?? 17, resetsAt: patch.resetsAt ?? NOW + 6 * DAY_MS, windowMinutes: patch.windowMinutes ?? 10_080 }],
    fetchedAt: patch.fetchedAt ?? NOW,
    source: "test",
  }
}

const SESSIONS = [
  { sessionId: "ses_a", title: "Rewrite the usage page", directory: "/work/mendcode", tokens: 91_000_000, ms: 13 * HOUR, turns: 212 },
  { sessionId: "ses_b", title: "Fix reconnect", directory: "/work/mendcode", tokens: 40_000_000, ms: 4 * HOUR, turns: 80 },
]

/** 365 days with a weekly pattern, a few zero days, one unique maximum day (today - 40). */
function fixtureReport(): UsageReport {
  const days: UsageDay[] = []
  for (let offset = 364; offset >= 0; offset--) {
    const weekday = new Date(Date.UTC(2026, 8, 26) - offset * DAY_MS).getUTCDay()
    if (weekday === 0 || offset === 100 || offset === 101 || offset === 40) continue
    const weight = weekday === 6 ? 1 : 3 + (offset % 5)
    days.push(usage(dayOf(offset), { input: weight * 1_000, output: weight * 200, cacheRead: weight * 500, calls: weight, sessions: 1 + (offset % 3), costMicros: weight * 1_000 }))
  }
  days.push(usage(dayOf(40), { input: 9_000_000, calls: 500, sessions: 9, costMicros: 5_000_000 }))
  return {
    from: dayOf(364),
    to: TODAY,
    days,
    models: [
      { provider: "codex", model: "gpt-5.6", input: 5_000_000, output: 900_000, calls: 300, costMicros: 0 },
      { provider: "anthropic", model: "claude-sonnet-5", input: 9_000_000, output: 100_000, calls: 700, costMicros: 5_000_000 },
      { provider: "openrouter", model: "qwen3-coder-480b-a35b-instruct-with-a-very-long-suffix-漢字", input: 1_000, output: 10, calls: 3, costMicros: 10 },
    ],
    quotas: [quota()],
    sessions: 628,
    activity: [{ day: dayOf(1), prompts: 40, words: 3_100, aiMs: 90 * 60_000, toolMs: 30 * 60_000 }],
    tools: [
      { tool: "shell", calls: 4_210, ms: 9_800_000, errors: 31 },
      { tool: "read", calls: 3_900, ms: 400_000, errors: 0 },
    ],
    profile: { name: "Ada Lovelace", email: "ada@example.com", plan: "Pro" },
    insights: {
      lifetime: { tokens: 69_900_000_000, since: "2025-10-02" },
      peakDay: { day: "2026-09-02", tokens: 2_800_000_000 },
      streak: { current: 159, longest: 160 },
      longestSession: SESSIONS[0]!,
      efforts: [{ effort: "high", turns: 330 }, { effort: "low", turns: 110 }],
      skills: [{ skill: "build", runs: 5_000 }, { skill: "fix", runs: 430 }],
      topSessions: SESSIONS,
    },
  }
}

function emptyReport(): UsageReport {
  return { from: dayOf(364), to: TODAY, days: [], models: [], quotas: [] }
}

function state(patch: Partial<UsagePageState> = {}): UsagePageState {
  return { ...createUsagePageState(TODAY), ...patch }
}

function render(over: Partial<Parameters<typeof renderUsagePage>[0]> = {}) {
  return renderUsagePage({ report: fixtureReport(), state: state(), today: TODAY, width: 140, height: 50, now: NOW, ...over })
}

const WEEKDAYS = new Set(["Mo  ", "Tu  ", "We  ", "Th  ", "Fr  ", "Sa  ", "Su  "])
const gridRows = (lines: Line[]) => lines.filter((line) => line.some((span) => span.fg === "muted" && WEEKDAYS.has(span.text)))
const cells = (line: Line) => line.filter((span) => span.text === "■ " || span.text === "▣ ")

describe("usage page state and keys", () => {
  test("all four edges clamp with today mid-week, Home/End and out-of-range state", () => {
    const today = "2026-09-30" // Wednesday, so Thursday–Sunday in the last column are not cells.
    for (const range of [30, 90, 365] as const) {
      const bounds = rangeBounds(range, today)
      const first = { ...createUsagePageState(today), range, selectedDay: bounds.from, scroll: 20 }
      const last = { ...first, selectedDay: bounds.to }
      for (const key of ["\x1b[D", "\x1b[A", "h", "k"]) expect(usagePageKey(first, key, today)).toMatchObject({ selectedDay: bounds.from, scroll: 0 })
      for (const key of ["\x1b[C", "\x1b[B", "l", "j"]) expect(usagePageKey(last, key, today)).toMatchObject({ selectedDay: today, scroll: 0 })
      expect(usagePageKey(last, "\x1b[H", today).selectedDay).toBe(bounds.from)
      expect(usagePageKey(first, "\x1b[F", today).selectedDay).toBe(today)
      expect(usagePageKey({ ...last, selectedDay: "2099-01-01" }, "\x1b[C", today).selectedDay).toBe(today)
      expect(usagePageKey({ ...first, selectedDay: "2000-01-01" }, "\x1b[A", today).selectedDay).toBe(bounds.from)
      expect(usagePageKey({ ...last, selectedDay: "2026-09-29" }, "\x1b[B", today).selectedDay).toBe(today)
    }
  })

  test("Home pans the heatmap to its first column; every edge keeps exactly one visible selected cell", () => {
    const today = "2026-09-30"
    for (const width of [60, 100, 160, 220]) {
      const current = createUsagePageState(today)
      for (const key of ["\x1b[H", "\x1b[F"]) {
        const state = usagePageKey(current, key, today)
        const lines = render({ state, today, width, height: 60 })
        expect(gridRows(lines).flatMap(cells).filter((span) => span.text === "▣ ")).toHaveLength(1)
        expect(joined(lines)).toContain(state.selectedDay)
      }
    }
  })

  test("starts on Overview with the 365-day range, today and daily granularity", () => {
    expect(createUsagePageState(TODAY)).toEqual({ range: 365, selectedDay: TODAY, mode: "daily", tab: 0, scroll: 0, sessionIndex: 0, scope: "global" })
    expect(rangeBounds(30, TODAY)).toEqual({ from: dayOf(29), to: TODAY })
  })

  test("tab, shift-tab and 1-7 pick the tab and reset the scroll", () => {
    expect(usagePageKey(state(), "\t", TODAY).tab).toBe(1)
    expect(usagePageKey(state(), "\x1b[Z", TODAY).tab).toBe(6)
    expect(usagePageKey(state({ tab: 6 }), "\t", TODAY).tab).toBe(0)
    expect(usagePageKey(state({ tab: 2, scroll: 7 }), "4", TODAY)).toMatchObject({ tab: 3, scroll: 0 })
    expect(usagePageKey(state(), "8", TODAY)).toEqual(state())
  })

  test("g and m cycle daily -> weekly -> cumulative -> daily", () => {
    let current = state()
    const seen = []
    for (let i = 0; i < 3; i++) {
      current = usagePageKey(current, i % 2 ? "m" : "g", TODAY)
      seen.push(current.mode)
    }
    expect(seen).toEqual(["weekly", "cumulative", "daily"])
  })

  test("[ and ] step the range through 30/90/365 and clamp the selected day", () => {
    const down = usagePageKey(state({ selectedDay: dayOf(200) }), "[", TODAY)
    expect(down).toMatchObject({ range: 90, selectedDay: dayOf(89) })
    expect(usagePageKey(state(), "]", TODAY)).toEqual(state())
    expect(usagePageKey(usagePageKey(down, "[", TODAY), "[", TODAY).range).toBe(30)
  })

  test("on Overview the arrows move the day (±1, ±7) inside the range", () => {
    expect(usagePageKey(state(), "\x1b[D", TODAY).selectedDay).toBe(dayOf(1))
    expect(usagePageKey(state(), "k", TODAY).selectedDay).toBe(dayOf(7))
    expect(usagePageKey(state(), "\x1b[C", TODAY).selectedDay).toBe(TODAY)
    expect(usagePageKey(state({ range: 30, selectedDay: dayOf(29) }), "h", TODAY).selectedDay).toBe(dayOf(29))
  })

  test("elsewhere ↑↓ scroll, and on Sessions they move the selection within the list", () => {
    expect(usagePageKey(state({ tab: 2 }), "j", TODAY).scroll).toBe(1)
    expect(usagePageKey(state({ tab: 2 }), "k", TODAY)).toEqual(state({ tab: 2 }))
    const report = fixtureReport()
    const down = usagePageKey(state({ tab: 5 }), "\x1b[B", TODAY, report)
    expect(down.sessionIndex).toBe(1)
    expect(usagePageKey(down, "\x1b[B", TODAY, report).sessionIndex).toBe(1)
    expect(usageSelectedSession(down, report)).toBe("ses_b")
    expect(usageSelectedSession(state(), report)).toBeUndefined()
  })
})

describe("number formats", () => {
  test("compact and duration", () => {
    expect(compact(999)).toBe("999")
    expect(compact(1_500_000)).toBe("1.5M")
    expect(duration(0)).toBe("0s")
    expect(duration(500)).toBe("<1s")
    expect(duration(252_000)).toBe("4m 12s")
    expect(duration(2 * HOUR + 5 * 60_000)).toBe("2h 5m")
  })
})

describe("usage page layout", () => {
  test("every tab is exactly width × height at 60/80/120/160 columns, with and without data", () => {
    for (const report of [fixtureReport(), emptyReport()])
      for (const tab of [0, 1, 2, 3, 4, 5])
        for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
          const lines = render({ report, state: state({ tab }), width, height })
          expect(lines).toHaveLength(height)
          for (const line of lines) expect(textWidth(text(line))).toBe(width)
        }
  })

  test("full-width dashboard header carries the real keys and six tabs", () => {
    const lines = render({ width: 220 })
    expect(text(lines[0]!)).toContain("Usage Insights")
    expect(text(lines[0]!)).toContain("←→ Day")
    expect(text(lines[0]!)).toContain("↑↓ Week")
    expect(text(lines[0]!)).toContain("Home/End Edges")
    expect(text(lines[1]!)).toContain("global stats · daily · 365d")
    expect(text(lines[2]!)).toContain("6 Sessions")
    expect(lines[2]!.find((span) => span.text === " 1 Overview ")).toMatchObject({ bg: "element" })
    expect(joined(lines)).not.toContain("ada@example.com")
    expect(text(render({ state: state({ tab: 5 }), width: 220 })[0]!)).toContain("Enter Open")
  })

  test("panel borders span the available width", () => {
    const lines = render({ width: 200 })
    const row = lines.find((line) => text(line).includes("Token activity"))!
    expect(text(row).indexOf("┌")).toBe(1)
    expect(text(row).trimEnd()).toEndWith("┐")
  })

  test("scroll shows later rows and keeps the header and tabs fixed", () => {
    const top = render({ state: state({ tab: 2 }), height: 24 })
    const scrolled = render({ state: state({ tab: 2, scroll: 6 }), height: 24 })
    expect(plain(scrolled.slice(0, 4))).toEqual(plain(top.slice(0, 4)))
    expect(joined(scrolled)).not.toEqual(joined(top))
  })

})

describe("Overview", () => {
  test("an empty selected week stays marked in weekly and cumulative modes", () => {
    for (const mode of ["weekly", "cumulative"] as const) {
      const lines = render({ report: emptyReport(), state: state({ mode }) })
      expect(lines.flat().filter((span) => span.text === "▣ ")).toHaveLength(1)
      expect(lines.flat().find((span) => span.text === "▣ ")).toMatchObject({ fg: "warning", bold: true })
    }
  })

  test("four stat tiles show range totals and honest missing figures", () => {
    const all = joined(render({ width: 220, height: 60 }))
    for (const needle of ["Tokens", "Sessions", "AI time", "Prompts / words", "628", "40 prompts", "3,100 words", "Longest response unavailable", "Streak 159d · 160d longest"]) expect(all).toContain(needle)
    expect(all).not.toContain("Ada Lovelace")
    expect(all).not.toContain("Lifetime tokens")
  })

  test("older daemons show no invented activity or streaks", () => {
    const { insights, profile, activity, ...report } = fixtureReport()
    const all = joined(render({ report, width: 220, height: 60 }))
    expect(all).toContain("Tokens")
    expect(all).toContain("Streaks unavailable")
    expect(all).toContain("No activity report")
    expect(all).not.toContain("Ada")
  })

  test("the daily grid has seven weekday rows and one cell per day in the ramp colors", () => {
    const rows = gridRows(render())
    expect(rows.map((row) => row.find((span) => WEEKDAYS.has(span.text))!.text.trim())).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])
    const colored = rows.flatMap(cells).filter((span) => span.text === "■ ")
    expect(colored.every((span) => typeof span.fgHex === "string")).toBe(true)
    expect(new Set(colored.map((span) => span.fgHex)).size).toBeGreaterThanOrEqual(4)
  })

  test("the selected day is ▣ in bold warning and its line gives tokens, calls and sessions", () => {
    const lines = render({ state: state({ selectedDay: dayOf(40) }) })
    const marked = gridRows(lines).flatMap(cells).filter((span) => span.text === "▣ ")
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ fg: "warning", bold: true })
    expect(joined(lines)).toContain(`Selected day · ${dayOf(40)}`)
    expect(joined(lines)).toContain("9M tokens · 500 calls · 9 sessions")
    expect(joined(render({ state: state({ selectedDay: dayOf(100) }) }))).toContain("No token usage")
  })

  test("month labels never overlap and narrow pages show only the latest weeks", () => {
    const wide = cells(gridRows(render({ width: 160 }))[0]!).length
    const narrow = cells(gridRows(render({ width: 80 }))[0]!).length
    expect(narrow).toBeLessThan(wide)
    const months = plain(render({ width: 220 })).find((line) => /Oct\s+Nov/.test(line))!
    expect(months).toMatch(/Oct +Nov +Dec/)
  })

  test("legend and lower panels show tools, skills and known costs", () => {
    const all = joined(render({ width: 220, height: 60 }))
    expect(all).toMatch(/Less (■ ){5}More/)
    for (const label of ["Token mix", "Response load", "Peak pressure", "Per-day tokens", "Models", "Cost per model", "Top sessions"]) expect(all).toContain(label)
    expect(all).toContain("build")
    expect(all).toContain("5,000 runs")
    expect(all).toContain("4,210 calls")
    expect(all).toContain("Pricing unavailable")
    expect(all).not.toContain("Outcome signals")
  })

  test("weekly and cumulative granularity draw bars instead of the calendar", () => {
    const weekly = render({ state: state({ mode: "weekly" }) })
    expect(gridRows(weekly)).toHaveLength(0)
    expect(weekly.some((line) => line.some((span) => span.text === "█ " && span.fg === "success"))).toBe(true)
    expect(render({ state: state({ mode: "cumulative" }) }).some((line) => line.some((span) => span.text === "█ " && span.fg === "primary"))).toBe(true)
  })
})

describe("Limits", () => {
  test("each window shows a bar of what is left, % left, reset time and data age", () => {
    const all = joined(render({ state: state({ tab: 1 }) }))
    expect(all).toContain("codex")
    expect(all).toContain("Weekly")
    expect(all).toContain("83% left")
    expect(all).toMatch(/resets Oct 2 \d\d:\d\d/)
    expect(all).toContain("updated just now")
  })

  test("low headroom warns, stale data warns, the glyph set is honored", () => {
    const report = { ...fixtureReport(), quotas: [quota({ usedPercent: 97, fetchedAt: NOW - 3 * HOUR, windowMinutes: 300 })] }
    const lines = render({ report, state: state({ tab: 1 }), glyphs: { ...glyphs(), barFull: "#", barEmpty: "-" } })
    expect(joined(lines)).toContain("5-hour")
    expect(lines.flat().find((span) => span.text.includes("3% left"))?.fg).toBe("error")
    expect(lines.flat().find((span) => span.text === "updated 3h ago")?.fg).toBe("warning")
    expect(joined(lines)).toMatch(/#-+/)
  })

  test("no quota data says so", () => {
    expect(joined(render({ report: emptyReport(), state: state({ tab: 1 }) }))).toContain("No quota data")
  })

  test("the empty quota explanation remains complete at 60x20", () => {
    const lines = render({ report: emptyReport(), state: state({ tab: 1 }), width: 60, height: 20 })
    expect(joined(lines).replace(/\s+/g, " ")).toContain("Limits appear after the first response from a provider that reports them.")
    expect(lines.every((line) => textWidth(text(line)) <= 60)).toBe(true)
  })
})

describe("Tokens, Models, Tools, Sessions", () => {
  test("Tokens shows totals, mix with shares, calls and cost", () => {
    const all = joined(render({ state: state({ tab: 2 }) }))
    for (const needle of ["Total", "Input", "Cache hit", "Token mix", "Calls and cost", "Estimated cost", "Weekly tokens"]) expect(all).toContain(needle)
  })

  test("Models lists models by tokens with right-aligned numbers and the effort split", () => {
    const lines = render({ state: state({ tab: 3 }) })
    const rows = plain(lines).filter((line) => /codex\/gpt-5\.6|anthropic\/claude-sonnet-5/.test(line))
    expect(rows[0]).toContain("anthropic/claude-sonnet-5")
    expect(joined(lines)).toContain("Reasoning effort")
    expect(joined(lines)).toContain("high")
    for (const line of lines) expect(textWidth(text(line))).toBe(140)
  })

  test("Tools lists calls, time and errors, and skills with their runs", () => {
    const lines = render({ state: state({ tab: 4 }) })
    expect(joined(lines)).toContain("Tool calls")
    expect(lines.flat().find((span) => span.text.trim() === "31")?.fg).toBe("error")
    expect(joined(lines)).toContain("430 runs")
  })

  test("Sessions ranks the top sessions and marks the selected one", () => {
    const lines = render({ state: state({ tab: 5, sessionIndex: 1 }) })
    const all = joined(lines)
    expect(all).toContain("Longest chat (all time)")
    expect(all).toContain("Rewrite the usage page")
    expect(all).toContain("/work/mendcode")
    const marked = lines.find((line) => line.some((span) => span.text === "› "))!
    expect(text(marked)).toContain("Fix reconnect")
  })

  test("at 40 columns Sessions drops whole numbers instead of cutting them, and the longest chat keeps its label", () => {
    const all = plain(render({ state: state({ tab: 5 }), width: 40, height: 20 }))
    expect(all).toContain(" Longest chat (all time)".padEnd(40))
    const row = all.find((line) => line.includes("Rewrite the usage") && line.includes("tok"))!
    expect(row.trimEnd()).toMatch(/91M tok +13h 0m$/)
    expect(all.join("\n")).not.toMatch(/\btur\b/)
  })

  test("a sentence too wide for the section wraps at words", () => {
    const all = plain(render({ state: state({ tab: 6 }), width: 40, height: 20, wasteLoading: false }))
    expect(all.join("\n")).toMatch(/The daemon did not answer; R tries +│?\n.*again/)
  })

  test("empty tabs say what is missing instead of showing zeros", () => {
    const empty = (tab: number) => joined(render({ report: emptyReport(), state: state({ tab }) }))
    expect(empty(3)).toContain("No model usage in this range")
    expect(empty(4)).toContain("No tool calls in this range")
    expect(empty(5)).toContain("No sessions in this range")
  })
})

describe("UI-8 usage layout", () => {
  test("180x50 and 220x60 end in panel borders with no empty band and all real report panels visible", () => {
    for (const [width, height] of [[180, 50], [220, 60]] as const) {
      const lines = render({ width, height })
      expect(text(lines.at(-1)!).trimEnd()).toEndWith("┘")
      const all = joined(lines)
      for (const label of ["Per-day tokens", "Most used tools", "Top sessions", "Token mix", "Response load"]) expect(all).toContain(label)
      expect(all).not.toContain("Code change signals unavailable")
      expect(all).toContain("Streak 159d · 160d longest")
    }
  })

  test("calendar cells have balanced horizontal margins in their panel", () => {
    const lines = render({ width: 220, height: 60 })
    const row = lines.find((row) => row.some((span) => span.text === "Mo  "))!
    const t = text(row)
    const left = t.indexOf("│") + 2
    const right = t.indexOf("│", left) - 2
    const first = t.indexOf("Mo", left)
    const last = t.lastIndexOf("■", right)
    expect(Math.abs(first - left - (right - last - 1))).toBeLessThanOrEqual(3)
  })
})
