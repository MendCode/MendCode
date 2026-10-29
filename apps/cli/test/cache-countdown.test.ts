import { describe, expect, test } from "bun:test"
import { DEFAULT_FOOTER, FOOTER_OPT_IN, featureOn, type FooterSegment } from "@mendcode/protocol/wire"
import type { SessionId } from "@mendcode/protocol"
import { createCacheClock } from "../src/ui/app/cache-clock"
import { segmentSpans, type FooterInput } from "../src/view/footer"
import { glyphs } from "../src/ui/theme"

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 18, 12)
const text = (spans: ReturnType<typeof segmentSpans>) => spans.map((span) => span.text).join("")
const input = (warm: FooterInput["warm"], now = NOW): FooterInput => ({
  segments: ["warm" as FooterSegment], width: 120, glyphs: glyphs(), stateLabel: "", state: "idle" as never, dotOn: false, connection: "connected",
  permission: "ask", permissionLabel: "", quotas: [], now, notice: "", ...(warm ? { warm } : {}),
})

describe("the warm footer segment", () => {
  test("counts down the minutes left, amber at the end, says when the idle compaction packs first, and cold after the expiry", () => {
    expect(text(segmentSpans("warm", input({ expiresAt: NOW + 12 * MIN, tokens: 161_000 })))).toBe("cache 12m")
    expect(segmentSpans("warm", input({ expiresAt: NOW + 12 * MIN, tokens: 161_000 }))[1]!.fg).toBe("success")
    expect(segmentSpans("warm", input({ expiresAt: NOW + 90_000, tokens: 161_000 }))[1]).toMatchObject({ text: "2m", fg: "warning" })
    expect(text(segmentSpans("warm", input({ expiresAt: NOW + 12 * MIN, tokens: 161_000, idleAt: NOW + 11 * MIN })))).toBe("cache 12m · packs in 11m")
    expect(text(segmentSpans("warm", input({ expiresAt: NOW + 4 * MIN, tokens: 161_000, assumed: true })))).toBe("cache ~4m")
    expect(text(segmentSpans("warm", input({ expiresAt: NOW - 1, tokens: 161_000 })))).toBe("cache cold · next sends 161K")
    expect(segmentSpans("warm", input(undefined))).toEqual([])
  })

  test("only full allows it, no footer places it by itself, and a switch brings it to another tier", () => {
    expect(featureOn({}, "cache_countdown")).toBe(false)
    expect(featureOn({ tier: "balanced" }, "cache_countdown")).toBe(false)
    expect(featureOn({ tier: "full" }, "cache_countdown")).toBe(true)
    expect(featureOn({ tier: "balanced", features: { cache_countdown: true } }, "cache_countdown")).toBe(true)
    expect(DEFAULT_FOOTER).not.toContain("warm")
    expect(FOOTER_OPT_IN).toContain("warm")
  })
})

describe("the cache clock", () => {
  const session = "ses_1" as SessionId
  function harness(reply: unknown, ok = true) {
    const sent: unknown[] = []
    let frames = 0
    const clock = createCacheClock({ send: async (command) => { sent.push(command); return ok ? { ok: true, result: reply } : { ok: false, error: { code: "x", message: "no" } } as never }, requestFrame: () => void frames++ })
    return { clock, sent, frames: () => frames }
  }
  const usage = { contextTokens: 161_000, callAt: NOW - 3 * MIN }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("asks the daemon once per call, after the turn, and counts from when the provider received the call", async () => {
    const { clock, sent, frames } = harness({ limits: { idleCompaction: { scheduled: true, at: NOW + 1 * MIN, atTokens: 100_000, lifetimeMinutes: 5, lifetimeSource: "documented" } } })
    expect(clock.read(session, usage, true)).toBeUndefined()
    expect(sent).toHaveLength(0)
    expect(clock.read(session, usage, false)).toBeUndefined()
    await tick()
    expect(sent).toEqual([{ type: "context.recent", sessionId: session, limit: 1 }])
    expect(frames()).toBe(1)
    expect(clock.read(session, usage, false)).toEqual({ expiresAt: NOW + 2 * MIN, tokens: 161_000, idleAt: NOW + MIN })
    expect(clock.read(session, usage, false)).toBeDefined()
    expect(sent).toHaveLength(1)
  })

  test("nothing without a stated lifetime, for a small context, or when the daemon does not answer; an assumed lifetime is marked", async () => {
    const unknown = harness({ limits: { idleCompaction: { scheduled: false, reason: "unknown-lifetime", atTokens: 100_000 } } })
    unknown.clock.read(session, usage, false)
    await tick()
    expect(unknown.clock.read(session, usage, false)).toBeUndefined()
    expect(unknown.clock.read(session, { contextTokens: 5_000, callAt: NOW }, false)).toBeUndefined()
    const failed = harness(undefined, false)
    failed.clock.read(session, usage, false)
    await tick()
    expect(failed.clock.read(session, usage, false)).toBeUndefined()
    const assumed = harness({ limits: { idleCompaction: { scheduled: false, reason: "below-threshold", atTokens: 200_000, lifetimeMinutes: 5, lifetimeSource: "assumed" } } })
    assumed.clock.read(session, usage, false)
    await tick()
    expect(assumed.clock.read(session, usage, false)).toEqual({ expiresAt: NOW + 2 * MIN, tokens: 161_000, assumed: true })
  })
})
