import { afterEach, describe, expect, test } from "bun:test"
import { tuiProblems } from "@mendcode/protocol/wire"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SAMPLE_STATS, computeSessionStats, EMPTY_USAGE } from "../src/view/session-stats"
import { STATS_CARD_DEFAULT, statsCard, statsCardParts } from "../src/view/stats-card"
import { setTheme } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

afterEach(() => { cleanTemps(); setTheme("mend") })

const AT = 1_800_000_000_000

async function scene({ width, height = 30, profile = {}, mode = "full" }: { width: number; height?: number; profile?: Partial<TuiProfile>; mode?: "full" | "balanced" }) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode, now: () => AT })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("hello", "hi there")
  return h
}
const rows = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))
let seq = 700
const usage = (h: Harness, turnId: string, body: Record<string, number>) =>
  h.app.onEvent({ type: "usage.recorded", sessionId: h.sessionId, seq: ++seq, at: AT, turnId, provider: "p", model: "gpt-6-luna", reasoning: 0, cacheWrite: 0, contextWindow: 100_000, ...body } as never)

describe("stats card", () => {
  test("one row per part with a value, label left and value right, in the card's width", () => {
    const lines = statsCard(statsCardParts(undefined), SAMPLE_STATS, 40).map((line) => line.map((span) => span.text).join(""))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const line of lines) expect(textWidth(line)).toBe(40)
    expect(lines.find((line) => line.startsWith("cache"))).toMatch(/94%/)
    expect(lines.find((line) => line.startsWith("ctx"))).toMatch(/14%/)
  })

  test("a narrow card falls back to the short form and then cuts, never overflows", () => {
    for (const width of [12, 20, 30]) {
      for (const line of statsCard(statsCardParts(STATS_CARD_DEFAULT), SAMPLE_STATS, width)) expect(textWidth(line.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
  })

  test("no calls yet says so; the part list keeps order, drops unknown and repeated names, and falls back to the default", () => {
    expect(statsCard(["cache"], computeSessionStats({ usage: EMPTY_USAGE }), 30)[0]!.map((span) => span.text).join("")).toBe("No model calls yet")
    expect(statsCardParts("ctx, bogus, cache, ctx")).toEqual(["ctx", "cache"])
    expect(statsCardParts("bogus")).toEqual(STATS_CARD_DEFAULT.split(","))
    expect(statsCardParts(undefined)).toEqual(STATS_CARD_DEFAULT.split(","))
  })
})

describe("profile validation", () => {
  test("topbarStats takes known part names only and at most 128 characters", () => {
    expect(tuiProblems({ topbarStats: "cache,ctx" })).toEqual([])
    expect(tuiProblems({ topbarStats: "" })).toEqual([])
    expect(tuiProblems({ topbarStats: "cache,nonsense" })[0]).toContain("topbarStats")
    expect(tuiProblems({ topbarStats: "cache,".repeat(40) })[0]).toContain("topbarStats")
  })
  test("activityParts accepts the stat parts", () => {
    expect(tuiProblems({ activityParts: "spinner,verb,cache,ctx" })).toEqual([])
    expect(tuiProblems({ activityParts: "spinner,nonsense" })).not.toEqual([])
  })
})

describe("surfaces draw the same figures", () => {
  test("top bar: topbarStats shows cache and ctx when the bar has room and the default bar shows neither", async () => {
    const plainBar = await scene({ width: 120 })
    usage(plainBar, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    expect(rows(plainBar)[0]).not.toContain("cache")
    const h = await scene({ width: 120, profile: { topbarStats: "cache,ctx" } })
    usage(h, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    expect(rows(h)[0]).toContain("cache 99%  ctx 21%")
  })

  test("top bar: the stats give way before the path does at 60 columns, and nothing overflows", async () => {
    const h = await scene({ width: 60, profile: { topbarStats: "cache,ctx,tokens,spend" } })
    usage(h, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    for (const line of rows(h)) expect(textWidth(line)).toBeLessThanOrEqual(60)
  })

  test("sidebar: a stats widget lists the registry rows and follows a new call", async () => {
    const h = await scene({ width: 200, height: 40, profile: { rightSidebar: true, sidebarWidgets: [{ type: "stats", title: "Stats", options: {} }] } as never })
    usage(h, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    const text = rows(h).join("\n")
    expect(text).toContain("Stats")
    expect(text).toMatch(/cache\s+99%/)
    expect(text).toMatch(/ctx\s+21%/)
    usage(h, ids("turn"), { input: 9_000, output: 0, cacheRead: 20_800 })
    expect(rows(h).join("\n")).toMatch(/cache\s+8\d%/)
  })

  test("sidebar: options.text picks the parts and their order", async () => {
    const h = await scene({ width: 200, height: 40, profile: { rightSidebar: true, sidebarWidgets: [{ type: "stats", title: "Stats", options: { text: "ctx,cache" } }] } as never })
    usage(h, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    const lines = rows(h)
    const ctx = lines.findIndex((line) => /\bctx\s+21%/.test(line))
    const cache = lines.findIndex((line) => /\bcache\s+99%/.test(line))
    expect(ctx).toBeGreaterThan(-1)
    expect(cache).toBeGreaterThan(ctx)
    expect(lines.join("\n")).not.toMatch(/\bcalls\b.*1/)
  })

  test("activity status: cache and ctx parts show the session's figures while a turn runs; the default status has neither", async () => {
    const turn = (h: Harness) => {
      const turnId = ids("turn")
      h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: ++seq, at: AT, turnId, queueId: ids("queue") } as never)
      h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: ++seq, at: AT, state: "generating", turnId } as never)
      usage(h, turnId, { input: 200, output: 0, cacheRead: 20_800 })
    }
    const placed = await scene({ width: 120, profile: { activityPlacement: "above", activityParts: "spinner,verb,cache,ctx" } as never })
    turn(placed)
    expect(rows(placed).join("\n")).toContain("cache 99% · ctx 21%")
    const plainStatus = await scene({ width: 120 })
    turn(plainStatus)
    const text = rows(plainStatus).join("\n")
    expect(text).toContain("Generating")
    expect(text).not.toContain("cache 99%")
  })

  test("footer: the default shows none of the stat parts; placed with /footer they carry the same figures", async () => {
    const h = await scene({ width: 120, mode: "balanced" })
    usage(h, ids("turn"), { input: 200, output: 0, cacheRead: 20_800 })
    const before = rows(h).join("\n")
    for (const word of ["cache 99%", "hit 99%", "ctx 21%"]) expect(before).not.toContain(word)
    h.app.applySettings({ onboarded: true, footer: ["state", "cache", "hit", "ctx"] } as never)
    const after = rows(h).at(-1)!
    expect(after).toContain("cache 99%")
    expect(after).toContain("hit 99%")
    expect(after).toContain("ctx 21%")
  })
})
