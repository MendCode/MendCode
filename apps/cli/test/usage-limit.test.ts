import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { glyphs } from "../src/ui/theme"
import { parseSlash } from "../src/view/commands"
import { createTranscript } from "../src/view/transcript"
import { limitedRow, limitedText, agentCard } from "../src/view/sidebar-cards"
import { textWidth } from "../src/view/wrap"
import { limitBarVisible, limitCardLine, limitCardRows, limitChips, limitHeadline, limitLine, limitPrimary, limitStatus, parseLimitCommand, renderLimitBar, resetClock, resetIn, type UsageLimitView } from "../src/view/usage-limit"
import { appHarness, cleanTemps, conversation, ids, NOW, plain } from "./session-ui-harness"
import { ui4Harness } from "./ui-4-harness"

afterAll(cleanTemps)

const g = glyphs({})
const asReply = (reply: unknown) => reply as CommandReply
const RESET = NOW + 3 * 3_600_000 + 12 * 60_000
const view = (patch: Partial<UsageLimitView> = {}): UsageLimitView => ({ state: "paused", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, at: NOW, ...patch })

describe("usage limit text", () => {
  test("checkpoint is one muted line at wide and narrow widths and survives transcript replay", () => {
    for (const mode of ["minimal", "balanced", "full"] as const) {
      const transcript = createTranscript({ glyphs: g, mode, now: () => NOW })
      transcript.apply({ type: "limit.checkpoint", sessionId: ids("session"), seq: 1, at: NOW })
      for (const width of [30, 80]) {
        const rows = transcript.viewport(width, 10).filter((row) => row.text.includes("checkpoint"))
        expect(rows).toHaveLength(1)
        expect(rows[0]!.text.length).toBeLessThanOrEqual(width)
        expect(rows[0]!.spans.some((span) => span.fg === "muted" && span.dim)).toBe(true)
      }
      transcript.prepend([])
      expect(transcript.viewport(80, 10).filter((row) => row.text.includes("checkpoint"))).toHaveLength(1)
    }
  })
  test("a reset reads as a clock time, with the day when it is not today, and as a countdown", () => {
    expect(resetClock(NOW + 2 * 3_600_000, NOW)).toMatch(/^2:00 PM$/)
    expect(resetClock(NOW + 30 * 3_600_000, NOW)).toMatch(/^Oct \d+, 6:00 PM$/)
    expect(resetIn(RESET, NOW)).toBe("3h 12m")
    expect(resetIn(NOW + 3 * 3_600_000, NOW)).toBe("3h")
    expect(resetIn(NOW + 20 * 60_000, NOW)).toBe("20m")
    expect(resetIn(NOW + 2 * 86_400_000 + 5 * 3_600_000, NOW)).toBe("2d 5h")
    expect(resetIn(NOW - 5, NOW)).toBe("now")
  })

  test("the headline names the reset only when it is still ahead", () => {
    expect(limitHeadline({ resetsAt: NOW + 2 * 3_600_000, now: NOW })).toBe("usage limit reached · resets 2:00 PM")
    expect(limitHeadline({ now: NOW, provider: "codex" })).toBe("codex usage limit reached")
    expect(limitHeadline({ resetsAt: NOW - 1, now: NOW })).toBe("usage limit reached")
  })

  test("the card says what happened, when it resets, and what the daemon will do", () => {
    const paused = limitCardRows({ state: "paused", provider: "claude", resetsAt: RESET, message: "5-hour limit reached", at: NOW }, 80).map(plain)
    expect(paused[0]).toContain("Usage limit reached")
    expect(paused.join("\n")).toContain("claude · resets 3:12 PM (in 3h 12m) · turn paused")
    expect(paused.join("\n")).toContain("5-hour limit reached")
    const scheduled = limitCardRows({ state: "scheduled", resetsAt: RESET, message: "", at: NOW }, 80).map(plain).join("\n")
    expect(scheduled).toContain("auto-resume armed · continues by itself")
    expect(limitCardRows({ state: "paused", message: "x", at: NOW }, 80).map(plain).join("\n")).toContain("reset time unknown")
    expect(limitCardRows({ state: "resumed", message: "", at: NOW }, 60).map(plain)[0]).toContain("Usage limit reset · resuming")
    expect(limitCardRows({ state: "paused", resetsAt: RESET, message: "long ".repeat(80), at: NOW }, 40).every((row) => plain(row).length <= 40)).toBe(true)
  })
})

