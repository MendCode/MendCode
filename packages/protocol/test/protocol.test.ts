import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  Command,
  GlobalEvent,
  MAX_FRAME_BYTES,
  MAX_INLINE_TEXT,
  SessionEvent,
  createIdFactory,
  decodeFrame,
  encodeFrame,
  isCompatibleVersion,
  type Frame,
} from "../src"

let seed = 0
const id = createIdFactory({ now: () => 1_790_000_000_000, random: (n) => new Uint8Array(n).fill(seed++ % 32) })
const sessionId = id("session")
const clientId = id("client")
const turnId = id("turn")

describe("ids", () => {
  test("generated ids carry their prefix and validate against their own schema only", () => {
    expect(sessionId.startsWith("ses_")).toBe(true)
    expect(Command.safeParse({ id: id("command"), clientId, type: "turn.cancel", sessionId, turnId }).success).toBe(true)
    expect(Command.safeParse({ id: id("command"), clientId, type: "turn.cancel", sessionId: turnId, turnId }).success).toBe(false)
  })

  test("ids generated in the same millisecond stay strictly ordered", () => {
    const next = createIdFactory({ now: () => 1_790_000_000_000, random: (n) => new Uint8Array(n) })
    const ids = Array.from({ length: 50 }, () => next("item"))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(50)
  })

  test("an invalid clock is rejected instead of producing a malformed id", () => {
    const next = createIdFactory({ now: () => -1 })
    expect(() => next("job")).toThrow(RangeError)
  })
})

describe("commands", () => {
  test("user.submit parses with blob attachments and rejects unknown fields", () => {
    const base = { id: id("command"), clientId, type: "user.submit", sessionId, text: "hola", attachments: [] }
    expect(Command.safeParse(base).success).toBe(true)
    expect(Command.safeParse({ ...base, foregroundState: "idle" }).success).toBe(false)
    expect(
      Command.safeParse({ ...base, attachments: [{ sha256: "a".repeat(64), bytes: 10, mime: "image/png" }] }).success,
    ).toBe(true)
  })

  test("inline text above MAX_INLINE_TEXT must go through the blob store", () => {
    const text = "x".repeat(MAX_INLINE_TEXT + 1)
    expect(Command.safeParse({ id: id("command"), clientId, type: "user.submit", sessionId, text, attachments: [] }).success).toBe(false)
  })

  test("turn.cancel requires an explicit turn target", () => {
    expect(Command.safeParse({ id: id("command"), clientId, type: "turn.cancel", sessionId }).success).toBe(false)
  })

  test("only the current protocol version is compatible", () => {
    expect(isCompatibleVersion(1)).toBe(true)
    expect(isCompatibleVersion(2)).toBe(false)
  })
})

describe("events", () => {
  const at = 1_790_000_000_000

  test("every item lifecycle event parses", () => {
    const itemId = id("item")
    const events = [
      { sessionId, seq: 1, at, type: "turn.started", turnId, queueId: id("queue") },
      { sessionId, seq: 2, at, type: "item.started", turnId, itemId, kind: "agent_message" },
      { sessionId, seq: 3, at, type: "item.delta", itemId, text: "ho" },
      { sessionId, seq: 4, at, type: "item.completed", itemId, status: "ok", text: "hola" },
      { sessionId, seq: 5, at, type: "turn.completed", turnId },
    ]
    for (const event of events) expect(SessionEvent.safeParse(event).success).toBe(true)
  })

  test("a transport loss is an interruption, not a user cancel", () => {
    expect(SessionEvent.safeParse({ sessionId, seq: 1, at, type: "turn.cancelled", turnId, by: "transport" }).success).toBe(false)
    expect(SessionEvent.safeParse({ sessionId, seq: 1, at, type: "turn.interrupted", turnId, reason: "transport" }).success).toBe(true)
  })

  test("seq must be positive", () => {
    expect(SessionEvent.safeParse({ sessionId, seq: 0, at, type: "turn.completed", turnId }).success).toBe(false)
  })

  test("job events cannot carry a foreground state (I3)", () => {
    const job = { gseq: 1, at, type: "job.state", jobId: id("job"), jobType: "dream", state: "running" }
    expect(GlobalEvent.safeParse(job).success).toBe(true)
    expect(GlobalEvent.safeParse({ ...job, foregroundState: "generating" }).success).toBe(false)
    expect(GlobalEvent.safeParse({ ...job, sessionId }).success).toBe(false)
  })

  test("quota snapshots bound usedPercent to 0–100", () => {
    const quota = {
      gseq: 2,
      at,
      type: "quota.snapshot",
      provider: "claude",
      windows: [{ id: "five_hour", label: "5h", usedPercent: 12, resetsAt: 1_790_479_800_000, windowMinutes: 300 }],
      fetchedAt: at,
      source: "claude-code rate_limit_event",
    }
    expect(GlobalEvent.safeParse(quota).success).toBe(true)
    expect(GlobalEvent.safeParse({ ...quota, windows: [{ id: "x", label: "x", usedPercent: 120 }] }).success).toBe(false)
  })
})

describe("frames", () => {
  test("encode/decode round-trips a command frame", () => {
    const frame: Frame = {
      v: 1,
      kind: "command",
      body: { id: id("command"), clientId, type: "client.subscribe", sessionId, afterSeq: 0 },
    }
    const decoded = decodeFrame(encodeFrame(frame).trimEnd())
    expect(decoded).toEqual({ ok: true, frame })
  })

  test("malformed, oversized and wrong-version frames are rejected with a tagged error", () => {
    expect(decodeFrame("{not json").ok).toBe(false)
    expect(decodeFrame(JSON.stringify({ v: 2, kind: "ack", id: id("command") })).ok).toBe(false)
    const huge = decodeFrame("x".repeat(MAX_FRAME_BYTES + 1))
    expect(huge.ok).toBe(false)
    if (!huge.ok) expect(huge.error.startsWith("[PROTOCOL]:")).toBe(true)
  })
})

describe("boundaries", () => {
  test("protocol source imports nothing but zod and its own modules", () => {
    const dir = path.join(import.meta.dir, "../src")
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8")
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = match[1] ?? ""
        expect(spec === "zod" || spec.startsWith("./")).toBe(true)
      }
    }
  })
})


test("remote auth frames are additive, bounded and structurally checked by thin clients", async () => {
  const { decodeTrustedFrame } = await import("../src/wire")
  const frame: Frame = { v: 1, kind: "auth", id: id("command"), token: "temporary-test-token" }
  const line = encodeFrame(frame).trimEnd()
  expect(decodeFrame(line)).toEqual({ ok: true, frame })
  expect(decodeTrustedFrame(line)).toEqual({ ok: true, frame })
  expect(decodeFrame(JSON.stringify({ ...frame, token: "" })).ok).toBe(false)
  expect(decodeFrame(JSON.stringify({ ...frame, token: "x".repeat(4097) })).ok).toBe(false)
  expect(decodeFrame(JSON.stringify({ ...frame, extra: "unknown" })).ok).toBe(false)
  expect(decodeTrustedFrame(JSON.stringify({ ...frame, token: 123 })).ok).toBe(false)
  const oversized = JSON.stringify({ v: 1, kind: "ack", id: id("command"), result: { text: "😀".repeat(MAX_FRAME_BYTES / 3) } })
  expect(decodeTrustedFrame(oversized).ok).toBe(false)
})
