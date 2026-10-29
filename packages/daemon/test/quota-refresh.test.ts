import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import type { QuotaRefreshEntry, QuotaRefreshProvider } from "@mendcode/protocol/wire"
import { createQuotaRefresh, windowsSpent, type RefreshProbe } from "../src/quota-refresh"

const MIN = 60_000
const START = Date.UTC(2026, 9, 8, 12, 0, 0)
type Snapshot = { fetchedAt: number }

/** A schedule on a virtual clock with fakes for everything outside it: no provider, no timer of the machine. */
function scene(input: { entries?: QuotaRefreshEntry[]; fail?: () => boolean } = {}) {
  const clock = createVirtualClock(START)
  const state = {
    entries: input.entries ?? [{ provider: "codex" as QuotaRefreshProvider, everyMinutes: 15 }],
    active: true,
    limited: false,
    latest: undefined as Snapshot | undefined,
    sent: [] as Array<{ provider: string; model?: string }>,
    notices: [] as string[],
    reported: 0,
    fail: input.fail ?? (() => false),
  }
  const probeFor = (provider: QuotaRefreshProvider): RefreshProbe => async ({ model, report }) => {
    state.sent.push({ provider, ...(model ? { model } : {}) })
    if (state.fail()) throw new Error("[PROBE]: provider said no")
    state.reported += 1
    state.latest = { fetchedAt: clock.now() }
    report({ type: "quota.snapshot", provider, windows: [{ id: "primary", label: "5h", usedPercent: 10 }], fetchedAt: clock.now(), source: "test" })
  }
  const refresh = createQuotaRefresh({
    clock,
    entries: () => state.entries,
    active: () => state.active,
    latest: () => state.latest,
    limited: () => state.limited,
    probes: { codex: probeFor("codex"), claude: probeFor("claude") },
    report: () => {},
    notify: (text) => state.notices.push(text),
    // 0.5 puts the jitter at zero and the first probe 15 s after the first look.
    random: () => 0.5,
  })
  /** Moves time and looks once, like the schedule's own timer would. */
  const look = async (ms: number) => { clock.advance(ms); await refresh.tick() }
  return { clock, state, refresh, look }
}

describe("quota refresh: off unless the user listed a provider", () => {
  test("no entries means nothing is ever sent, however long it runs", async () => {
    const { state, look, refresh } = scene({ entries: [] })
    for (let i = 0; i < 50; i++) await look(10 * MIN)
    expect(state.sent).toEqual([])
    expect(refresh.status()).toEqual([])
  })

  test("a listed provider sends its first probe soon, not at the very first look", async () => {
    const { state, look } = scene()
    await look(0)
    expect(state.sent).toEqual([])
    await look(20_000)
    expect(state.sent).toEqual([{ provider: "codex" }])
  })
})

