import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Clock, SessionEventDraft } from "@mendcode/kernel"
import { Command, createIdFactory, isReadOnlyCommand, SessionEvent, type GlobalEvent, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { createUsageLimit, RESET_GRACE_MS } from "../src/usage-limit"
import { exhaustedReset, parseResetTime } from "../src/usage-limit-reset"
import { callTool, boot, jumpClock, openSession, stop, until, type NativeHarness, type Step } from "./native-harness"

const ids = createIdFactory()
const HOUR = 3_600_000
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("reset times", () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0)

  test("an epoch, a countdown or a wait the provider names", () => {
    expect(parseResetTime('{"error":{"type":"usage_limit_reached","resets_at":1791036000}}', now)).toBe(1_791_036_000_000)
    expect(parseResetTime('{"error":{"type":"usage_limit_reached","resets_in_seconds":5400}}', now)).toBe(now + 5_400_000)
    expect(parseResetTime("Claude AI usage limit reached|1791036000", now)).toBe(1_791_036_000_000)
    expect(parseResetTime("You have hit your usage limit. Try again in 3h 20m.", now)).toBe(now + 3 * HOUR + 20 * 60_000)
    expect(parseResetTime("rate limit, retry after 45 seconds", now)).toBe(now + 45_000)
  })

  test("a clock time in the zone the message names, and the next one if today's has passed", () => {
    // 2:10 AM in Panama (UTC-5, no daylight saving) is 07:10 UTC: 12:00 UTC is already past it, so tomorrow's.
    expect(parseResetTime("5-hour limit reached ∙ resets 2:10 AM (America/Panama)", now)).toBe(Date.UTC(2026, 9, 4, 7, 10))
    expect(parseResetTime("You've hit your limit · resets 9pm (America/Panama)", now)).toBe(Date.UTC(2026, 9, 4, 2, 0))
    expect(parseResetTime("limit reached, resets Oct 9, 9am (UTC)", now)).toBe(Date.UTC(2026, 9, 9, 9, 0))
  })

  test("a clock time without a zone is the daemon's own", () => {
    const at = parseResetTime("usage limit reached. resets at 5pm", Date.now())!
    const date = new Date(at)
    expect([date.getHours(), date.getMinutes()]).toEqual([17, 0])
    expect(at).toBeGreaterThan(Date.now())
    expect(at - Date.now()).toBeLessThanOrEqual(24 * HOUR + HOUR)
  })

  test("nothing, the past, an unknown zone and a far future give no time", () => {
    expect(parseResetTime("usage limit reached", now)).toBeUndefined()
    expect(parseResetTime('{"resets_at":1000000000}', now)).toBeUndefined()
    expect(parseResetTime("resets 2am (Mars/Olympus)", now)).toBeUndefined()
    expect(parseResetTime('{"resets_in_seconds":99999999}', now)).toBeUndefined()
  })

  test("the quota the daemon tracks tells when a spent window resets, the provider's own first", () => {
    const snapshot = (provider: string, windows: Array<{ used: number; resetsAt?: number }>, fetchedAt = now - 1): Extract<GlobalEvent, { type: "quota.snapshot" }> => ({
      gseq: 1, at: 1, type: "quota.snapshot", provider, fetchedAt, source: "test",
      windows: windows.map((window, index) => ({ id: `w${index}`, label: "5h", usedPercent: window.used, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) })),
    })
    const claude = snapshot("claude", [{ used: 100, resetsAt: now + HOUR }, { used: 40, resetsAt: now + 100 * HOUR }])
    const codex = snapshot("codex", [{ used: 100, resetsAt: now + 2 * HOUR }, { used: 100, resetsAt: now + 5 * HOUR }], now)
    expect(exhaustedReset([claude, codex], now, "claude-sonnet")).toBe(now + HOUR)
    // Every spent window must reset: the later one counts.
    expect(exhaustedReset([claude, codex], now, "codex")).toBe(now + 5 * HOUR)
    expect(exhaustedReset([claude, codex], now)).toBe(now + 5 * HOUR)
    expect(exhaustedReset([codex], now, "claude")).toBeUndefined()
    expect(exhaustedReset([snapshot("claude", [{ used: 100, resetsAt: now + HOUR }], now - HOUR)], now, "claude")).toBeUndefined()
    expect(exhaustedReset([snapshot("claude", [{ used: 60, resetsAt: now + HOUR }])], now)).toBeUndefined()
    expect(exhaustedReset([snapshot("claude", [{ used: 100, resetsAt: now - HOUR }])], now)).toBeUndefined()
  })
})

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeClock(start: number) {
  let current = start
  const timers = new Set<{ at: number; run: () => void }>()
  const clock: Clock = {
    now: () => current,
    setTimer(ms, callback) {
      const timer = { at: current + ms, run: callback }
      timers.add(timer)
      return { cancel: () => void timers.delete(timer) }
    },
  }
  return {
    clock,
    pending: () => timers.size,
    async advance(ms: number) {
      current += ms
      for (const timer of [...timers].filter((candidate) => candidate.at <= current).sort((a, b) => a.at - b.at)) {
        timers.delete(timer)
        timer.run()
      }
      await flush()
    },
  }
}

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const LIMIT = "[PROVIDER]: openai 429 usage_limit_reached"

