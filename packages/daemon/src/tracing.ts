import { createHash, randomBytes } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs"
import path from "node:path"
import { TraceMetadata, type SessionId, type TracePort, type TraceReport, type TraceSample, type TraceSpan } from "@mendcode/protocol"

const MAX_SPANS = 512
const MAX_BYTES = 1_048_576
const MAX_EXPORT_QUEUE = 256
export type OtlpExporter = { endpoint: string; token: string; send?(body: string, signal: AbortSignal): Promise<void>; request?(url: string, init: RequestInit): Promise<Response> }

export function validateOtlp(exporter: OtlpExporter) {
  let url: URL
  try { url = new URL(exporter.endpoint) } catch { throw new Error("OTLP requires a literal loopback HTTP(S) endpoint and token") }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !exporter.token || /[\r\n]/.test(exporter.token)) throw new Error("OTLP requires a literal loopback HTTP(S) endpoint and token")
}

export function otlpFromEnvironment(env: Record<string, string | undefined>): OtlpExporter | undefined {
  if (!env.MENDCODE_OTEL_ENDPOINT) return undefined
  const exporter = { endpoint: env.MENDCODE_OTEL_ENDPOINT, token: env.MENDCODE_OTEL_TOKEN ?? "" }
  validateOtlp(exporter)
  return exporter
}

/** OTLP/HTTP JSON: hex IDs, integer enums and decimal nanosecond timestamps. */
export function otlpBody(spans: TraceSpan[]) {
  const keys: Record<keyof TraceMetadata, string> = { sessionId: "session.id", turnId: "mendcode.turn.id", commandId: "mendcode.command.id", seq: "mendcode.event.seq", role: "mendcode.role", attempt: "mendcode.attempt", inputTokens: "gen_ai.usage.input_tokens", outputTokens: "gen_ai.usage.output_tokens", cacheReadTokens: "mendcode.usage.cache_read_tokens", cacheWriteTokens: "mendcode.usage.cache_write_tokens", firstTokenMs: "mendcode.first_token_ms", cols: "mendcode.tui.cols", rows: "mendcode.tui.rows", backlog: "mendcode.queue.backlog" }
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "mendcode" } }] }, scopeSpans: [{ scope: { name: "mendcode.tracing", version: "1" }, spans: spans.map((span) => ({
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.name === "session.llm" || span.name === "client.command" ? 3 : span.name === "daemon.command" ? 2 : 1,
    startTimeUnixNano: String(BigInt(span.startedAt) * 1_000_000n),
    endTimeUnixNano: String(BigInt(span.startedAt) * 1_000_000n + BigInt(Math.round(span.durationMs * 1_000_000))),
    attributes: [...Object.entries(span.metadata).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key: keys[key as keyof TraceMetadata], value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } })), ...(span.operation ? [{ key: "mendcode.operation", value: { stringValue: span.operation } }] : []), ...(span.status === "cancelled" ? [{ key: "mendcode.cancelled", value: { boolValue: true } }] : [])],
    status: { code: span.status === "error" ? 2 : span.status === "ok" ? 1 : 0 },
  })) }] }] })
}

