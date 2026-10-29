import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Goal, GoalChange } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { DEFAULT_FOOTER } from "@mendcode/protocol/wire"
import { glyphs } from "../src/ui/theme"
import { parseSlash } from "../src/view/commands"
import { renderFooter, type FooterInput } from "../src/view/footer"
import { goalCardRows, goalElapsedMs, goalResumeQuestion, goalSpans, parseGoalCommand, parseTokenCount, shortElapsed, shortTokens } from "../src/view/goal"
import { createTranscript } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, type HarnessOptions } from "./session-ui-harness"

afterAll(cleanTemps)

const asReply = (reply: unknown) => reply as CommandReply
const g = glyphs({})
const text = (spans: Array<{ text: string }>) => spans.map((span) => span.text).join("")

function goalOf(patch: Partial<Goal> = {}, sessionId = ids("session")): Goal {
  return { goalId: ids("goal"), sessionId, objective: "make the tests pass", status: "active", tokensUsed: 12_400, timeUsedSeconds: 200, createdAt: NOW - 400_000, updatedAt: NOW - 1000, ...patch }
}

describe("/goal arguments", () => {
  test("no arguments ask for the summary; single words are subcommands", () => {
    expect(parseGoalCommand("")).toEqual({ ok: true, command: { kind: "summary" } })
    for (const word of ["edit", "pause", "resume", "clear"] as const) expect(parseGoalCommand(` ${word.toUpperCase()} `)).toEqual({ ok: true, command: { kind: word } })
  })

  test("anything else is the objective, even when it starts with a subcommand word", () => {
    expect(parseGoalCommand("fix the build")).toEqual({ ok: true, command: { kind: "set", objective: "fix the build" } })
    expect(parseGoalCommand("pause the deploy after the tests")).toEqual({ ok: true, command: { kind: "set", objective: "pause the deploy after the tests" } })
    expect(parseGoalCommand("budget the migration across three releases")).toMatchObject({ ok: true, command: { kind: "set" } })
  })

  test("budget takes a token count, k/m/b suffixes or off", () => {
    expect(parseGoalCommand("budget 50000")).toEqual({ ok: true, command: { kind: "budget", tokens: 50_000 } })
    expect(parseGoalCommand("budget 50k")).toEqual({ ok: true, command: { kind: "budget", tokens: 50_000 } })
    expect(parseGoalCommand("budget 1.5M")).toEqual({ ok: true, command: { kind: "budget", tokens: 1_500_000 } })
    expect(parseGoalCommand("budget off")).toEqual({ ok: true, command: { kind: "budget", tokens: null } })
    for (const bad of ["budget", "budget lots", "budget 0", "budget -5", "budget 1e3"]) expect(parseGoalCommand(bad)).toMatchObject({ ok: false })
  })

  test("--budget leads an objective and needs both parts", () => {
    expect(parseGoalCommand("--budget 20k ship the release")).toEqual({ ok: true, command: { kind: "set", objective: "ship the release", tokenBudget: 20_000 } })
    expect(parseGoalCommand("--budget=2m long job")).toMatchObject({ ok: true, command: { tokenBudget: 2_000_000 } })
    expect(parseGoalCommand("--budget 20k")).toMatchObject({ ok: false })
    expect(parseGoalCommand("--budget soon ship it")).toMatchObject({ ok: false })
  })

  test("an objective past the limit is refused before it is sent", () => {
    expect(parseGoalCommand("x".repeat(60_001))).toMatchObject({ ok: false })
    expect(parseGoalCommand("x".repeat(60_000))).toMatchObject({ ok: true })
  })

  test("token counts: plain, suffixed, commas, off, nonsense", () => {
    expect([parseTokenCount("12"), parseTokenCount("12k"), parseTokenCount("1,200"), parseTokenCount("none"), parseTokenCount("1t"), parseTokenCount("")]).toEqual([12, 12_000, 1_200, null, undefined, undefined])
  })

  test("/goal is a listed command that waits for its arguments", () => {
    expect(parseSlash("/goal ship it")).toMatchObject({ command: { name: "goal" }, args: "ship it" })
  })
})

