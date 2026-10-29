import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TraceReport, createIdFactory, type TraceMetadata } from "@mendcode/protocol"
import { createTracing, otlpBody, otlpFromEnvironment, validateOtlp } from "../src/tracing"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-trace-")); dirs.push(dir); return dir }
const ids = createIdFactory()

test("disabled tracing creates no file or exporter work", async () => {
  const dir = temp()
  let exports = 0
  const trace = createTracing({ dir, enabled: () => false, openTelemetry: () => false, exporter: { endpoint: "http://127.0.0.1:4318/v1/traces", token: "test", send: async () => { exports++ } } })
  trace.start("session.llm", { sessionId: ids("session") }).end()
  trace.sample({ name: "tui.frame", metadata: {}, durationMs: 10, status: "ok" })
  expect(trace.report().spans).toEqual([])
  expect(existsSync(path.join(dir, "trace.jsonl"))).toBe(false)
  expect(exports).toBe(0)
  await trace.stop()
})

test("turn/model/client correlation survives interleaving and duration matches the file", async () => {
  const dir = temp()
  let enabled = true
  const trace = createTracing({ dir, enabled: () => enabled, openTelemetry: () => false })
  const a = { sessionId: ids("session"), turnId: ids("turn") }
  const b = { sessionId: ids("session"), turnId: ids("turn") }
  const turnA = trace.start("session.turn", a)
  const turnB = trace.start("session.turn", b)
  trace.start("session.llm", a).end("ok", { inputTokens: 20, outputTokens: 2 })
  trace.start("session.llm", b).end("error")
  trace.sample({ name: "client.event", metadata: { ...a, seq: 3 }, durationMs: 12.5, status: "ok" })
  turnB.end("error")
  turnA.end()
  turnA.end()
  const spans = trace.report().spans
  expect(spans).toHaveLength(5)
  const llmA = spans.find((span) => span.name === "session.llm" && span.metadata.sessionId === a.sessionId)!
  const rootA = spans.find((span) => span.name === "session.turn" && span.metadata.sessionId === a.sessionId)!
  expect(llmA.parentSpanId).toBe(rootA.spanId)
  expect(llmA.traceId).toBe(rootA.traceId)
  expect(spans.find((span) => span.metadata.sessionId === b.sessionId)!.traceId).not.toBe(llmA.traceId)
  expect(spans.find((span) => span.name === "client.event")?.durationMs).toBe(12.5)
  expect(readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(spans)
  expect(statSync(path.join(dir, "trace.jsonl")).mode & 0o777).toBe(0o600)
  expect(TraceReport.safeParse(trace.report()).success).toBe(true)
  const pending = trace.start("session.llm", a)
  enabled = false
  pending.end()
  expect(trace.report().spans).toHaveLength(5)
  await trace.stop()
})

test("ring, disk and content allowlist stay bounded", async () => {
  const dir = temp()
  const trace = createTracing({ dir, enabled: () => true, openTelemetry: () => false })
  const metadata = { sessionId: ids("session"), turnId: ids("turn"), commandId: ids("command"), role: "main" as const, seq: 3, cols: 100, rows: 30, inputTokens: 200, outputTokens: 10 }
  for (let i = 0; i < 3000; i++) trace.start("session.llm", metadata).end()
  trace.start("session.llm", { ...metadata, text: "private content" } as TraceMetadata).end()
  expect(trace.report().spans).toHaveLength(512)
  expect(trace.report().dropped).toBe(3000 - 512 + 1)
  expect(trace.report(metadata.sessionId, 1).spans).toHaveLength(1)
  expect(statSync(path.join(dir, "trace.jsonl")).size).toBeLessThanOrEqual(1_048_576)
  expect(readFileSync(path.join(dir, "trace.jsonl"), "utf8")).not.toContain("private content")
  await trace.stop()
}, 20_000)

test("trace storage refuses symlinks and IO failure does not stop work", async () => {
  const dir = temp()
  const target = path.join(dir, "unrelated.txt")
  writeFileSync(target, "preserve")
  symlinkSync(target, path.join(dir, "trace.jsonl"))
  const trace = createTracing({ dir, enabled: () => true, openTelemetry: () => false })
  expect(() => trace.start("session.llm").end()).not.toThrow()
  expect(trace.report().writeErrors).toBe(1)
  expect(readFileSync(target, "utf8")).toBe("preserve")
  await trace.stop()
})

test("OTLP requires token and literal loopback without URL credentials, query or fragment", () => {
  for (const endpoint of ["http://127.0.0.1:4318/v1/traces", "https://[::1]:4318/v1/traces"]) expect(() => validateOtlp({ endpoint, token: "test" })).not.toThrow()
  for (const endpoint of ["https://collector.example/v1/traces", "http://localhost:4318", "file:///tmp/trace", "http://user:pass@127.0.0.1/", "http://127.0.0.1/?token=x", "http://127.0.0.1/#x", "invalid"]) expect(() => validateOtlp({ endpoint, token: "test" })).toThrow("literal loopback")
  expect(() => validateOtlp({ endpoint: "http://127.0.0.1/", token: "" })).toThrow()
  expect(() => validateOtlp({ endpoint: "http://127.0.0.1/", token: "a\r\nb" })).toThrow()
  expect(otlpFromEnvironment({ MENDCODE_OTEL_TOKEN: "test" })).toBeUndefined()
  expect(() => otlpFromEnvironment({ MENDCODE_OTEL_ENDPOINT: "http://127.0.0.1/" })).toThrow()
})

test("OTLP exports safe numeric usage with valid timestamps, IDs, status and parents", async () => {
  const dir = temp()
  const bodies: string[] = []
  const trace = createTracing({ dir, enabled: () => false, openTelemetry: () => true, exporter: { endpoint: "http://127.0.0.1:4318/v1/traces", token: "do-not-record", send: async (body) => { bodies.push(body) } } })
  const metadata = { sessionId: ids("session"), turnId: ids("turn"), role: "main" as const }
  const turn = trace.start("session.turn", metadata)
  trace.start("session.llm", metadata).end("cancelled", { inputTokens: 40, outputTokens: 2, firstTokenMs: 1 })
  turn.end("cancelled")
  await Bun.sleep(5)
  const report = trace.report()
  expect(report.spans).toHaveLength(2)
  const payload = JSON.parse(otlpBody(report.spans))
  const exported = payload.resourceSpans[0].scopeSpans[0].spans
  expect(exported[0].kind).toBe(3)
  expect(exported[0].status.code).toBe(0)
  expect(exported[0].parentSpanId).toBe(exported[1].spanId)
  expect(exported[0].attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "40" } })
  expect(exported[0].attributes).toContainEqual({ key: "mendcode.cancelled", value: { boolValue: true } })
  expect(exported[0].startTimeUnixNano).toMatch(/^\d+$/)
  expect(BigInt(exported[0].endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(exported[0].startTimeUnixNano))
  expect(bodies.join("\n")).not.toContain("do-not-record")
  expect(bodies.length).toBeGreaterThan(0)
  await trace.stop()
})