async function sendOtlp(exporter: OtlpExporter, body: string, signal: AbortSignal) {
  if (exporter.send) return exporter.send(body, signal)
  const response = await (exporter.request ?? fetch)(exporter.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${exporter.token}` }, body, redirect: "error", signal })
  try {
    if (response.status !== 200) throw new Error("OTLP rejected")
    const reader = response.body?.getReader()
    if (!reader) return
    try {
      let text = ""
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
        if (text.length > 8192) throw new Error("OTLP response too large")
      }
      const result = text.trim() ? JSON.parse(text) : {}
      if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0) throw new Error("OTLP partially rejected")
    } finally { await reader.cancel() }
  } finally { await response.body?.cancel().catch(() => {}) }
}

export function createTracing(options: { dir: string; enabled(): boolean; openTelemetry(): boolean; exporter?: OtlpExporter; now?: () => number }) {
  if (options.exporter) validateOtlp(options.exporter)
  const now = options.now ?? Date.now
  const runId = randomBytes(16).toString("hex")
  const spans: TraceSpan[] = []
  const turns = new Map<string, TraceSpan>()
  const queue: TraceSpan[] = []
  let dropped = 0
  let exportErrors = 0
  let writeErrors = 0
  let exporting: Promise<void> | undefined
  let closed = false

  function exportQueued() {
    if (exporting || !options.exporter || closed) return
    exporting = (async () => {
      while (queue.length && options.openTelemetry() && !closed) {
        const batch = queue.splice(0, 64)
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([sendOtlp(options.exporter!, otlpBody(batch), controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("OTLP timeout")) }, 1000) })])
        } catch { exportErrors += batch.length }
        finally { clearTimeout(timer) }
      }
      if (!options.openTelemetry()) queue.length = 0
    })().finally(() => { exporting = undefined })
  }

  function record(span: TraceSpan) {
    if (closed || !(options.enabled() || options.openTelemetry())) return
    const metadata = TraceMetadata.safeParse(span.metadata)
    if (!metadata.success) { dropped++; return }
    span = { ...span, metadata: metadata.data }
    if (spans.length === MAX_SPANS) { spans.shift(); dropped++ }
    spans.push(span)
    let fd: number | undefined
    try {
      fd = openSync(path.join(options.dir, "trace.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      fchmodSync(fd, 0o600)
      const line = `${JSON.stringify(span)}\n`
      if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_BYTES) ftruncateSync(fd, 0)
      writeSync(fd, line)
    } catch { writeErrors++ }
    finally { if (fd !== undefined) closeSync(fd) }
    if (options.openTelemetry() && options.exporter) {
      if (queue.length === MAX_EXPORT_QUEUE) { queue.shift(); dropped++ }
      queue.push(span)
      exportQueued()
    }
  }

  function start(name: TraceSpan["name"], metadata: TraceMetadata = {}, durationMs?: number, operation?: Parameters<TracePort["start"]>[2]): ReturnType<TracePort["start"]> {
    if (closed || !(options.enabled() || (name === "session.llm" || name === "session.turn") && options.openTelemetry())) return { end() {} }
    const parent = metadata.turnId ? turns.get(metadata.turnId) : undefined
    const span: TraceSpan = { name, metadata, ...(operation ? { operation } : {}), traceId: parent?.traceId ?? createHash("sha256").update(`${runId}:${metadata.sessionId ?? "daemon"}`).digest("hex").slice(0, 32), spanId: randomBytes(8).toString("hex"), ...(parent ? { parentSpanId: parent.spanId } : {}), startedAt: Math.max(0, now() - Math.floor(durationMs ?? 0)), durationMs: 0, status: "ok" }
    if (name === "session.turn" && metadata.turnId) turns.set(metadata.turnId, span)
    const started = performance.now()
    let ended = false
    return { end(status = "ok", extra = {}) {
      if (ended) return
      ended = true
      if (name === "session.turn" && metadata.turnId) turns.delete(metadata.turnId)
      record({ ...span, status, metadata: { ...metadata, ...extra }, durationMs: durationMs ?? Math.max(0, performance.now() - started) })
    } }
  }
  const port: TracePort = { start: (name, metadata, operation) => start(name, metadata, undefined, operation) }
  return {
    ...port,
    sample(sample: TraceSample) {
      if (!options.enabled()) return
      // Client clocks are not trusted; use daemon receipt time and the bounded duration only.
      start(sample.name, sample.metadata, sample.durationMs).end(sample.status)
    },
    report(sessionId?: SessionId, limit = MAX_SPANS): TraceReport {
      return { enabled: options.enabled(), openTelemetry: options.openTelemetry(), exporter: options.exporter ? "loopback" : "off", dropped, exportErrors, writeErrors, spans: spans.filter((span) => !sessionId || span.metadata.sessionId === sessionId).slice(-limit).map((span) => structuredClone(span)) }
    },
    async stop() { queue.length = 0; closed = true; await exporting; turns.clear() },
  }
}
