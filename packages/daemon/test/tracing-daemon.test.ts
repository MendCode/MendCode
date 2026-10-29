import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { TraceReport, createIdFactory, encodeFrame, PROTOCOL_VERSION, type Command, type Frame } from "@mendcode/protocol"
import { createClient } from "@mendcode/client"
import { boot, answer, hang, openSession, say, until } from "./native-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function native(steps: import("./native-harness").Step[]) {
  const h = await boot({ steps }); cleanups.push(h.cleanup); return h
}

test("local client opt-in correlates daemon/model/client spans without prompt, output or names", async () => {
  const h = await native([answer("private answer", { input: 10, output: 2 }), answer("private second answer", { input: 20, output: 3 })])
  const sessionId = await openSession(h)
  await say(h, sessionId, "private first prompt")
  expect(existsSync(path.join(h.dir, "trace.jsonl"))).toBe(false)
  expect((await h.client.traces()).ok).toBe(true)
  expect(await h.client.configureTrace(true)).toMatchObject({ ok: true })
  await say(h, sessionId, "private second prompt")
  const result = await h.client.traces(sessionId)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(TraceReport.safeParse(result.report).success).toBe(true)
  const spans = result.report.spans
  const llm = spans.find((span) => span.name === "session.llm")!
  const turn = spans.find((span) => span.name === "session.turn")!
  expect(llm.metadata).toMatchObject({ sessionId, turnId: turn.metadata.turnId, inputTokens: 20, outputTokens: 3, attempt: 0, role: "main" })
  expect(llm.parentSpanId).toBe(turn.spanId)
  expect(spans.some((span) => span.name === "client.event" && span.traceId === llm.traceId)).toBe(true)
  const clientCommand = spans.find((span) => span.name === "client.command")!
  expect(spans.some((span) => span.name === "daemon.command" && span.metadata.commandId === clientCommand.metadata.commandId)).toBe(true)
  expect(spans.some((span) => span.operation === "user.submit")).toBe(true)
  const text = `${JSON.stringify(result.report)}\n${readFileSync(path.join(h.dir, "trace.jsonl"), "utf8")}`
  for (const privateValue of ["private first prompt", "private second prompt", "private answer", "private second answer", "scripted", "script-1", h.project]) expect(text).not.toContain(privateValue)
}, 15_000)