describe("goal indicator", () => {
  test("short numbers and times", () => {
    expect([0, 640, 1_200, 12_400, 999_999, 1_500_000].map(shortTokens)).toEqual(["0", "640", "1.2k", "12k", "1m", "1.5m"])
    expect([0, 45_000, 240_000, 3_900_000].map(shortElapsed)).toEqual(["0s", "45s", "4m", "1h 5m"])
  })

  test("an active goal shows tokens against its budget and the time, ticking with the running turn", () => {
    const goal = goalOf({ tokenBudget: 50_000, timeUsedSeconds: 180 })
    expect(text(goalSpans(goal, NOW, g))).toBe("◎ goal 12k/50k · 3m")
    const running = { ...goal, activeSince: NOW - 60_000 }
    expect(goalElapsedMs(running, NOW)).toBe(240_000)
    expect(text(goalSpans(running, NOW, g))).toBe("◎ goal 12k/50k · 4m")
    expect(text(goalSpans(goalOf({ tokensUsed: 0, timeUsedSeconds: 0 }), NOW, g))).toBe("◎ goal · 0s")
    expect(text(goalSpans(goalOf(), NOW, g))).toBe("◎ goal 12k · 3m")
  })

  test("the other states read as words and colors, and a stalled goal says so", () => {
    const at = (patch: Partial<Goal>) => goalSpans(goalOf(patch), NOW, g)
    expect([text(at({ status: "paused" })), at({ status: "paused" })[0]!.fg]).toEqual(["◎ goal · paused", "muted"])
    expect([text(at({ status: "blocked" })), at({ status: "blocked" })[0]!.fg]).toEqual(["◎ goal · blocked", "warning"])
    expect(text(at({ status: "usage_limited" }))).toBe("◎ goal · usage limit")
    expect(text(at({ status: "budget_limited" }))).toBe("◎ goal · budget reached")
    expect([text(at({ status: "complete" })), at({ status: "complete" })[0]!.fg]).toEqual(["◎ goal · complete", "success"])
    expect(text(at({ stalled: "the last turn failed" }))).toBe("◎ goal · stalled")
  })

  test("the footer shows it after the state even when the configured segments leave goal out, and not without a goal", () => {
    const base: FooterInput = { segments: DEFAULT_FOOTER, width: 120, glyphs: g, stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "ask", quotas: [], now: NOW, notice: "" }
    expect(text(renderFooter(base))).toBe("ready")
    expect(text(renderFooter({ ...base, goal: goalOf({ tokenBudget: 50_000, timeUsedSeconds: 180 }) }))).toBe("ready  ◎ goal 12k/50k · 3m")
    expect(text(renderFooter({ ...base, segments: ["permission", "goal", "state"], permission: "full", permissionLabel: "full access", goal: goalOf({ timeUsedSeconds: 180 }) }))).toBe("full access  ◎ goal 12k · 3m  ready")
  })

  test("resume asks by what the goal is and explains what cannot be resumed", () => {
    expect(goalResumeQuestion(goalOf({ status: "paused" }))).toEqual({ ok: true, question: "Resume paused goal?" })
    expect(goalResumeQuestion(goalOf({ status: "blocked" }))).toMatchObject({ ok: true })
    expect(goalResumeQuestion(goalOf({ status: "usage_limited" }))).toMatchObject({ ok: true })
    expect(goalResumeQuestion(goalOf({ stalled: "cancelled" }))).toMatchObject({ ok: true })
    expect(goalResumeQuestion(goalOf())).toMatchObject({ ok: false })
    expect(goalResumeQuestion(goalOf({ status: "budget_limited" }))).toMatchObject({ ok: false, reason: expect.stringContaining("/goal budget") })
    expect(goalResumeQuestion(goalOf({ status: "complete" }))).toMatchObject({ ok: false })
    expect(goalResumeQuestion(undefined)).toEqual({ ok: false, reason: "no goal in this session" })
  })
})