type SetupOptions = {
  dir?: string
  sessionId?: SessionId
  resume?: (sessionId: SessionId) => Promise<boolean>
  /** The `usage_resume` feature; on (armed by default) when absent. */
  armed?: () => boolean
  model?: () => string | undefined
  draftSince?: (sessionId: SessionId, since: number) => boolean
  quotas?: () => Extract<GlobalEvent, { type: "quota.snapshot" }>[]
}

function setup(options: SetupOptions = {}) {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "mend-usage-limit-"))
  if (!options.dir) dirs.push(dir)
  const time = fakeClock(NOW)
  const store = openStore({ dir, now: time.clock.now })
  stores.push(store)
  const sessionId = options.sessionId ?? ids("session")
  if (!store.hasSession(sessionId)) store.createSession({ id: sessionId, directory: "/repo", title: "t" })
  const emitted: SessionEventDraft[] = []
  const resumed: SessionId[] = []
  const manager = createUsageLimit({
    store,
    clock: time.clock,
    emit: (event) => void emitted.push(event),
    resume: options.resume ?? (async (id) => (resumed.push(id), true)),
    quotas: options.quotas ?? (() => []),
    log: () => {},
    ...(options.armed ? { armed: options.armed } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.draftSince ? { draftSince: options.draftSince } : {}),
  })
  const states = () => emitted.flatMap((event) => (event.type === "usage.limit" ? [event.state] : []))
  const fail = (message: string, id = sessionId, code = "provider_error") => manager.observe({ type: "turn.failed", sessionId: id, turnId: ids("turn"), seq: 1, at: NOW, error: { code, message } } as SessionEvent)
  return { dir, time, store, sessionId, emitted, resumed, manager, states, fail }
}