describe("usage limit commands", () => {
  test("/limit parses its words", () => {
    expect(parseLimitCommand("")).toEqual({ ok: true, command: { kind: "status" } })
    expect(parseLimitCommand("resume")).toEqual({ ok: true, command: { kind: "act", action: "schedule" } })
    expect(parseLimitCommand("now")).toEqual({ ok: true, command: { kind: "act", action: "resume" } })
    expect(parseLimitCommand("cancel")).toEqual({ ok: true, command: { kind: "act", action: "cancel" } })
    expect(parseLimitCommand("snooze")).toEqual({ ok: true, command: { kind: "act", action: "snooze" } })
    expect(parseLimitCommand("dismiss")).toEqual({ ok: true, command: { kind: "act", action: "dismiss" } })
    expect(parseLimitCommand("later")).toMatchObject({ ok: false })
    expect(parseSlash("/limit snooze")).toMatchObject({ command: { name: "limit" }, args: "snooze" })
  })

  test("the chips follow the state: schedule and snooze, then resume now, cancel and snooze once armed, then resume once the window reset", () => {
    expect(limitChips(view()).map((chip) => chip.action)).toEqual(["schedule", "snooze"])
    expect(limitChips(view({ resetsAt: undefined as never })).map((chip) => chip.action)).toEqual(["resume", "dismiss"])
    expect(limitChips(view({ state: "scheduled" })).map((chip) => chip.action)).toEqual(["resume", "cancel", "snooze"])
    expect(limitChips(view({ state: "ready" })).map((chip) => chip.action)).toEqual(["resume", "dismiss"])
    expect(limitPrimary(view())).toBe("schedule")
    expect(limitBarVisible(view({ state: "snoozed" }))).toBe(false)
    expect(limitBarVisible(undefined)).toBe(false)
    expect(limitBarVisible(view({ state: "ready" }))).toBe(true)
    expect(limitStatus(undefined, NOW)).toContain("no turn is paused")
    expect(limitStatus(view({ state: "scheduled" }), NOW)).toContain("auto-resume armed")
  })

  test("the bar fits every width, and its chip coordinates point at the chips", () => {
    for (const width of [40, 60, 80, 120]) {
      const bar = renderLimitBar({ width, view: view(), now: NOW, glyphs: g })
      const rows = bar.rows.map(plain)
      expect(rows.every((row) => row.length <= width)).toBe(true)
      for (const chip of bar.chips) {
        const label = limitChips(view()).find((candidate) => candidate.action === chip.action)!.label
        expect(rows[chip.row]!.slice(chip.from, chip.to)).toBe(label)
      }
      expect(bar.chips.map((chip) => chip.action)).toEqual(["schedule", "snooze"])
    }
  })

  test("an armed pause says so, offers Resume now, Cancel and Snooze, and every chip lands where the bar says", () => {
    const armed = view({ state: "scheduled" })
    for (const width of [40, 60, 80, 120]) {
      const bar = renderLimitBar({ width, view: armed, now: NOW, glyphs: g })
      const rows = bar.rows.map(plain)
      expect(rows.every((row) => row.length <= width)).toBe(true)
      expect(rows.join("\n")).toContain("resume at reset (armed)")
      expect(bar.chips.map((chip) => chip.action)).toEqual(["resume", "cancel", "snooze"])
      for (const chip of bar.chips) expect(rows[chip.row]!.slice(chip.from, chip.to)).toBe(limitChips(armed).find((candidate) => candidate.action === chip.action)!.label)
    }
  })

  test("the minimal view's one muted line follows the state and never shows for a snoozed pause", () => {
    expect(limitLine(view({ state: "scheduled" }), NOW)).toBe("limit reached · resumes 3:12 PM · esc cancel")
    expect(limitLine(view(), NOW)).toBe("limit reached · resets 3:12 PM · /limit resume")
    expect(limitLine(view({ resetsAt: undefined as never }), NOW)).toBe("limit reached · reset unknown · /limit now")
    expect(limitLine(view({ state: "ready" }), NOW)).toBe("limit reset · /limit now · /limit dismiss")
    expect(limitLine(view({ state: "snoozed" }), NOW)).toBeUndefined()
    expect(limitLine(undefined, NOW)).toBeUndefined()
    expect(limitCardLine({ state: "paused", message: "", at: NOW }, 80)).toEqual([])
    expect(limitCardLine({ state: "resumed", message: "", at: NOW }, 80).map(plain)).toEqual(["  limit reset · resumed"])
  })

  test("the cards say Limited with the reset, and fit the bar", () => {
    expect(limitedText({ resetsAt: RESET, now: NOW })).toBe("Limited · resets 3:12 PM")
    expect(limitedText({ resetsAt: RESET, now: NOW, countdown: true })).toBe("Limited · resets 3:12 PM (in 3h 12m)")
    expect(limitedText({ now: NOW })).toBe("Limited · reset unknown")
    expect(limitedText({ resetsAt: NOW - 1, now: NOW })).toBe("Limited · reset unknown")
    expect(plain(limitedRow({ resetsAt: RESET, now: NOW }, 40))).toBe("Limited · resets 3:12 PM (in 3h 12m)")
    expect(textWidth(plain(limitedRow({ resetsAt: RESET, now: NOW }, 20)))).toBeLessThanOrEqual(20)
    const agent = agentCard({ stateLabel: "idle", state: "idle", billing: "Subscription", permission: "ask", limited: { resetsAt: RESET, now: NOW } }, 36, g).map(plain)
    expect(agent[0]).toContain("Limited · resets 3:12 PM")
    expect(agent.every((row) => textWidth(row) <= 36)).toBe(true)
  })
})

