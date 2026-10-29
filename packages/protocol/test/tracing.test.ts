import { expect, test } from "bun:test"
import { Command, Settings, TraceReport, TraceSample, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("OpenTelemetry remains an optional opt-in setting", () => {
  expect(Settings.parse({})).toEqual({})
  expect(Settings.parse({ experimental: { openTelemetry: false } }).experimental?.openTelemetry).toBe(false)
  expect(Settings.parse({ experimental: { openTelemetry: true } }).experimental?.openTelemetry).toBe(true)
  expect(Settings.safeParse({ experimental: { openTelemetry: "yes" } }).success).toBe(false)
})

test("trace commands are additive and only the content-free query is read-only", () => {
  expect(Command.parse({ ...base, type: "trace.configure", enabled: true }).type).toBe("trace.configure")
  expect(Command.parse({ ...base, type: "trace.query", limit: 512 }).type).toBe("trace.query")
  expect(Command.safeParse({ ...base, type: "trace.query", limit: 513 }).success).toBe(false)
  expect(isReadOnlyCommand("trace.query")).toBe(true)
  expect(isReadOnlyCommand("trace.configure")).toBe(false)
  expect(isReadOnlyCommand("trace.record")).toBe(false)
})

test("client samples reject arbitrary content, IDs, durations and span names", () => {
  const sample = { name: "tui.frame", metadata: { sessionId: ids("session"), cols: 100, rows: 30 }, durationMs: 2, status: "ok" }
  expect(TraceSample.safeParse(sample).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "trace.record", sample }).success).toBe(true)
  for (const patch of [{ name: "secret" }, { name: "session.llm" }, { durationMs: Infinity }, { durationMs: -1 }, { durationMs: 86_400_001 }, { text: "private answer" }, { operation: "private operation" }, { metadata: { prompt: "private prompt" } }, { metadata: { sessionId: "user-content" } }, { metadata: { outputTokens: NaN } }]) expect(TraceSample.safeParse({ ...sample, ...patch }).success).toBe(false)
})

test("trace reports reject sensitive fields and unbounded inventory", () => {
  const report = { enabled: false, openTelemetry: false, exporter: "off", dropped: 0, exportErrors: 0, writeErrors: 0, spans: [] }
  expect(TraceReport.safeParse(report).success).toBe(true)
  expect(TraceReport.safeParse({ ...report, token: "private" }).success).toBe(false)
  expect(TraceReport.safeParse({ ...report, spans: Array(513).fill({}) }).success).toBe(false)
})