describe("goal cards", () => {
  const card = (change: GoalChange, patch: Partial<Goal>, width = 80) => goalCardRows({ change, goal: goalOf(patch), at: NOW }, width).map(plain)

  test("created, complete, blocked and limited goals get a card; pause, resume and usage do not", () => {
    expect(card("created", {})[0]).toContain("Goal set")
    expect(card("status", { status: "complete", note: "all green" }).join("\n")).toContain("Goal complete")
    expect(card("status", { status: "complete", note: "all green" }).join("\n")).toContain("all green")
    expect(card("status", { status: "blocked", note: "needs the API key" }).join("\n")).toContain("needs the API key")
    expect(card("status", { status: "budget_limited", tokenBudget: 12_000 })[0]).toContain("Goal budget reached")
    expect(card("status", { status: "usage_limited" })[0]).toContain("Goal stopped · usage limit")
    expect(card("stalled", { stalled: "the last turn failed" }).join("\n")).toContain("the last turn failed")
    expect(card("status", { status: "paused" })).toEqual([])
    expect(card("progress", {})).toEqual([])
    expect(card("edited", {})).toEqual([])
    expect(card("stalled", {})).toEqual([])
  })

  test("the card carries the objective and the facts, stays inside the width, and cuts a long objective to a few rows", () => {
    const rows = card("created", { objective: "line of the objective ".repeat(40), tokenBudget: 50_000 }, 40)
    expect(rows.every((row) => row.length <= 40)).toBe(true)
    expect(rows.join("\n")).toContain("more lines")
    expect(rows.at(-1)).toBe("  active · 12k of 50k tokens · 3m")
  })
})

describe("goal in the transcript", () => {
  const emitGoal = (chat: ReturnType<typeof conversation>, change: GoalChange, goal: Goal, by = "user") => chat.emit({ type: "goal.changed", change, goal, by })

  test("the transcript follows the goal, draws cards where it changed and the steering marker as a thin line", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const sessionId = ids("session")
    const chat = conversation(sessionId, (event) => transcript.apply(event))
    expect(transcript.goal).toBeUndefined()
    const goal = goalOf({}, sessionId)
    emitGoal(chat, "created", goal)
    expect(transcript.goal).toMatchObject({ status: "active" })
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const itemId = ids("item")
    chat.emit({ type: "item.started", turnId, itemId, kind: "user_message", meta: { notice: true, goal: "continuation" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: "goal · continuing" })
    emitGoal(chat, "progress", { ...goal, tokensUsed: 500 }, "system")
    expect(transcript.goal?.tokensUsed).toBe(500)
    emitGoal(chat, "status", { ...goal, status: "complete", note: "done" }, "agent")
    const rows = transcript.viewport(80, 30).map((line) => line.text)
    expect(rows.some((row) => row.includes("Goal set"))).toBe(true)
    expect(rows.some((row) => row.includes("goal · continuing"))).toBe(true)
    expect(rows.some((row) => row.includes("Goal complete"))).toBe(true)
    expect(transcript.goal?.status).toBe("complete")
    emitGoal(chat, "cleared", { ...goal, status: "complete" })
    expect(transcript.goal).toBeUndefined()
  })

  test("a progress event adds no card", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const sessionId = ids("session")
    const chat = conversation(sessionId, (event) => transcript.apply(event))
    emitGoal(chat, "progress", goalOf({}, sessionId), "system")
    expect(transcript.visibleCount).toBe(0)
  })

  test("a goal card stays when a turn is undone", () => {
    const transcript = createTranscript({ glyphs: g, mode: "balanced", now: () => NOW })
    const sessionId = ids("session")
    const chat = conversation(sessionId, (event) => transcript.apply(event))
    emitGoal(chat, "created", goalOf({}, sessionId))
    const { turnId } = chat.exchange("question", "answer")
    chat.undo(turnId)
    const rows = transcript.viewport(80, 30).map((line) => line.text).join("\n")
    expect(rows).toContain("Goal set")
    expect(rows).not.toContain("answer")
  })
})