describe("usage limit pause", () => {
  test("losing the paused model asks instead of sending into the fallback", async () => {
    let model: string | undefined = "subscription-model"
    const missing = setup({ model: () => model })
    missing.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    model = undefined
    await missing.time.advance(HOUR + RESET_GRACE_MS)
    expect(missing.resumed).toEqual([])
  })
  test("a turn that fails on a spent quota opens a pause with the reset time, armed by default; other failures do not", () => {
    const t = setup()
    t.fail("[PROVIDER]: openai 500 internal error")
    expect(t.store.usagePauses.get(t.sessionId)).toBeUndefined()
    t.fail(`${LIMIT} {"resets_in_seconds":7200}`)
    expect(t.store.usagePauses.get(t.sessionId)).toMatchObject({ state: "scheduled", resetsAt: NOW + 2 * HOUR })
    expect(t.emitted.at(-1)).toMatchObject({ type: "usage.limit", state: "scheduled", resetsAt: NOW + 2 * HOUR, by: "system" })
    // The provider's prefix is dropped and the text is cut for the event.
    expect((t.emitted.at(-1) as { message: string }).message.startsWith("openai 429")).toBe(true)
  })

  test("secrets in the failure message never reach the event or the store", () => {
    const t = setup()
    t.fail(`${LIMIT} key sk-abcdefghijklmnopqrstuvwxyz0123456789 resets_in_seconds: 600`)
    const saved = t.store.usagePauses.get(t.sessionId)!
    expect(saved.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789")
  })

  test("a child task's failure does not pause anything", () => {
    const t = setup()
    const child = ids("session")
    t.store.createSession({ id: child, directory: "/repo", title: "task", parentId: t.sessionId })
    t.fail(LIMIT, child)
    expect(t.store.usagePauses.get(child)).toBeUndefined()
  })

  test("with the feature off the pause only asks; Resume at reset arms it, and at the reset the turn continues once and the pause is gone", async () => {
    const t = setup({ armed: () => false })
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("paused")
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "schedule" } as never)).toMatchObject({ ok: true, result: { state: "scheduled", resetsAt: NOW + HOUR } })
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("scheduled")
    await t.time.advance(HOUR - 1_000)
    expect(t.resumed).toEqual([])
    await t.time.advance(1_000 + RESET_GRACE_MS)
    expect(t.resumed).toEqual([t.sessionId])
    expect(t.states()).toEqual(["paused", "scheduled", "resumed"])
    expect(t.store.usagePauses.get(t.sessionId)).toBeUndefined()
    expect(t.time.pending()).toBe(0)
  })

  test("armed by default: with no click the turn resumes once at the reset, and only after the grace", async () => {
    const t = setup()
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    expect(t.states()).toEqual(["scheduled"])
    await t.time.advance(HOUR)
    expect(t.resumed).toEqual([])
    await t.time.advance(RESET_GRACE_MS)
    expect(t.resumed).toEqual([t.sessionId])
    expect(t.states()).toEqual(["scheduled", "resumed"])
    await t.time.advance(10 * HOUR)
    expect(t.resumed).toEqual([t.sessionId])
  })

  test("without a reset time nothing is armed, whatever the default", async () => {
    const t = setup()
    t.fail(LIMIT)
    expect(t.store.usagePauses.get(t.sessionId)).toMatchObject({ state: "paused" })
    expect(t.time.pending()).toBe(0)
    await t.time.advance(48 * HOUR)
    expect(t.resumed).toEqual([])
  })

  test("Cancel disarms the pause: at the reset it only becomes ready, and Resume at reset arms it again", async () => {
    const t = setup()
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "cancel" } as never)).toMatchObject({ ok: true, result: { state: "paused", resetsAt: NOW + HOUR } })
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("paused")
    // Cancelling something that is not armed changes nothing.
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "cancel" } as never)).toMatchObject({ ok: true, result: { state: "paused" } })
    expect(t.states()).toEqual(["scheduled", "paused"])
    await t.time.advance(HOUR + RESET_GRACE_MS)
    expect(t.resumed).toEqual([])
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("ready")

    const again = setup()
    again.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    await again.manager.handle({ type: "usage.limit", sessionId: again.sessionId, action: "cancel" } as never)
    await again.manager.handle({ type: "usage.limit", sessionId: again.sessionId, action: "schedule" } as never)
    await again.time.advance(HOUR + RESET_GRACE_MS)
    expect(again.resumed).toEqual([again.sessionId])
  })

  test("the reset is re-checked first: a quota the provider still reports spent waits for its own reset", async () => {
    let windows: Array<{ resetsAt: number; used: number }> = []
    const snapshot = () => [{ gseq: 1, at: NOW, type: "quota.snapshot" as const, provider: "claude", fetchedAt: NOW + HOUR, source: "test", windows: windows.map((window, index) => ({ id: `w${index}`, label: "7d", usedPercent: window.used, resetsAt: window.resetsAt })) }]
    const t = setup({ quotas: snapshot })
    t.manager.observe({ type: "usage.recorded", sessionId: t.sessionId, provider: "claude" } as SessionEvent)
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    // The 5-hour window resets on time but the weekly one is spent as well.
    windows = [{ resetsAt: NOW + 5 * HOUR, used: 100 }]
    await t.time.advance(HOUR + RESET_GRACE_MS)
    expect(t.resumed).toEqual([])
    expect(t.store.usagePauses.get(t.sessionId)).toMatchObject({ state: "scheduled", resetsAt: NOW + 5 * HOUR })
    expect((t.emitted.at(-1) as { resetsAt?: number }).resetsAt).toBe(NOW + 5 * HOUR)
    windows = []
    await t.time.advance(4 * HOUR + RESET_GRACE_MS)
    expect(t.resumed).toEqual([t.sessionId])
  })

  test("a changed model or a draft the user typed makes the daemon ask instead of sending", async () => {
    let model: string | undefined = "claude-sonnet"
    const changed = setup({ model: () => model })
    changed.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    expect(changed.store.usagePauses.get(changed.sessionId)?.model).toBe("claude-sonnet")
    model = "gpt-5"
    await changed.time.advance(HOUR + RESET_GRACE_MS)
    expect(changed.resumed).toEqual([])
    expect(changed.store.usagePauses.get(changed.sessionId)?.state).toBe("ready")

    const drafted = setup({ draftSince: (_session, since) => since <= NOW })
    drafted.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    await drafted.time.advance(HOUR + RESET_GRACE_MS)
    expect(drafted.resumed).toEqual([])
    expect(drafted.store.usagePauses.get(drafted.sessionId)?.state).toBe("ready")

  })

  test("switching the model while armed asks at once; the same model keeps it armed", async () => {
    let model: string | undefined = "claude-sonnet"
    const t = setup({ model: () => model })
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    t.manager.revalidate(t.sessionId)
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("scheduled")
    model = "gpt-5"
    t.manager.revalidate(t.sessionId)
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("paused")
    await t.time.advance(HOUR + RESET_GRACE_MS)
    expect(t.resumed).toEqual([])
  })

  test("only the paused turn is resumed: another turn starting first makes the pause stale; the resumed turn's own start does not", async () => {
    const t = setup()
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    const paused = t.store.usagePauses.get(t.sessionId)!
    t.manager.observe({ type: "turn.started", sessionId: t.sessionId, turnId: paused.turnId, queueId: ids("queue"), seq: 2, at: NOW } as SessionEvent)
    expect(t.store.usagePauses.get(t.sessionId)).toBeDefined()
    t.manager.observe({ type: "turn.started", sessionId: t.sessionId, turnId: ids("turn"), queueId: ids("queue"), seq: 3, at: NOW } as SessionEvent)
    expect(t.store.usagePauses.get(t.sessionId)).toBeUndefined()
    expect(t.states().at(-1)).toBe("cleared")
    await t.time.advance(2 * HOUR)
    expect(t.resumed).toEqual([])
  })

  test("a click and the timer at the same moment send the resume once", async () => {
    let release: (started: boolean) => void = () => {}
    const sent: SessionId[] = []
    const t = setup({ resume: (id) => new Promise<boolean>((resolve) => { sent.push(id); release = resolve }) })
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    await t.time.advance(HOUR + RESET_GRACE_MS)
    expect(sent).toEqual([t.sessionId])
    // The durable dispatch receipt remains until acknowledgement; a concurrent click cannot dispatch twice.
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("ready")
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "resume" } as never)).toMatchObject({ ok: false, code: "busy" })
    release(true)
    await flush()
    expect(sent).toEqual([t.sessionId])
    expect(t.store.usagePauses.get(t.sessionId)).toBeUndefined()
  })

  test("restart before dispatch ACK preserves a ready receipt and never sends twice automatically", async () => {
    let release: (value: boolean) => void = () => {}
    const first = setup({ resume: () => new Promise<boolean>((resolve) => { release = resolve }) })
    first.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    await first.time.advance(HOUR + RESET_GRACE_MS)
    first.manager.dispose()
    first.store.close()
    stores.splice(stores.indexOf(first.store), 1)
    const second = setup({ dir: first.dir, sessionId: first.sessionId })
    second.manager.recover()
    await second.time.advance(2 * HOUR)
    expect(second.resumed).toEqual([])
    expect(second.store.usagePauses.get(second.sessionId)?.state).toBe("ready")
    release(true)
    await flush()
    expect(second.store.usagePauses.get(second.sessionId)?.state).toBe("ready")
    expect(await second.manager.handle({ type: "usage.limit", sessionId: second.sessionId, action: "resume" } as never)).toMatchObject({ ok: true })
  })

  test("after three automatic resumes in a row that each hit a new window, the daemon asks", async () => {
    const t = setup()
    for (let round = 1; round <= 3; round++) {
      t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
      expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("scheduled")
      await t.time.advance(HOUR + RESET_GRACE_MS)
      expect(t.resumed).toHaveLength(round)
    }
    t.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("paused")
    await t.time.advance(HOUR + RESET_GRACE_MS)
    expect(t.resumed).toHaveLength(3)
  })

  test("a scheduled resume survives a restart: the next daemon re-arms it, and one whose reset passed meanwhile resumes at boot", async () => {
    const first = setup()
    first.fail(`${LIMIT} {"resets_in_seconds":3600}`)
    first.manager.dispose()
    first.store.close()
    stores.splice(stores.indexOf(first.store), 1)

    const second = setup({ dir: first.dir, sessionId: first.sessionId })
    second.manager.recover()
    expect(second.time.pending()).toBe(1)
    await second.time.advance(HOUR + RESET_GRACE_MS)
    expect(second.resumed).toEqual([first.sessionId])

    // A pause whose reset passed while the daemon was down continues at boot.
    second.fail(`${LIMIT} {"resets_in_seconds":60}`)
    expect(second.store.usagePauses.get(first.sessionId)?.state).toBe("scheduled")
    second.manager.dispose()
    second.store.close()
    stores.splice(stores.indexOf(second.store), 1)
    const late = setup({ dir: first.dir, sessionId: first.sessionId })
    await late.time.advance(2 * HOUR)
    late.manager.recover()
    await flush()
    expect(late.resumed).toEqual([first.sessionId])
  })

  test("Snooze disarms and hides the pause; at the reset it becomes ready and waits for the user instead of resuming", async () => {
    const t = setup()
    t.fail(`${LIMIT} {"resets_in_seconds":1800}`)
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "snooze" } as never)).toMatchObject({ ok: true, result: { state: "snoozed" } })
    await t.time.advance(30 * 60_000 + RESET_GRACE_MS)
    expect(t.resumed).toEqual([])
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("ready")
    expect(t.states()).toEqual(["scheduled", "snoozed", "ready"])
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "resume" } as never)).toMatchObject({ ok: true, result: { state: "resumed" } })
    expect(t.resumed).toEqual([t.sessionId])
  })

  test("without a reset time only Resume now and Dismiss work; scheduling is refused", async () => {
    const t = setup()
    t.fail(LIMIT)
    expect(t.store.usagePauses.get(t.sessionId)?.resetsAt).toBeUndefined()
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "schedule" } as never)).toMatchObject({ ok: false, code: "unsupported" })
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "dismiss" } as never)).toMatchObject({ ok: true })
    expect(t.states()).toEqual(["paused", "cleared"])
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "resume" } as never)).toMatchObject({ ok: false, code: "target_mismatch" })
  })

  test("the user typing something else forgets the pause; the daemon's own steerings and notices do not", () => {
    const t = setup()
    t.fail(`${LIMIT} {"resets_in_seconds":600}`)
    const item = (meta?: Record<string, unknown>) => t.manager.observe({ type: "item.started", sessionId: t.sessionId, seq: 2, at: NOW, turnId: ids("turn"), itemId: ids("item"), kind: "user_message", ...(meta ? { meta } : {}) } as SessionEvent)
    item({ usageLimit: "resume" })
    item({ notice: true })
    item({ goal: "continuation" })
    expect(t.store.usagePauses.get(t.sessionId)).toBeDefined()
    item()
    expect(t.store.usagePauses.get(t.sessionId)).toBeUndefined()
    expect(t.states().at(-1)).toBe("cleared")
  })

  test("a resume the session cannot take leaves the pause ready; a resumed turn that hits the next window waits for it too", async () => {
    let accept = false
    const t = setup({ resume: async () => accept })
    t.fail(`${LIMIT} {"resets_in_seconds":600}`)
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "resume" } as never)).toMatchObject({ ok: false, code: "busy" })
    expect(t.store.usagePauses.get(t.sessionId)?.state).toBe("ready")
    accept = true
    await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "schedule" } as never)
    expect(await t.manager.handle({ type: "usage.limit", sessionId: t.sessionId, action: "resume" } as never)).toMatchObject({ ok: true })
    // The resumed turn fails on the weekly window: no new choice is asked, the daemon waits for that reset as well.
    t.fail(`${LIMIT} {"resets_in_seconds":86400}`)
    expect(t.store.usagePauses.get(t.sessionId)).toMatchObject({ state: "scheduled" })
  })
})