test("collector failure is isolated and a stalled exporter has a bounded queue and shutdown", async () => {
  const dir = temp()
  const failed = createTracing({ dir, enabled: () => false, openTelemetry: () => true, exporter: { endpoint: "http://127.0.0.1:4318/v1/traces", token: "test", send: async () => { throw new Error("private error") } } })
  failed.start("session.llm").end()
  await Bun.sleep(5)
  expect(failed.report().exportErrors).toBe(1)
  expect(JSON.stringify(failed.report())).not.toContain("private error")
  await failed.stop()
  const stalled = createTracing({ dir, enabled: () => false, openTelemetry: () => true, exporter: { endpoint: "http://127.0.0.1:4318/v1/traces", token: "test", send: async () => new Promise(() => {}) } })
  for (let i = 0; i < 300; i++) stalled.start("session.llm").end()
  expect(stalled.report().dropped).toBe(43)
  await stalled.stop()
  expect(stalled.report().exportErrors).toBe(1)
})

test("HTTP export uses bearer auth, refuses redirects and handles bounded collector responses without network", async () => {
  for (const [body, status, errors] of [["{}", 200, 0], ["{}", 302, 1], ['{"partialSuccess":{"rejectedSpans":"1","errorMessage":"private rejection"}}', 200, 1], ["x".repeat(8193), 200, 1], ["invalid JSON", 200, 1]] as const) {
    const trace = createTracing({ dir: temp(), enabled: () => false, openTelemetry: () => true, exporter: { endpoint: "http://127.0.0.1:4318/v1/traces", token: "private-token", request: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:4318/v1/traces")
      expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-token", "Content-Type": "application/json" } })
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(String(init.body)).not.toContain("private-token")
      return new Response(body, { status })
    } } })
    trace.start("session.llm").end()
    await Bun.sleep(5)
    expect(trace.report().exportErrors).toBe(errors)
    expect(JSON.stringify(trace.report())).not.toContain("private")
    await trace.stop()
  }
})
