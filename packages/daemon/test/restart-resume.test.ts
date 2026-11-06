import { describe, expect, test } from "bun:test"
import type { QueueId, SessionEvent, SessionId } from "@mendcode/protocol"
import type { PendingResume } from "@mendcode/store"
import { createRestartResume, RESUME_MAX_AGE_MS, RESUME_MAX_ATTEMPTS, RESUME_MAX_PER_START, RESUME_TEXT } from "../src/restart-resume"

const id = (value: string) => value as SessionId
const interrupted = (turnId: string, ...extra: SessionEvent[]) => [{ type: "turn.started", turnId }, ...extra, { type: "turn.interrupted", turnId, reason: "restart", cause: "daemon_shutdown" }] as unknown as SessionEvent[]

function setup(overrides: { enabled?: boolean; sessions?: Record<string, { turn?: SessionEvent[]; launcher?: string }>; resume?: (sessionId: string) => boolean } = {}) {
  const rows = new Map<string, PendingResume>()
  const sessions = overrides.sessions ?? {}
  const told: Array<{ launcher: string; text: string }> = []
  const resumed: Array<{ sessionId: string; text: string }> = []
  let time = 1_000_000
  const resumer = createRestartResume({
    store: {
      resumes: {
        put: (entry) => void (rows.has(entry.sessionId) || rows.set(entry.sessionId, entry)),
        list: (limit) => [...rows.values()].slice(0, limit),
        remove: (sessionId) => void rows.delete(sessionId),
      },
      launchers: { get: (child) => sessions[child]?.launcher },
      hasSession: (sessionId) => sessionId in sessions,
    },
    enabled: () => overrides.enabled ?? true,
    now: () => time,
    lastTurn: (sessionId) => sessions[sessionId]?.turn,
    resume: async (sessionId, text) => { resumed.push({ sessionId, text }); return overrides.resume?.(sessionId) ?? true },
    tell: async (launcher, text) => void told.push({ launcher, text }),
    title: (sessionId) => `title of ${sessionId}`,
    queueId: () => "queue_1" as QueueId,
    log: () => {},
  })
  return { rows, told, resumed, resumer, advance: (ms: number) => { time += ms } }
}

