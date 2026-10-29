import { afterEach, describe, expect, test } from "bun:test"
import type { UsageSnapshot } from "@mendcode/extension-api"
import { CARDS } from "../src/docs-run"
import { NO_USAGE, usageSnapshot } from "../src/view/usage-snapshot"
import { computeSessionStats, EMPTY_USAGE } from "../src/view/session-stats"
import { appHarness, extension, scratch } from "./extensions-harness"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const made: Array<ReturnType<typeof scratch>> = []
const store = globalThis as unknown as { __ext?: Record<string, unknown> }
function layout() {
  const next = scratch()
  made.push(next)
  store.__ext = {}
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
  delete store.__ext
})

const quota = (provider: string, windows: Array<{ id: string; label: string; usedPercent: number; resetsAt?: number }>, fetchedAt = NOW) => ({ type: "quota.snapshot", gseq: 1, at: NOW, provider, windows, fetchedAt, source: "local test fixture" }) as never

describe("usageSnapshot", () => {
  test("nothing is known before anything arrived: no context, no quota, no invented zero", () => {
    const snapshot = usageSnapshot({ stats: computeSessionStats({ usage: EMPTY_USAGE }), quotas: [], now: NOW })
    expect(snapshot.quota).toEqual([])
    expect(snapshot.context).toBeUndefined()
    expect(snapshot.costMicros).toBeUndefined()
    expect(NO_USAGE.quota).toEqual([])
  })

  test("quota readings carry used and left apart, the reset, the age and whether they are stale; context follows the stats", () => {
    const stats = computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 36_800, contextLimit: 160_000 })
    const snapshot = usageSnapshot({
      stats,
      quotas: [
        quota("codex", [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * 86_400_000 }]) as never,
        quota("claude", [{ id: "five_hour", label: "5h", usedPercent: 4 }], NOW - 3 * HOUR) as never,
      ].map((event) => event as never),
      now: NOW,
    })
    expect(snapshot.context).toEqual({ usedPercent: 23, tokens: 36_800, limit: 160_000 })
    expect(snapshot.quota).toEqual([
      { provider: "codex", window: "7d", usedPercent: 8, leftPercent: 92, resetsAt: NOW + 5 * 86_400_000, observedAt: NOW, ageMs: 0, stale: false },
      { provider: "claude", window: "5h", usedPercent: 4, leftPercent: 96, observedAt: NOW - 3 * HOUR, ageMs: 3 * HOUR, stale: true },
    ])
  })
})

describe("api.usage() and the slot context", () => {
  test("an extension reads the same snapshot from api.usage() and from the footer slot's context, and it follows a new reading", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/probe.ts", extension("probe", `
      const seen = globalThis.__ext
      seen.first = api.usage()
      seen.frozenQuota = Array.isArray(api.usage().quota)
      api.slot("footer.right", (ctx) => { seen.ctx = ctx.usage; return undefined })
    `))
    const h = await appHarness({ dataDir, width: 100 })
    await h.start()
    const seen = store.__ext as { first: UsageSnapshot; ctx: UsageSnapshot; frozenQuota: boolean }
    expect(seen.first.quota).toEqual([])
    expect(seen.frozenQuota).toBe(true)
    h.app.onGlobal(quota("codex", [{ id: "secondary", label: "7d", usedPercent: 8 }]))
    h.message("question", "answer")
    h.app.render()
    expect(seen.ctx.quota).toMatchObject([{ provider: "codex", window: "7d", usedPercent: 8, leftPercent: 92, stale: false }])
  })
})

/** The example the `usage` card prints: the lines indented under "Minimal quota footer". */
function cardExample() {
  const text = CARDS.cards.find((card) => card.topic === "usage")!.text
  const block = /Minimal quota footer[^\n]*\n((?:  [^\n]*\n?)+)/.exec(text)
  expect(block).not.toBeNull()
  return block![1]!.split("\n").map((line) => line.slice(2)).join("\n")
}

describe("the quota footer the usage card shows", () => {
  const screen = async (events: unknown[]) => {
    const { dataDir, write } = layout()
    write("data/extensions/quota-footer.ts", cardExample())
    const h = await appHarness({ dataDir, width: 100, height: 30 })
    await h.start()
    for (const event of events) h.app.onGlobal(event as never)
    h.message("question", "answer")
    h.app.render()
    return h.text()
  }

  test("it loads, and with no reading at all every window says n/a, never 0% or 100%", async () => {
    const text = await screen([])
    expect(text).toContain("CODEX  7d n/a  5h n/a")
    expect(text).toContain("CLAUDE  7d n/a  5h n/a")
    expect(text).not.toMatch(/0% left|100% left/)
  })

  test("a fresh reading shows what is left and the reset countdown; a window the provider did not report stays n/a", async () => {
    const text = await screen([quota("codex", [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * 86_400_000 + 11 * HOUR }])])
    expect(text).toContain("CODEX  7d 92% left · reset 5d11h  5h n/a")
  })

  test("a stale reading keeps its number with a compact age instead of a reset time, and an old Claude row is not drawn as current", async () => {
    const text = await screen([
      quota("codex", [{ id: "secondary", label: "7d", usedPercent: 2, resetsAt: NOW + 5 * 86_400_000 }], NOW - 3 * HOUR),
      quota("claude", [{ id: "seven_day", label: "7d", usedPercent: 60 }], NOW - 26 * HOUR),
    ])
    expect(text).toContain("CODEX  7d 98% left ~3h  5h n/a")
    expect(text).not.toContain("reset 5d")
    expect(text).toContain("CLAUDE  7d 40% left ~1d  5h n/a")
    expect(text).not.toMatch(/\bold\b|stale/)
  })

  test("a window that already ended is n/a, whatever its old number was", async () => {
    const text = await screen([quota("codex", [{ id: "primary", label: "5h", usedPercent: 60, resetsAt: NOW - 60_000 }], NOW - 2 * HOUR)])
    expect(text).toContain("CODEX  7d n/a  5h n/a")
  })

  test("the example is what the card says it is: it names no file of another program", () => {
    expect(cardExample()).not.toMatch(/\.codex|\.claude|\.pi\b|readFileSync|fs\b/)
  })
})