describe("/goal in the app", () => {
  const goalReply = (goal: Goal, extra: Record<string, unknown> = {}) => asReply({ ok: true, result: { goal, ...extra } })

  function setup(reply?: HarnessOptions["reply"]) {
    const h = appHarness(reply ? { reply } : {})
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    return { h, chat }
  }

  test("/goal <objective> sends goal.set with the budget flag and says so", async () => {
    const { h } = setup((command) => (command.type === "goal.set" ? goalReply(goalOf({ objective: command.objective })) : undefined))
    await h.type("/goal --budget 50k fix the flaky test\r")
    expect(h.sentOf("goal.set")).toEqual([{ type: "goal.set", sessionId: h.sessionId, objective: "fix the flaky test", tokenBudget: 50_000 }])
    // The goal shows in the footer; no notice repeats it.
    expect(h.text().join("\n")).not.toContain("goal set")
  })

  test("with the confirmNotices profile key on, the same action says so", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "mc-goal-confirm-"))
    try {
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, confirmNotices: true })
      const h = appHarness({ dataDir, reply: (command) => (command.type === "goal.set" ? goalReply(goalOf({ objective: command.objective })) : undefined) })
      await h.type("/goal fix the flaky test\r")
      expect(h.text().join("\n")).toContain("goal set")
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })

  test("an unfinished goal in the way turns into a question: y replaces it, esc keeps it", async () => {
    const busy = asReply({ ok: false, error: { code: "busy", message: "[GOALS]: this session already has an unfinished goal (active)" } })
    const { h, chat } = setup((command) => (command.type === "goal.set" ? (command.replace ? goalReply(goalOf({ objective: command.objective }), { replaced: goalOf() }) : busy) : undefined))
    chat.emit({ type: "goal.changed", change: "created", goal: goalOf({ objective: "old goal" }, h.sessionId), by: "user" })
    await h.type("/goal new direction\r")
    const rows = h.text().join("\n")
    expect(rows).toContain("Replace the current goal?")
    expect(rows).toContain("old goal")
    expect(rows).toContain("new direction")
    expect(h.sentOf("goal.set")).toHaveLength(1)
    await h.type("\x1b")
    expect(h.text().join("\n")).not.toContain("Replace the current goal?")
    expect(h.sentOf("goal.set")).toHaveLength(1)
    await h.type("/goal new direction\r")
    await h.type("y")
    expect(h.sentOf("goal.set").at(-1)).toMatchObject({ objective: "new direction", replace: true })
    expect(h.text().join("\n")).not.toContain("Replace the current goal?")
  })

  test("/goal shows the summary card; with no goal it says how to set one", async () => {
    const { h, chat } = setup()
    await h.type("/goal\r")
    expect(h.text().join("\n")).toContain("No goal in this session")
    await h.type("\x1b")
    chat.emit({ type: "goal.changed", change: "created", goal: goalOf({ objective: "ship the release", tokenBudget: 50_000, note: "started" }, h.sessionId), by: "user" })
    await h.type("/goal\r")
    const rows = h.text().join("\n")
    expect(rows).toMatch(/objective\s+ship the release/)
    expect(rows).toMatch(/tokens\s+12k of 50k tokens/)
    expect(rows).toContain("/goal pause")
    expect(h.sent.filter((command) => command.type.startsWith("goal."))).toEqual([])
  })

  test.each(["minimal", "balanced", "full"] as const)("the %s view shows the indicator once while the session has a goal, and not without one", (mode) => {
    const h = appHarness({ mode })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("hello", "hi")
    h.app.render()
    expect(h.text().join("\n")).not.toContain("◎ goal")
    chat.emit({ type: "goal.changed", change: "status", goal: goalOf({ tokenBudget: 50_000 }, h.sessionId), by: "user" })
    h.app.render()
    expect(h.text().join("\n").split("◎ goal 12k/50k").length - 1).toBe(1)
    chat.emit({ type: "goal.changed", change: "status", goal: goalOf({ status: "paused" }, h.sessionId), by: "user" })
    h.app.render()
    expect(h.text().join("\n")).toContain("◎ goal · paused")
    chat.emit({ type: "goal.changed", change: "cleared", goal: goalOf({ status: "paused" }, h.sessionId), by: "user" })
    h.app.render()
    expect(h.text().join("\n")).not.toContain("◎ goal")
  })

  test("pause, clear and budget send their own commands", async () => {
    const { h, chat } = setup((command) => (command.type === "goal.update" ? goalReply(goalOf({ status: command.status === "paused" ? "paused" : "active" })) : undefined))
    chat.emit({ type: "goal.changed", change: "created", goal: goalOf({}, h.sessionId), by: "user" })
    await h.type("/goal pause\r")
    await h.type("/goal budget 20k\r")
    await h.type("/goal budget off\r")
    await h.type("/goal clear\r")
    expect(h.sentOf("goal.update")).toEqual([
      { type: "goal.update", sessionId: h.sessionId, status: "paused" },
      { type: "goal.update", sessionId: h.sessionId, tokenBudget: 20_000 },
      { type: "goal.update", sessionId: h.sessionId, tokenBudget: null },
    ])
    expect(h.sentOf("goal.clear")).toEqual([{ type: "goal.clear", sessionId: h.sessionId }])
  })

  test("resume asks first; a goal that cannot resume says why and sends nothing", async () => {
    const { h, chat } = setup((command) => (command.type === "goal.update" ? goalReply(goalOf()) : undefined))
    chat.emit({ type: "goal.changed", change: "created", goal: goalOf({ status: "paused" }, h.sessionId), by: "user" })
    await h.type("/goal resume\r")
    expect(h.text().join("\n")).toContain("Resume paused goal?")
    expect(h.sentOf("goal.update")).toEqual([])
    await h.type("y")
    expect(h.sentOf("goal.update")).toEqual([{ type: "goal.update", sessionId: h.sessionId, status: "active" }])
    chat.emit({ type: "goal.changed", change: "status", goal: goalOf({ status: "complete" }, h.sessionId), by: "agent" })
    await h.type("/goal resume\r")
    expect(h.text().join("\n")).toContain("the goal is complete")
    expect(h.sentOf("goal.update")).toHaveLength(1)
  })

  test("/goal edit puts the objective in the prompt: enter saves it, esc restores what was typed", async () => {
    const { h, chat } = setup((command) => (command.type === "goal.update" ? goalReply(goalOf({ objective: command.objective ?? "" })) : undefined))
    chat.emit({ type: "goal.changed", change: "created", goal: goalOf({ objective: "first wording" }, h.sessionId), by: "user" })
    await h.type("/goal edit\r")
    expect(h.app.editor.text).toBe("first wording")
    await h.type("\x1b")
    expect(h.app.editor.text).toBe("")
    expect(h.sentOf("goal.update")).toEqual([])
    await h.type("/goal edit\r")
    await h.type(" and more")
    await h.type("\r")
    expect(h.sentOf("goal.update")).toEqual([{ type: "goal.update", sessionId: h.sessionId, objective: "first wording and more" }])
    expect(h.app.editor.text).toBe("")
  })

  test("a refused command is shown as an error", async () => {
    const { h } = setup((command) => (command.type === "goal.update" ? asReply({ ok: false, error: { code: "target_mismatch", message: "[GOALS]: this session has no goal" } }) : undefined))
    await h.type("/goal pause\r")
    expect(h.text().join("\n")).toContain("this session has no goal")
  })

  test("a bad argument is a notice, not a command", async () => {
    const { h } = setup()
    await h.type("/goal budget soon\r")
    expect(h.text().join("\n")).toContain("budget needs a token count")
    expect(h.sent.filter((command) => command.type.startsWith("goal."))).toEqual([])
  })
})
