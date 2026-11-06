import { expect, test } from "bun:test"
import { createIdFactory, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { normalizeTuiProfile, timestampPlace } from "../src/view/tui-profile"

const ids = createIdFactory()
const sessionId = ids("session")
const NOW = new Date(2026, 8, 28, 15, 50).getTime()

function stream() {
  let seq = 0
  let clock = NOW - 60_000
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 100) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const item = (turnId: TurnId, kind: string, options: { text?: string; meta?: Record<string, string>; status?: string } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind, ...(options.meta ? { meta: options.meta } : {}) })
    emit({ type: "item.completed", itemId, status: options.status ?? "ok", ...(options.text !== undefined ? { text: options.text } : {}) })
    return itemId
  }
  const turn = () => {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    return turnId
  }
  return { emit, item, turn, events }
}

function view(events: SessionEvent[], options: { timestamps?: "bottom" | "top" | "off"; mode?: PresentationMode; background?: { shells: number; agents: number } } = {}) {
  const t = createTranscript({ glyphs: glyphs({}), mode: options.mode ?? "balanced", now: () => NOW, ...(options.background ? { background: () => options.background! } : {}) })
  t.setAppearance({ messageMeta: "off", timestamps: options.timestamps ?? "bottom" })
  for (const event of events) t.apply(event)
  return t.viewport(100, 200).map((line) => line.text.trimEnd()).filter((text) => text.trim())
}

function exchange(s: ReturnType<typeof stream>, answer = "Done.", end: Record<string, unknown> = { type: "turn.completed" }) {
  const turnId = s.turn()
  s.item(turnId, "user_message", { text: "go" })
  s.emit({}, 4_000)
  s.item(turnId, "agent_message", { text: answer })
  s.emit({ ...end, turnId }, 100)
  return turnId
}

test("each turn closes with one line in the answer's text column: how long it took and when it ended; no time over the messages", () => {
  const s = stream()
  exchange(s)
  exchange(s)
  const rows = view(s.events)
  const closing = rows.filter((row) => row.includes("ended"))
  expect(closing).toHaveLength(2)
  for (const row of closing) expect(row).toMatch(/^ {4}took [\d.]+s · ended \d{1,2}:\d{2} [AP]M$/)
  // It starts where the answer's text starts, under the `•` lead.
  const answer = rows.find((row) => row.includes("Done."))!
  expect(closing[0]!.indexOf("took")).toBe(answer.indexOf("Done."))
  expect(rows.some((row) => /\d:\d\d [AP]M/.test(row) && !row.includes("ended"))).toBe(false)
})

test("the latest turn's line says which shells and sub-agents still run; an older turn's line does not", () => {
  const s = stream()
  exchange(s)
  exchange(s)
  const closing = view(s.events, { background: { shells: 2, agents: 1 } }).filter((row) => row.includes("ended"))
  expect(closing[0]).not.toContain("running")
  expect(closing[1]).toMatch(/ · 2 shells and 1 agent still running$/)
  expect(view(s.events, { background: { shells: 1, agents: 0 } }).at(-1)).toMatch(/ · 1 shell still running$/)
  expect(view(s.events, { background: { shells: 0, agents: 0 } }).at(-1)).not.toContain("running")
})

test("a turn that did not finish says how it ended instead of how long it took", () => {
  const s = stream()
  exchange(s, "Partial.", { type: "turn.interrupted" })
  expect(view(s.events).at(-1)).toMatch(/^ {4}interrupted.* after [\d.]+s · ended /)
})

test("`top` puts the time over each message and drops the closing line; `off` shows no time at all; minimal never has the line", () => {
  const s = stream()
  exchange(s)
  const top = view(s.events, { timestamps: "top" })
  expect(top.some((row) => row.includes("ended"))).toBe(false)
  expect(top.some((row) => /\d:\d\d [AP]M$/.test(row))).toBe(true)
  const off = view(s.events, { timestamps: "off" })
  expect(off.some((row) => /\d:\d\d [AP]M/.test(row) || row.includes("took"))).toBe(false)
  expect(view(s.events, { mode: "minimal" }).some((row) => row.includes("ended"))).toBe(false)
})

test("`timestamps` from an older profile: true reads as bottom, false as off, anything unknown as the default", () => {
  expect(timestampPlace(true)).toBe("bottom")
  expect(timestampPlace(false)).toBe("off")
  expect(timestampPlace("top")).toBe("top")
  expect(timestampPlace("sideways")).toBe("bottom")
  expect(normalizeTuiProfile({ timestamps: false }).timestamps).toBe("off")
  expect(normalizeTuiProfile({}).timestamps).toBe("bottom")
})

test("three or more finished shell commands in a row fold into one row; a failed one ends the run and shows", () => {
  const s = stream()
  const turnId = s.turn()
  s.item(turnId, "user_message", { text: "check" })
  for (const command of ["ls", "git status", "bun test"]) s.item(turnId, "tool_call", { meta: { tool: "shell", title: `shell: ${command}` }, text: "ok" })
  s.item(turnId, "tool_call", { meta: { tool: "shell", title: "shell: false" }, text: "", status: "error" })
  s.item(turnId, "agent_message", { text: "Done." })
  s.emit({ type: "turn.completed", turnId })
  const rows = view(s.events)
  expect(rows.filter((row) => row.includes("Ran 3 shell commands"))).toHaveLength(1)
  const run = rows.findIndex((row) => row.includes("Ran 3 shell commands"))
  expect(rows[run + 1]).toMatch(/✗ shell +failed$/)
})

test("an idle compaction that found nothing to do (no usage, no content) draws no second closing line after the answer's", () => {
  const s = stream()
  const answered = s.turn()
  s.item(answered, "user_message", { text: "go" })
  s.item(answered, "agent_message", { text: "Done." })
  s.emit({ type: "usage.recorded", turnId: answered, provider: "claude", model: "claude-opus-5-5", input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, context: 100, contextWindow: 1_000_000 }, 3_000)
  s.emit({ type: "turn.completed", turnId: answered }, 10)
  s.emit({ type: "foreground.state", state: "idle" }, 10)
  const idle = s.turn()
  s.emit({ type: "compaction.updated", turnId: idle, reason: "auto", idle: true, state: "writing", followUp: "" }, 1)
  s.emit({ type: "compaction.updated", turnId: idle, reason: "auto", idle: true, state: "skipped", followUp: "" }, 1)
  s.emit({ type: "turn.completed", turnId: idle }, 1)
  s.emit({ type: "foreground.state", state: "idle" }, 10)
  const closing = view(s.events).filter((row) => row.includes("ended"))
  expect(closing).toHaveLength(1)
  expect(closing[0]).toMatch(/took/)
})
