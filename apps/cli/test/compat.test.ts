import { expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { COMPAT, compatEnvelope } from "../src/compat"
import { parseAutomation, runAutomation, SCHEMA, type AutomationDeps } from "../src/automation"
import { createHeadlessRun } from "../src/run"

test("the compat selector accepts only mendcode.cli.v1 and preserves existing flags", () => {
  expect(parseAutomation(["session", "create", "--format", "json", "--compat", COMPAT])).toMatchObject({ ok: true, command: { json: true, compat: COMPAT } })
  expect(parseAutomation(["session", "events", "ses_a", "--follow", "--compat=" + COMPAT])).toMatchObject({ ok: true, command: { json: true, compat: COMPAT, follow: true } })
  expect(parseAutomation(["session", "list", "--compat", "other"])).toMatchObject({ ok: false, message: `--compat must be ${COMPAT}` })
  expect(parseAutomation(["session", "create", "--json"])).toEqual({ ok: true, command: { kind: "session.create", title: "", json: true } })
})

test("v1 envelopes retain event identity and sequence and redact fields without redacting usage", () => {
  const event = { type: "turn.completed", sessionId: "ses_a", seq: 7, at: 123, turnId: "turn_a" } as SessionEvent
  const output = compatEnvelope({ kind: "event", event })
  expect(output).toMatchObject({ protocol: COMPAT, kind: "event", event: "session.completed", eventID: "evt_ses_a_7", timestamp: 123, sessionID: "ses_a", data: { sequence: 7, sessionID: "ses_a", type: "turn.completed" } })
  expect(compatEnvelope({ kind: "event", event })).toEqual(output)
  const result = compatEnvelope({ kind: "result", command: "session.create", data: { sessionId: "ses_a", nested: { apiKey: "sensitive", authorization: "sensitive", password: "sensitive", tokens: { input: 42 } } } }, 456)
  expect(result).toMatchObject({ protocol: COMPAT, event: "session.create", timestamp: 456, sessionID: "ses_a", data: { sessionID: "ses_a", nested: { apiKey: "[REDACTED]", authorization: "[REDACTED]", password: "[REDACTED]", tokens: { input: 42 } } } })
  expect(result.eventID).not.toBe(compatEnvelope({ kind: "result", command: "session.create", data: {} }, 456).eventID)
})

test("automation emits v1 result/error/event envelopes and retains the default schema", async () => {
  const lines: string[] = []
  const event = { type: "turn.completed", sessionId: "ses_a", seq: 7, at: 123, turnId: "turn_a" } as SessionEvent
  let listener: ((event: SessionEvent) => void) | undefined
  let reject = false
  const deps: AutomationDeps = {
    client: {
      send: async () => reject ? { ok: false, error: { code: "failed", message: "not found" } } : { ok: true, result: { sessionId: "ses_a" } },
      subscribe: async () => { listener?.(event); return { ok: true, result: { lastSeq: 7 } } },
    } as never,
    out: { write: (line) => lines.push(line) }, err: { write: () => {} }, cwd: "/tmp/project", now: () => 456,
    listen: (handler) => { listener = handler }, onInterrupt() {},
  }
  const run = async (...argv: string[]) => {
    lines.length = 0
    const parsed = parseAutomation(argv)
    if (parsed.ok !== true) throw new Error("bad test command")
    const code = await runAutomation(parsed.command, deps)
    return { code, output: lines.map((line) => JSON.parse(line)) }
  }
  expect(await run("session", "create", "--compat", COMPAT)).toMatchObject({ code: 0, output: [{ protocol: COMPAT, kind: "result", data: { sessionID: "ses_a" } }] })
  expect(await run("session", "create", "--json")).toMatchObject({ code: 0, output: [{ schema: SCHEMA, kind: "result", data: { sessionId: "ses_a" } }] })
  expect(await run("session", "events", "ses_a", "--compat", COMPAT)).toMatchObject({ code: 0, output: [{ protocol: COMPAT, kind: "event", event: "session.completed", data: { sequence: 7 } }] })
  reject = true
  expect(await run("session", "create", "--compat", COMPAT)).toMatchObject({ code: 1, output: [{ protocol: COMPAT, kind: "error", event: "error", data: { code: "failed", message: "not found" } }] })
})

test("headless compatibility translates lifecycle events and returns the normal exit code", async () => {
  const out: string[] = []
  const run = createHeadlessRun({ client: { send: async () => ({ ok: true, result: { queueId: "q_a" } }) } as never, sessionId: "ses_a" as never, prompt: "go", json: true, compat: true, approve: false, out: { write: (line) => out.push(line) }, err: { write() {} } })
  run.onEvent({ type: "turn.started", sessionId: "ses_a", seq: 1, at: 10, queueId: "q_a", turnId: "turn_a" } as SessionEvent)
  run.onEvent({ type: "turn.completed", sessionId: "ses_a", seq: 2, at: 20, turnId: "turn_a" } as SessionEvent)
  // The idle state follows the turn before the run settles (it settles after `finish`): the result stays the last line.
  run.onEvent({ type: "foreground.state", sessionId: "ses_a", seq: 3, at: 30, state: "idle" } as SessionEvent)
  expect(await run.start()).toBe(0)
  expect(out.map((line) => JSON.parse(line).event)).toEqual(["session.started", "session.completed"])
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ kind: "result", sessionID: "ses_a", data: { status: "completed" } })
  run.onEvent({ type: "foreground.state", sessionId: "ses_a", seq: 4, at: 40, state: "idle" } as SessionEvent)
  expect(out).toHaveLength(2)
})
