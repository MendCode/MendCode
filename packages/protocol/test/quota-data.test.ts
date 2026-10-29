import { expect, test } from "bun:test"
import { quotaFresh, quotaReadings, shortSpan, QUOTA_MAX_AGE_MS } from "../src/quota-data"
import { effectiveSettings, featureOn, FEATURES, type Tier } from "../src/tier-data"

test("quota freshness rejects future, non-finite and old observations", () => {
  const now = 1_800_000_000_000
  expect(quotaFresh(now, now)).toBe(true)
  expect(quotaFresh(now - QUOTA_MAX_AGE_MS, now)).toBe(true)
  expect(quotaFresh(now - QUOTA_MAX_AGE_MS - 1, now)).toBe(false)
  expect(quotaFresh(now + 1, now)).toBe(false)
  expect(quotaFresh(NaN, now)).toBe(false)
})

const snapshot = (fetchedAt: number, windows: Array<{ id: string; label: string; usedPercent: number; resetsAt?: number }>) => ({ provider: "codex", windows, fetchedAt, source: "test" })

test("quota readings say used and left apart, carry their age, and mark an old or ended window stale", () => {
  const now = 1_800_000_000_000
  const [week, five] = quotaReadings([snapshot(now - 60_000, [{ id: "secondary", label: "7d", usedPercent: 7.6, resetsAt: now + 5 * 86_400_000 }, { id: "primary", label: "5h", usedPercent: 100 }])], now)
  expect(week).toMatchObject({ provider: "codex", window: "7d", usedPercent: 8, leftPercent: 92, ageMs: 60_000, stale: false, observedAt: now - 60_000 })
  expect(five).toMatchObject({ usedPercent: 100, leftPercent: 0, stale: false })
  const [old] = quotaReadings([snapshot(now - 3 * 3_600_000, [{ id: "secondary", label: "7d", usedPercent: 2 }])], now)
  expect(old).toMatchObject({ usedPercent: 2, leftPercent: 98, ageMs: 3 * 3_600_000, stale: true })
  const [ended] = quotaReadings([snapshot(now - 1_000, [{ id: "secondary", label: "7d", usedPercent: 40, resetsAt: now - 1 }])], now)
  expect(ended!.stale).toBe(true)
  expect(quotaReadings([], now)).toEqual([])
  expect(quotaReadings([snapshot(now, [])], now)).toEqual([])
})

test("short spans use the two largest units", () => {
  expect(shortSpan(5 * 86_400_000 + 11 * 3_600_000 + 59_000)).toBe("5d11h")
  expect(shortSpan(2 * 86_400_000)).toBe("2d")
  expect(shortSpan(3 * 3_600_000 + 20 * 60_000)).toBe("3h20m")
  expect(shortSpan(45 * 60_000)).toBe("45m")
  expect(shortSpan(10_000)).toBe("<1m")
  expect(shortSpan(-5)).toBe("<1m")
})

test("continuity stays free in every tier, while minimalist omits optional tools and review chrome", () => {
  for (const tier of ["minimalist", "balanced", "full"] as Tier[]) expect(featureOn({ tier }, "usage_resume")).toBe(true)
  expect(FEATURES.usage_resume.cost).toEqual([])
  expect(featureOn({ tier: "minimalist" }, "review_order")).toBe(false)
  expect(featureOn({ tier: "minimalist", features: { review_order: true } }, "review_order")).toBe(true)
  const minimal = effectiveSettings({ tier: "minimalist" as const, tools: {} as Record<string, boolean>, experimental: {} as Record<string, unknown> })
  expect(minimal.tools["mcp__*"]).toBe(false)
  expect(minimal.tools["graph_*"]).toBe(false)
  expect(minimal.experimental.reasoning_auto).toBe(false)
})