describe("usage limit in the transcript", () => {
  const limit = (chat: ReturnType<typeof conversation>, patch: Record<string, unknown>) => chat.emit({ type: "usage.limit", message: "5-hour limit reached", by: "system", ...patch })
  const failedTurn = (chat: ReturnType<typeof conversation>) => {
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "turn.failed", turnId, error: { code: "provider_error", message: "[PROVIDER]: 429 usage_limit_reached" } })
    return turnId
  }

  test("the paused turn shows a notice with the reset time instead of an error box, and the bar state follows the events", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const chat = conversation(ids("session"), (event) => transcript.apply(event))
    const turnId = failedTurn(chat)
    expect(transcript.viewport(80, 30).map((line) => line.text).join("\n")).toContain("usage_limit_reached")
    limit(chat, { turnId, state: "paused", provider: "claude", resetsAt: RESET })
    expect(transcript.usageLimit).toMatchObject({ state: "paused", resetsAt: RESET, provider: "claude", turnId })
    const text = transcript.viewport(80, 30).map((line) => line.text).join("\n")
    expect(text).toContain("Usage limit reached")
    expect(text).toContain("resets 3:12 PM")
    expect(text).toContain("turn paused")
    expect(text).not.toContain("usage_limit_reached")
    limit(chat, { turnId, state: "scheduled", resetsAt: RESET })
    expect(transcript.usageLimit?.state).toBe("scheduled")
    // Moving between open states adds no second notice.
    expect(transcript.viewport(80, 30).map((line) => line.text).join("\n").split("Usage limit reached")).toHaveLength(2)
    limit(chat, { turnId, state: "resumed" })
    expect(transcript.usageLimit).toBeUndefined()
    expect(transcript.viewport(80, 30).map((line) => line.text).join("\n")).toContain("Usage limit reset · resuming")
  })

  test("a snoozed pause is kept but not drawn, and a dismissal leaves nothing", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const chat = conversation(ids("session"), (event) => transcript.apply(event))
    const turnId = failedTurn(chat)
    limit(chat, { turnId, state: "paused", resetsAt: RESET })
    limit(chat, { turnId, state: "snoozed", resetsAt: RESET })
    expect(transcript.usageLimit?.state).toBe("snoozed")
    limit(chat, { turnId, state: "ready", resetsAt: RESET })
    expect(limitBarVisible(transcript.usageLimit)).toBe(true)
    limit(chat, { turnId, state: "cleared" })
    expect(transcript.usageLimit).toBeUndefined()
  })

  test("loading older events rebuilds the same state", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const chat = conversation(ids("session"), (event) => transcript.apply(event))
    const turnId = failedTurn(chat)
    limit(chat, { turnId, state: "paused", resetsAt: RESET })
    expect(transcript.usageLimit?.state).toBe("paused")
    expect(transcript.blocks().some((block) => block.limit?.state === "paused")).toBe(true)
  })
})