describe("quota refresh: schedule", () => {
  test("one probe per interval and not before", async () => {
    const { state, look } = scene()
    await look(0)
    await look(20_000)
    await look(14 * MIN)
    expect(state.sent).toHaveLength(1)
    await look(MIN + 1_000)
    expect(state.sent).toHaveLength(2)
  })

  test("the model of the entry reaches the probe", async () => {
    const { state, look } = scene({ entries: [{ provider: "claude", everyMinutes: 30, model: "claude-haiku" }] })
    await look(0)
    await look(30_000)
    expect(state.sent).toEqual([{ provider: "claude", model: "claude-haiku" }])
  })

  test("a reading from a real turn newer than the interval is as good as a probe: it is skipped", async () => {
    const { state, look, clock } = scene()
    state.latest = { fetchedAt: clock.now() - MIN }
    await look(0)
    await look(5 * MIN)
    expect(state.sent).toEqual([])
    // Once that reading is older than the interval the probe runs.
    await look(11 * MIN)
    await look(MIN)
    expect(state.sent).toHaveLength(1)
  })

  test("with no terminal attached and no turn running nothing is sent", async () => {
    const { state, look } = scene()
    state.active = false
    for (let i = 0; i < 10; i++) await look(10 * MIN)
    expect(state.sent).toEqual([])
    state.active = true
    await look(0)
    await look(20_000)
    expect(state.sent).toHaveLength(1)
  })

  test("while the provider is at its usage limit nothing is sent, and it resumes after", async () => {
    const { state, look, refresh } = scene()
    state.limited = true
    for (let i = 0; i < 10; i++) await look(10 * MIN)
    expect(state.sent).toEqual([])
    expect(refresh.status()[0]!.state).toBe("waiting")
    state.limited = false
    await look(0)
    await look(20_000)
    expect(state.sent).toHaveLength(1)
  })

  test("removing the entry stops the schedule at once", async () => {
    const { state, look } = scene()
    await look(0)
    state.entries = []
    for (let i = 0; i < 5; i++) await look(20 * MIN)
    expect(state.sent).toEqual([])
  })

  test("the schedule's own timer drives the looks", async () => {
    const { state, clock, refresh } = scene()
    refresh.start()
    for (let i = 0; i < 40; i++) { clock.advance(30_000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
    expect(state.sent.length).toBeGreaterThanOrEqual(1)
    refresh.stop()
    const before = state.sent.length
    clock.advance(60 * MIN)
    await Promise.resolve()
    expect(state.sent).toHaveLength(before)
  })
})

describe("quota refresh: failures", () => {
  test("a failure backs off by doubling, and the third in a row stops it with one notice", async () => {
    const { state, look, refresh } = scene({ fail: () => true })
    await look(0)
    await look(20_000)
    expect(state.sent).toHaveLength(1)
    // After the first failure the next probe waits two intervals, not one.
    await look(15 * MIN)
    expect(state.sent).toHaveLength(1)
    await look(16 * MIN)
    expect(state.sent).toHaveLength(2)
    // The second waits four.
    await look(45 * MIN)
    expect(state.sent).toHaveLength(2)
    await look(16 * MIN)
    expect(state.sent).toHaveLength(3)
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0]).toContain("stopped after 3 failed probes")
    expect(state.notices[0]).toContain("provider said no")
    // Stopped: hours later still nothing, and no second notice.
    for (let i = 0; i < 20; i++) await look(60 * MIN)
    expect(state.sent).toHaveLength(3)
    expect(state.notices).toHaveLength(1)
    expect(refresh.status()[0]!.state).toBe("stopped")
  })

  test("a success in between resets the count", async () => {
    let calls = 0
    const { state, look } = scene({ fail: () => ++calls % 2 === 1 })
    await look(0)
    await look(20_000)
    await look(31 * MIN)
    await look(31 * MIN)
    await look(31 * MIN)
    await look(31 * MIN)
    expect(state.sent.length).toBeGreaterThanOrEqual(4)
    expect(state.notices).toEqual([])
  })

  test("editing the entry starts a stopped provider again", async () => {
    const { state, look } = scene({ fail: () => true })
    await look(0)
    await look(20_000)
    await look(31 * MIN)
    await look(61 * MIN)
    expect(state.notices).toHaveLength(1)
    state.fail = () => false
    state.entries = [{ provider: "codex", everyMinutes: 20 }]
    await look(0)
    await look(20_000)
    expect(state.sent.at(-1)).toEqual({ provider: "codex" })
    expect(state.reported).toBe(1)
  })

  test("a probe that never answers is abandoned after 90 s and counts as a failure; the look itself never throws", async () => {
    const clock = createVirtualClock(START)
    const notices: string[] = []
    const refresh = createQuotaRefresh({
      clock, entries: () => [{ provider: "codex" }], active: () => true, latest: () => undefined, limited: () => false, report: () => {}, notify: (t) => notices.push(t), random: () => 0.5,
      probes: { codex: () => new Promise<void>(() => {}) },
    })
    await refresh.tick()
    clock.advance(20_000)
    const running = refresh.tick()
    clock.advance(90_000)
    await running
    const status = refresh.status()[0]!
    expect(status.probesToday).toBe(1)
    expect(status.lastError).toContain("timed out")
  })

  test("a provider with no probe on this engine says so once and stays stopped", async () => {
    const clock = createVirtualClock(START)
    const notices: string[] = []
    const refresh = createQuotaRefresh({ clock, entries: () => [{ provider: "claude" }], active: () => true, latest: () => undefined, limited: () => false, report: () => {}, notify: (t) => notices.push(t), probes: {} })
    for (let i = 0; i < 5; i++) await refresh.tick()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("no claude probe")
    expect(refresh.status()[0]!.state).toBe("stopped")
  })

  test("an error message that carries a secret is redacted in the notice and the status", async () => {
    const { state, look, refresh } = scene({ fail: () => true })
    state.fail = () => { throw new Error("[PROBE]: 401 with key sk-abcdefghijklmnopqrstuvwxyz0123456789") }
    for (let i = 0; i < 3; i++) { await look(0); await look(20_000); await look(70 * MIN) }
    expect(JSON.stringify(refresh.status())).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(state.notices.join(" ")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  })
})

describe("quota refresh: counters", () => {
  test("the status reports on or off, the interval, the last probe and the probes of today", async () => {
    const { look, refresh, clock } = scene({ entries: [{ provider: "codex", everyMinutes: 15 }] })
    expect(refresh.status()[0]).toMatchObject({ provider: "codex", everyMinutes: 15, state: "on", probesToday: 0 })
    await look(0)
    await look(20_000)
    const status = refresh.status()[0]!
    expect(status.probesToday).toBe(1)
    expect(status.lastProbeAt).toBe(clock.now())
    await look(16 * MIN)
    expect(refresh.status()[0]!.probesToday).toBe(2)
  })

  test("a failed probe counts too: it was sent", async () => {
    const { look, refresh } = scene({ fail: () => true })
    await look(0)
    await look(20_000)
    expect(refresh.status()[0]!.probesToday).toBe(1)
  })
})

describe("windowsSpent", () => {
  const now = START
  test("a spent window that has not reset, or a rejected status with an open window, is a limit", () => {
    expect(windowsSpent({ windows: [{ usedPercent: 100, resetsAt: now + MIN }] }, now)).toBe(true)
    expect(windowsSpent({ status: "rejected", windows: [{ usedPercent: 40, resetsAt: now + MIN }] }, now)).toBe(true)
  })
  test("a window that already reset, or one with room left, is not", () => {
    expect(windowsSpent({ windows: [{ usedPercent: 100, resetsAt: now - MIN }] }, now)).toBe(false)
    expect(windowsSpent({ status: "rejected", windows: [{ usedPercent: 100, resetsAt: now - MIN }] }, now)).toBe(false)
    expect(windowsSpent({ status: "allowed", windows: [{ usedPercent: 99 }] }, now)).toBe(false)
  })
})
