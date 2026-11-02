// Offline persistence probe, not an end-to-end agent benchmark. No providers or user databases.
// bun scripts/session-disk-probe.ts [--pi-manager /absolute/path/to/pi/dist/core/session-manager.js]
import { mkdtempSync, statSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { createIdFactory } from "../packages/protocol/src"
import { openStore } from "../packages/store/src"

const root = mkdtempSync(path.join(tmpdir(), "mend-session-disk-"))
const count = 100
const ids = createIdFactory()
const request = "Read src/theme.ts and list each color name with its hex value. Do not edit any file."
const colors = { background: "#101218", foreground: "#e6e9ef", accent: "#ff5a36", success: "#3fbf8f", warning: "#f2b84b", danger: "#ff5c7a" }
const output = `export const colors = ${JSON.stringify(colors, null, 2)}\n`
const answer = Object.entries(colors).map(([name, hex]) => `- ${name}: ${hex}`).join("\n").repeat(process.argv.includes("--long") ? 40 : 1)
const timestamp = 1_700_000_000_000
const usage = { input: 100, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 180, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const samples: Record<string, unknown> = {}
function disk(dir: string): { bytes: number; allocated: number } {
  let bytes = 0, allocated = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { const sub = disk(file); bytes += sub.bytes; allocated += sub.allocated }
    else { const s = statSync(file); bytes += s.size; allocated += s.blocks * 512 }
  }
  return { bytes, allocated }
}
function percentile(values: number[], p: number) { return +values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!.toFixed(3) }

const dir = path.join(root, "mendcode")
let store = openStore({ dir })
store.close()
const base = disk(dir)
store = openStore({ dir })
const sessions: ReturnType<typeof ids<"session">>[] = []
const writes: number[] = []
const streamingWrites: number[] = []
const completions: number[] = []
let streamingCpuUs = 0
let completionCpuUs = 0
let turnCpuUs = 0
for (let i = 0; i < count; i++) {
  const start = performance.now()
  const turnCpu = process.cpuUsage()
  const sessionId = ids("session"), turnId = ids("turn"), user = ids("item"), tool = ids("item"), assistant = ids("item")
  sessions.push(sessionId)
  store.createSession({ id: sessionId, directory: "/probe/project", title: "colors" })
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: user, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: user, status: "ok", text: request })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: tool, kind: "tool_call", meta: { tool: "read" } })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: tool, status: "ok", text: output, toolInput: JSON.stringify({ path: "src/theme.ts" }) })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: assistant, kind: "agent_message" })
  const streamingCpu = process.cpuUsage()
  const chunkSize = process.argv.includes("--long") ? 120 : 3
  for (let n = 0; n < answer.length; n += chunkSize) {
    const at = performance.now()
    store.sessionSink.append({ type: "item.delta", sessionId, itemId: assistant, text: answer.slice(n, n + chunkSize) })
    streamingWrites.push(performance.now() - at)
  }
  const streamingUsed = process.cpuUsage(streamingCpu)
  streamingCpuUs += streamingUsed.user + streamingUsed.system
  const completionStart = performance.now(), completionCpu = process.cpuUsage()
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: assistant, status: "ok", text: answer })
  completions.push(performance.now() - completionStart)
  const completionUsed = process.cpuUsage(completionCpu)
  completionCpuUs += completionUsed.user + completionUsed.system
  store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "probe", model: "offline", input: 100, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  store.engineMessages.save(sessionId, "native", [
    { role: "user", content: request },
    { role: "assistant", content: "", toolCalls: [{ id: tool, name: "read", input: { path: "src/theme.ts" } }] },
    { role: "tool", toolCallId: tool, content: output },
    { role: "assistant", content: answer },
  ])
  writes.push(performance.now() - start)
  const turnUsed = process.cpuUsage(turnCpu)
  turnCpuUs += turnUsed.user + turnUsed.system
}
const closeStart = performance.now(); store.close(); const closeMs = performance.now() - closeStart
const size = disk(dir)
const openStart = performance.now(); store = openStore({ dir }); const openMs = performance.now() - openStart
const reads: number[] = []
for (const id of sessions) {
  const start = performance.now()
  const events = store.readAfter(id, 0, 1000)
  if (!events.some(e => e.type === "item.completed" && e.text === answer) || store.engineMessages.load(id, "native").length !== 4) throw new Error("MendCode roundtrip failed")
  reads.push(performance.now() - start)
}
store.close()
const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
const eventBytes = db.query<{ n: number }, []>("SELECT sum(octet_length(payload)) AS n FROM events").get()!.n
const modelBytes = db.query<{ n: number }, []>("SELECT sum(octet_length(payload)) AS n FROM engine_messages").get()!.n
db.close()
samples.mendcode = { count, eventPayloadBytesPerSession: eventBytes / count, modelPayloadBytesPerSession: modelBytes / count, fileGrowthPerSession: (size.bytes - base.bytes) / count, allocatedGrowthPerSession: (size.allocated - base.allocated) / count, emptyStoreBytes: base.bytes, writeP50Ms: percentile(writes, .5), writeP95Ms: percentile(writes, .95), readP50Ms: percentile(reads, .5), readP95Ms: percentile(reads, .95), openMs, closeMs,
  streamingEventCount: streamingWrites.length, streamingWriteP50Ms: percentile(streamingWrites, .5), streamingWriteP95Ms: percentile(streamingWrites, .95), streamingCpuUsPerEvent: streamingCpuUs / streamingWrites.length,
  completionP50Ms: percentile(completions, .5), completionP95Ms: percentile(completions, .95), completionCpuUsPerItem: completionCpuUs / count, turnCpuUsPerSession: turnCpuUs / count }

const piArg = process.argv.indexOf("--pi-manager")
if (piArg >= 0) {
  const manager = process.argv[piArg + 1]
  if (!manager || !path.isAbsolute(manager)) throw new Error("--pi-manager requires an absolute installed module path")
  const { SessionManager } = await import(pathToFileURL(manager).href)
  const piDir = path.join(root, "pi")
  const writeTimes: number[] = [], readTimes: number[] = []
  const files: string[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    const session = SessionManager.create("/probe/project", piDir)
    session.appendModelChange("probe", "offline")
    session.appendThinkingLevelChange("off")
    session.appendMessage({ role: "user", content: request, timestamp })
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/theme.ts" } }], api: "openai-completions", provider: "probe", model: "offline", usage, stopReason: "toolUse", timestamp })
    session.appendMessage({ role: "toolResult", toolCallId: "call_read", toolName: "read", content: [{ type: "text", text: output }], isError: false, timestamp })
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: answer }], api: "openai-completions", provider: "probe", model: "offline", usage, stopReason: "stop", timestamp })
    files.push(session.getSessionFile())
    writeTimes.push(performance.now() - start)
  }
  for (const file of files) {
    const start = performance.now()
    const context = SessionManager.open(file).buildSessionContext()
    if (context.messages.length !== 4 || context.messages[3].content[0].text !== answer) throw new Error("Pi roundtrip failed")
    readTimes.push(performance.now() - start)
  }
  const size = disk(piDir)
  samples.pi = { count, fileBytesPerSession: size.bytes / count, allocatedBytesPerSession: size.allocated / count, writeP50Ms: percentile(writeTimes, .5), writeP95Ms: percentile(writeTimes, .95), openAndReadP50Ms: percentile(readTimes, .5), openAndReadP95Ms: percentile(readTimes, .95) }
}
console.log(JSON.stringify({ root, scope: "offline real persistence APIs; same content, tool call and answer; includes MendCode streaming and usage; no provider/runtime startup or UI timing", samples }, null, 2))