test("initial trace option enables an existing daemon and the last client close disables diagnostics", async () => {
  const h = await native([])
  const client = createClient({ socketPath: h.daemon.socketPath, name: "traced-terminal", trace: true })
  cleanups.push(async () => client.close())
  await client.connect()
  const enabled = await h.client.traces()
  expect(enabled.ok && enabled.report.enabled).toBe(true)
  expect(await client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
  client.close()
  await until(() => h.daemon.connections() === 1)
  const disabled = await h.client.traces()
  expect(disabled.ok && disabled.report.enabled).toBe(false)
  if (disabled.ok) expect(disabled.report.spans.some((span) => span.operation === "daemon.info")).toBe(true)
}, 15_000)

test("a lost configure ack reapplies the same command ID to the replacement connection", async () => {
  const h = await native([])
  const ids = createIdFactory()
  const clientId = ids("client")
  const configure: Command = { id: ids("command"), clientId, type: "trace.configure", enabled: true }
  async function raw() {
    let buffer = ""
    const frames: Frame[] = []
    const socket = await Bun.connect({ unix: h.daemon.socketPath, socket: { data(_socket, bytes) {
      buffer += new TextDecoder().decode(bytes)
      for (;;) {
        const at = buffer.indexOf("\n")
        if (at < 0) break
        frames.push(JSON.parse(buffer.slice(0, at)))
        buffer = buffer.slice(at + 1)
      }
    } } })
    cleanups.push(async () => { socket.end() })
    const send = async (body: Command) => {
      socket.write(encodeFrame({ v: PROTOCOL_VERSION, kind: "command", body }))
      await until(() => frames.some((frame) => (frame.kind === "ack" || frame.kind === "error") && frame.id === body.id))
      return frames.find((frame) => (frame.kind === "ack" || frame.kind === "error") && frame.id === body.id)!
    }
    await send({ id: ids("command"), clientId, type: "hello", protocolVersion: PROTOCOL_VERSION, client: { name: "trace-retry", version: "test" }, capabilities: [] })
    return { socket, send }
  }
  const first = await raw()
  expect((await first.send(configure)).kind).toBe("ack")
  first.socket.end()
  await until(() => h.daemon.connections() === 1)
  const off = await h.client.traces()
  expect(off.ok && off.report.enabled).toBe(false)
  const next = await raw()
  expect((await next.send(configure)).kind).toBe("ack")
  const on = await h.client.traces()
  expect(on.ok && on.report.enabled).toBe(true)
}, 15_000)

test("trace opt-in is restored after reconnect and opt-out immediately stops all samples", async () => {
  const h = await native([answer("one", { input: 10, output: 2 }), answer("two", { input: 20, output: 3 })])
  const sessionId = await openSession(h)
  await h.client.configureTrace(true)
  h.client.dropConnection()
  expect(await h.client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
  const enabled = await h.client.traces()
  expect(enabled.ok && enabled.report.enabled).toBe(true)
  await say(h, sessionId, "one")
  await h.client.configureTrace(false)
  const before = readFileSync(path.join(h.dir, "trace.jsonl"), "utf8")
  h.client.recordTrace({ name: "tui.frame", metadata: { sessionId, cols: 100, rows: 30 }, durationMs: 1, status: "ok" })
  await say(h, sessionId, "two")
  const disabled = await h.client.traces()
  expect(disabled.ok && disabled.report.enabled).toBe(false)
  expect(readFileSync(path.join(h.dir, "trace.jsonl"), "utf8")).toBe(before)
}, 15_000)

test("OpenTelemetry persists across daemon restart and records model spans with diagnostics off", async () => {
  const h = await native([])
  expect(await h.client.send({ type: "settings.set", patch: { experimental: { openTelemetry: true } } })).toMatchObject({ ok: true })
  h.client.close()
  await h.daemon.stop()
  const next = await boot({ dir: h.dir, project: h.project, steps: [answer("private output", { input: 40, output: 5 }), answer("untraced", { input: 80, output: 6 })] })
  cleanups.push(next.cleanup)
  const sessionId = await openSession(next)
  await say(next, sessionId, "private prompt")
  const result = await next.client.traces()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.report).toMatchObject({ enabled: false, openTelemetry: true, exporter: "off" })
  expect(result.report.spans.map((span) => span.name)).toEqual(["session.llm", "session.turn"])
  await next.client.send({ type: "settings.set", patch: { experimental: { openTelemetry: false } } })
  const before = readFileSync(path.join(h.dir, "trace.jsonl"), "utf8")
  await say(next, sessionId, "untraced")
  expect(readFileSync(path.join(h.dir, "trace.jsonl"), "utf8")).toBe(before)
}, 15_000)

test("model failures and cancellations close spans without error strings", async () => {
  const h = await native([() => { throw new Error("private provider failure") }, hang])
  const sessionId = await openSession(h)
  await h.client.configureTrace(true)
  await say(h, sessionId, "private failed prompt")
  await h.client.send({ type: "user.submit", sessionId, text: "private cancelled prompt", attachments: [] })
  await until(() => h.requests.length === 2)
  const started = h.events.filter((event) => event.type === "turn.started").at(-1)!
  if (started.type !== "turn.started") throw new Error("turn missing")
  await h.client.send({ type: "turn.cancel", sessionId, turnId: started.turnId })
  await until(() => h.events.some((event) => event.type === "turn.cancelled" && event.turnId === started.turnId))
  const result = await h.client.traces(sessionId)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.report.spans.filter((span) => span.name === "session.llm").map((span) => span.status)).toEqual(["error", "cancelled"])
  expect(JSON.stringify(result.report)).not.toContain("private")
}, 15_000)