describe("resuming the turns a daemon shutdown interrupted", () => {
  test("an interrupted turn is resumed once with one steering turn, and its row is gone", async () => {
    const h = setup({ sessions: { ses_a: { turn: interrupted("trn_1"), launcher: "ses_l" }, ses_l: {} } })
    h.resumer.record(id("ses_a"), "trn_1")
    await h.resumer.start()
    expect(h.resumed).toEqual([{ sessionId: "ses_a", text: RESUME_TEXT }])
    expect(h.rows.size).toBe(0)
    expect(h.told).toEqual([])
    await h.resumer.start()
    expect(h.resumed).toHaveLength(1)
  })

  test("a session deleted meanwhile tells its launcher", async () => {
    const h = setup({ sessions: { ses_l: {} } })
    h.rows.set("ses_gone", { sessionId: "ses_gone", turnId: "trn_1", launcher: "ses_l", attempts: 0, at: 1_000_000 })
    await h.resumer.start()
    expect(h.resumed).toEqual([])
    expect(h.told).toHaveLength(1)
    expect(h.told[0]!.launcher).toBe("ses_l")
    expect(h.told[0]!.text).toContain("ses_gone")
    expect(h.told[0]!.text).toContain("the session was deleted")
  })

  test("each reason that blocks a resume reaches the launcher; a turn the user moved on from is dropped quietly", async () => {
    const shellTurn = [{ type: "turn.started", turnId: "trn_1" }, { type: "item.started", kind: "user_message", meta: { shell: true } }, { type: "turn.interrupted", turnId: "trn_1" }] as unknown as SessionEvent[]
    const cases: Array<{ name: string; setup: () => ReturnType<typeof setup>; reason?: string }> = [
      { name: "setting off", setup: () => setup({ enabled: false, sessions: { ses_a: { turn: interrupted("trn_1"), launcher: "ses_l" }, ses_l: {} } }), reason: "resumeAfterRestart is off" },
      { name: "shell", setup: () => setup({ sessions: { ses_a: { turn: shellTurn, launcher: "ses_l" }, ses_l: {} } }), reason: "a shell command is never run again" },
      { name: "busy", setup: () => setup({ resume: () => false, sessions: { ses_a: { turn: interrupted("trn_1"), launcher: "ses_l" }, ses_l: {} } }), reason: "the session was busy or held" },
      { name: "later turn", setup: () => setup({ sessions: { ses_a: { turn: interrupted("trn_2"), launcher: "ses_l" }, ses_l: {} } }) },
      { name: "turn ended", setup: () => setup({ sessions: { ses_a: { turn: [{ type: "turn.started", turnId: "trn_1" }, { type: "turn.completed", turnId: "trn_1" }] as unknown as SessionEvent[], launcher: "ses_l" }, ses_l: {} } }) },
    ]
    for (const entry of cases) {
      const h = entry.setup()
      h.resumer.record(id("ses_a"), "trn_1")
      await h.resumer.start()
      if (entry.reason) {
        expect(h.told, entry.name).toHaveLength(1)
        expect(h.told[0]!.text, entry.name).toContain(entry.reason)
      } else expect(h.told, entry.name).toEqual([])
      if (entry.name !== "busy") expect(h.resumed, entry.name).toEqual([])
      expect(h.rows.size, entry.name).toBe(0)
    }
  })

  test("a session without a launcher is resumed or skipped without anyone being told", async () => {
    const h = setup({ enabled: false, sessions: { ses_a: { turn: interrupted("trn_1") } } })
    h.resumer.record(id("ses_a"), "trn_1")
    await h.resumer.start()
    expect(h.told).toEqual([])
  })

  test("a turn stopped by a shutdown again after being resumed counts its attempts and stops at the cap", async () => {
    const h = setup({ sessions: { ses_a: { turn: interrupted("trn_1"), launcher: "ses_l" }, ses_l: {} } })
    h.resumer.record(id("ses_a"), "trn_1")
    await h.resumer.start()
    // The resumed turn is interrupted by the next shutdown: its record carries the attempt that was running.
    h.resumer.record(id("ses_a"), "trn_1")
    expect(h.rows.get("ses_a")!.attempts).toBe(1)
    h.rows.set("ses_a", { ...h.rows.get("ses_a")!, attempts: RESUME_MAX_ATTEMPTS })
    await h.resumer.start()
    expect(h.resumed).toHaveLength(1)
    expect(h.told[0]!.text).toContain(`already resumed ${RESUME_MAX_ATTEMPTS} times`)
  })

  test("a resumed turn that ends on its own is forgotten, so the next shutdown starts from zero", async () => {
    const h = setup({ sessions: { ses_a: { turn: interrupted("trn_1") } } })
    h.resumer.record(id("ses_a"), "trn_1")
    await h.resumer.start()
    h.resumer.observe({ type: "turn.completed", sessionId: id("ses_a"), turnId: "trn_2" } as unknown as SessionEvent)
    h.resumer.record(id("ses_a"), "trn_3")
    expect(h.rows.get("ses_a")!.attempts).toBe(0)
  })

  test("a turn interrupted hours ago is not resumed by surprise", async () => {
    const h = setup({ sessions: { ses_a: { turn: interrupted("trn_1"), launcher: "ses_l" }, ses_l: {} } })
    h.resumer.record(id("ses_a"), "trn_1")
    h.advance(RESUME_MAX_AGE_MS + 1)
    await h.resumer.start()
    expect(h.resumed).toEqual([])
    expect(h.told[0]!.text).toContain("stayed down for hours")
  })

  test("more sessions than the cap resume the cap and report the rest, paging through the table", async () => {
    const sessions: Record<string, { turn: SessionEvent[]; launcher: string }> = {}
    const h = setup({ sessions: sessions as never })
    ;(sessions as Record<string, unknown>).ses_l = {}
    const total = RESUME_MAX_PER_START + 40
    for (let i = 0; i < total; i++) {
      sessions[`ses_${String(i).padStart(3, "0")}`] = { turn: interrupted(`trn_${i}`), launcher: "ses_l" }
      h.resumer.record(id(`ses_${String(i).padStart(3, "0")}`), `trn_${i}`)
    }
    await h.resumer.start()
    expect(h.resumed).toHaveLength(RESUME_MAX_PER_START)
    expect(h.told).toHaveLength(total - RESUME_MAX_PER_START)
    expect(h.told[0]!.text).toContain("interrupted at once")
    expect(h.rows.size).toBe(0)
  })
})