describe("usage limit in the app", () => {
  function setup(reply?: (command: { type: string; action?: string }) => unknown) {
    const h = appHarness({ reply: (command) => asReply(reply?.(command as never) ?? { ok: true, result: { state: "scheduled", resetsAt: RESET } }) })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "turn.failed", turnId, error: { code: "provider_error", message: "[PROVIDER]: 429 usage_limit_reached" } })
    chat.emit({ type: "usage.limit", turnId, state: "paused", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, by: "system" })
    h.app.render()
    return { h, chat, turnId }
  }

  test("the bar sits above the prompt with both choices; clicking Resume at reset sends the schedule", async () => {
    const { h } = setup()
    const rows = h.text()
    const row = rows.findIndex((line) => line.includes("RESUME AT RESET"))
    expect(row).toBeGreaterThan(0)
    expect(rows.some((line) => line.includes("SNOOZE UNTIL RESET"))).toBe(true)
    expect(rows.some((line) => line.includes("claude usage limit reached · resets 3:12 PM"))).toBe(true)
    const col = rows[row]!.indexOf("RESUME AT RESET")
    await h.app.onKey(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.sentOf("usage.limit")).toEqual([{ type: "usage.limit", sessionId: h.sessionId, action: "schedule" }])
  })

  test("clicking Snooze sends snooze, and the bar goes once the daemon says snoozed", async () => {
    const { h, chat, turnId } = setup()
    const rows = h.text()
    const row = rows.findIndex((line) => line.includes("SNOOZE UNTIL RESET"))
    const col = rows[row]!.indexOf("SNOOZE UNTIL RESET")
    await h.app.onKey(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.sentOf("usage.limit")).toEqual([{ type: "usage.limit", sessionId: h.sessionId, action: "snooze" }])
    chat.emit({ type: "usage.limit", turnId, state: "snoozed", message: "5-hour limit reached", resetsAt: RESET, by: "user" })
    h.app.render()
    expect(h.text().some((line) => line.includes("RESUME AT RESET"))).toBe(false)
  })

  test("ctrl+s takes the first choice, and /limit now continues at once", async () => {
    const { h } = setup()
    await h.type("\x13")
    expect(h.sentOf("usage.limit").map((command) => (command as { action: string }).action)).toEqual(["schedule"])
    await h.type("/limit now\r")
    expect(h.sentOf("usage.limit").map((command) => (command as { action: string }).action)).toEqual(["schedule", "resume"])
  })

  test("a refusal is shown, and /limit with nothing paused says so", async () => {
    const { h } = setup((command) => (command.type === "usage.limit" ? { ok: false, error: { code: "busy", message: "[USAGE-LIMIT]: the session could not start the turn right now" } } : undefined))
    await h.type("/limit now\r")
    expect(h.text().join("\n")).toContain("could not start the turn right now")
    const quiet = appHarness()
    await quiet.type("/limit\r")
    expect(quiet.text().join("\n")).toContain("no turn is paused")
    await quiet.type("/limit snooze\r")
    expect(quiet.sentOf("usage.limit")).toEqual([])
  })

  test("an armed pause in the balanced view shows the bar with Resume now, Cancel and Snooze; Cancel sends cancel", async () => {
    const { h, chat, turnId } = setup()
    chat.emit({ type: "usage.limit", turnId, state: "scheduled", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, by: "system" })
    h.app.render()
    const rows = h.text()
    expect(rows.some((line) => line.includes("resume at reset (armed) · 3:12 PM"))).toBe(true)
    const row = rows.findIndex((line) => line.includes("CANCEL"))
    expect(row).toBeGreaterThan(0)
    expect(rows.some((line) => line.includes("RESUME NOW")) && rows.some((line) => line.includes("SNOOZE"))).toBe(true)
    await h.app.onKey(`\x1b[<0;${rows[row]!.indexOf("CANCEL") + 1};${row + 1}M`)
    expect(h.sentOf("usage.limit")).toEqual([{ type: "usage.limit", sessionId: h.sessionId, action: "cancel" }])
    // esc does not cancel here: the bar has its own chip.
    await h.type("\x1b")
    expect(h.sentOf("usage.limit")).toHaveLength(1)
  })

  describe("minimal view", () => {
    function minimal(reply?: (command: { type: string }) => unknown) {
      const h = appHarness({ mode: "minimal", reply: (command) => asReply(reply?.(command as never) ?? { ok: true, result: { state: "paused", resetsAt: RESET } }) })
      const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
      const turnId = ids("turn")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      chat.emit({ type: "turn.failed", turnId, error: { code: "provider_error", message: "[PROVIDER]: 429 usage_limit_reached" } })
      chat.emit({ type: "usage.limit", turnId, state: "scheduled", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, by: "system" })
      h.app.render()
      return { h, chat, turnId }
    }

    test("one muted line says when it resumes and how to cancel; there is no bar and no card", () => {
      const { h } = minimal()
      const text = h.text().join("\n")
      expect(text).toContain("limit reached · resumes 3:12 PM · esc cancel")
      expect(text).not.toContain("RESUME NOW")
      expect(text).not.toContain("Usage limit reached")
    })

    test("esc cancels the armed auto-resume, and the line says how to arm it again", async () => {
      const { h, chat, turnId } = minimal()
      await h.type("\x1b")
      expect(h.sentOf("usage.limit")).toEqual([{ type: "usage.limit", sessionId: h.sessionId, action: "cancel" }])
      chat.emit({ type: "usage.limit", turnId, state: "paused", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, by: "user" })
      h.app.render()
      const text = h.text().join("\n")
      expect(text).toContain("limit reached · resets 3:12 PM · /limit resume")
      expect(text).not.toContain("esc cancel")
      // Once cancelled, esc is only esc.
      await h.type("\x1b")
      expect(h.sentOf("usage.limit")).toHaveLength(1)
    })

    test("a snoozed pause shows nothing, and typing text first keeps esc for the editor", async () => {
      const { h, chat, turnId } = minimal()
      await h.type("draft")
      await h.type("\x1b")
      expect(h.sentOf("usage.limit")).toEqual([])
      chat.emit({ type: "usage.limit", turnId, state: "snoozed", provider: "claude", message: "5-hour limit reached", resetsAt: RESET, by: "user" })
      h.app.render()
      expect(h.text().join("\n")).not.toContain("limit reached")
    })
  })
})

describe("usage limit in the right bar", () => {
  test("the usage and agent cards say Limited with the reset while a turn is paused, and drop it once resumed", async () => {
    const h = ui4Harness(180, 50)
    await h.type("/panel pulse\r")
    await Bun.sleep(5)
    const turnId = ids("turn")
    h.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    h.chat.emit({ type: "turn.failed", turnId, error: { code: "provider_error", message: "[PROVIDER]: 429 usage_limit_reached" } })
    h.chat.emit({ type: "usage.limit", turnId, state: "scheduled", provider: "claude", message: "limit", resetsAt: RESET, by: "system" })
    h.app.render()
    const text = h.text().join("\n")
    expect(text).toContain("Limited · resets 3:12 PM (in 3h 12m)")
    expect(text).toContain("Limited · resets 3:12 PM")
    h.chat.emit({ type: "usage.limit", turnId, state: "resumed", message: "limit", by: "system" })
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Limited ·")
  })
})