describe("usage limit protocol", () => {
  test("the command and the event parse; the command changes state, so a read-only peer is refused", () => {
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "usage.limit", sessionId: ids("session"), action: "snooze" }).success).toBe(true)
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "usage.limit", sessionId: ids("session"), action: "later" }).success).toBe(false)
    expect(SessionEvent.safeParse({ type: "usage.limit", sessionId: ids("session"), seq: 1, at: 1, state: "scheduled", message: "limit", resetsAt: 5, by: "user" }).success).toBe(true)
    expect(SessionEvent.safeParse({ type: "usage.limit", sessionId: ids("session"), seq: 1, at: 1, state: "later", message: "limit", by: "user" }).success).toBe(false)
    expect(isReadOnlyCommand("usage.limit")).toBe(false)
  })
})

describe("usage limit in the daemon", () => {
  const harnesses: NativeHarness[] = []
  afterEach(async () => {
    for (const h of harnesses.splice(0).reverse()) await h.cleanup()
  })
  const limited = (seconds = 1): Step => () => {
    throw new Error(`[PROVIDER]: scripted 429 usage_limit_reached {"resets_in_seconds":${seconds}}`)
  }
  const start = async (steps: Step[], options: { dir?: string; project?: string; clock?: Clock } = {}) => {
    const h = await boot({ steps, ...options })
    harnesses.push(h)
    return h
  }
  /** The reset is a minute away, so only the clock passing it (and the grace after it) can resume the turn: the test moves the clock there. */
  const RESET_SECONDS = 60
  const PAST_RESET_MS = RESET_SECONDS * 1_000 + RESET_GRACE_MS
  const states = (h: NativeHarness, sessionId: SessionId) => h.store.readAfter(sessionId, 0, 10_000).flatMap((event) => (event.type === "usage.limit" ? [event.state] : []))
  const lastUser = (h: NativeHarness, index: number) => (h.requests[index]!.messages.findLast((message) => message.role === "user") as { content: string }).content

  test("a limited turn is paused with auto-resume armed, and at the reset it continues the same conversation by itself", async () => {
    const clock = jumpClock()
    const h = await start([limited(RESET_SECONDS), stop("carried on")], { clock })
    const sessionId = await openSession(h)
    await h.client.send({ type: "user.submit", sessionId, text: "refactor the parser", attachments: [] })
    await until(() => states(h, sessionId).includes("scheduled"))
    const paused = h.store.readAfter(sessionId, 0, 10_000).find((event) => event.type === "usage.limit")
    expect(paused).toMatchObject({ state: "scheduled", by: "system" })
    expect((paused as { resetsAt?: number }).resetsAt).toBeGreaterThan(clock.now())
    // Nothing resumes before the reset: the model was asked once and the pause stands.
    expect(h.requests).toHaveLength(1)
    expect(states(h, sessionId)).toEqual(["scheduled"])
    clock.jump(PAST_RESET_MS)
    await until(() => states(h, sessionId).includes("resumed"), 12_000)
    await until(() => h.requests.length === 2)
    expect(lastUser(h, 1)).toContain("usage limit has reset")
    // The earlier request is still in the history the second one carries.
    expect(JSON.stringify(h.requests[1]!.messages)).toContain("refactor the parser")
    expect(h.store.usagePauses.get(sessionId)).toBeUndefined()
    expect(states(h, sessionId)).toEqual(["scheduled", "resumed"])
  }, 20_000)

  test("`/tier usage_resume off` (features.usage_resume) leaves the pause to the user, and Cancel and Resume at reset still work", async () => {
    const h = await start([limited(3600)])
    h.store.settings.set({ features: { usage_resume: false } })
    const sessionId = await openSession(h)
    await h.client.send({ type: "user.submit", sessionId, text: "long job", attachments: [] })
    await until(() => states(h, sessionId).includes("paused"))
    expect(h.store.usagePauses.get(sessionId)).toMatchObject({ state: "paused" })
    expect(await h.client.send({ type: "usage.limit", sessionId, action: "schedule" })).toMatchObject({ ok: true, result: { state: "scheduled" } })
    expect(await h.client.send({ type: "usage.limit", sessionId, action: "cancel" })).toMatchObject({ ok: true, result: { state: "paused" } })
    expect(states(h, sessionId)).toEqual(["paused", "scheduled", "paused"])
  })

  test("the schedule survives a daemon restart", async () => {
    const clock = jumpClock()
    const first = await start([limited(RESET_SECONDS)], { clock })
    const sessionId = await openSession(first)
    await first.client.send({ type: "user.submit", sessionId, text: "keep going", attachments: [] })
    await until(() => states(first, sessionId).includes("scheduled"))
    first.client.close()
    await first.daemon.stop()
    const second = await start([stop("back after the restart")], { dir: first.dir, project: first.project, clock })
    expect(second.store.usagePauses.get(sessionId)).toMatchObject({ state: "scheduled" })
    expect(second.requests).toHaveLength(0)
    clock.jump(PAST_RESET_MS)
    await until(() => states(second, sessionId).includes("resumed"), 12_000)
    await until(() => second.requests.length === 1)
    expect(lastUser(second, 0)).toContain("usage limit has reset")
  }, 25_000)

  test("a limit with a tool call mid-turn still pauses", async () => {
    const h = await start([callTool("probe", {}), limited(3600)])
    const sessionId = await openSession(h)
    await h.client.send({ type: "user.submit", sessionId, text: "probe then stop", attachments: [] })
    await until(() => states(h, sessionId).includes("scheduled"))
    expect(h.store.readAfter(sessionId, 0, 10_000).some((event) => event.type === "turn.failed")).toBe(true)
  })
})
