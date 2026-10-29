// A scripted `pi --mode rpc` over stdio for tests. The prompt text picks the behaviour; nothing here touches a real pi.
// FAKE_PI_LOG=<file> records argv and every message received; FAKE_PI_OLD=1 behaves like a pi without agent_settled and clear_queue;
// FAKE_PI_NO_GATE=1 never loads the approval bridge; FAKE_PI_SESSION=<file> is the session file get_state reports; FAKE_PI_VERSION prints for --version.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GATE_MARK, GATE_READY, GATE_STATUS_KEY, GATE_TOKEN_ENV } from "../src/gate"

const argv = process.argv.slice(2)
if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "0.85.1"}\n`)
  process.exit(0)
}
if (argv.includes("--help")) {
  process.stdout.write(process.env.FAKE_PI_NO_ISOLATION === "1" ? "pi --mode rpc\n" : readFileSync(join(import.meta.dir, "fixtures", "pi-help.txt"), "utf8"))
  process.exit(0)
}

const log = (entry: unknown) => {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(entry)}\n`)
}
log({ argv })
// Simulate discovery independently from the bridge: project code runs at startup when discovery is on.
const extensions = join(process.cwd(), ".pi", "extensions")
if (!argv.includes("--no-extensions") && existsSync(extensions)) {
  for (const file of readdirSync(extensions)) if (file.endsWith(".ts")) await import(join(extensions, file))
}
const old = process.env.FAKE_PI_OLD === "1"
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const emit = (event: Record<string, unknown>) => send(event)
const respond = (id: string, command: string, data?: unknown) => send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) })
const refuse = (id: string, command: string, error: string) => send({ id, type: "response", command, success: false, error })

const usage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } }
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", content, provider: "anthropic", model: "claude-test", usage, stopReason: "stop", ...extra })

let streaming = false
let compacting = false
let aborted = false
let nextDialog = 1
const dialogs = new Map<string, (message: any) => void>()
const steers: string[] = []
let steerWaiter: (() => void) | undefined
let abortWaiter: (() => void) | undefined
let abortId: string | undefined

if (process.env.FAKE_PI_NO_GATE !== "1") {
  const ready = () => {
    log({ type: "bridge_ready" })
    send({ type: "extension_ui_request", id: "ui-gate", method: "setStatus", statusKey: GATE_STATUS_KEY, statusText: `${GATE_READY}:${process.env.FAKE_PI_BAD_GATE === "1" ? "stale" : process.env[GATE_TOKEN_ENV]}` })
  }
  if (process.env.FAKE_PI_GATE_DELAY) setTimeout(ready, Number(process.env.FAKE_PI_GATE_DELAY))
  else ready()
}

function dialog(body: Record<string, unknown>): Promise<any> {
  const id = `ui-${nextDialog++}`
  return new Promise((resolve) => {
    dialogs.set(id, resolve)
    send({ type: "extension_ui_request", id, ...body })
  })
}

async function text(value: string, index = 0) {
  emit({ type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: index } })
  for (const part of value.match(/.{1,4}/g) ?? []) emit({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: part } })
  emit({ type: "message_update", usage, assistantMessageEvent: { type: "text_end", contentIndex: index, content: value } })
}

const startRun = () => {
  streaming = true
  emit({ type: "agent_start" })
  emit({ type: "turn_start" })
  emit({ type: "message_start", message: assistant([]) })
}
const endMessage = (content: unknown[], extra: Record<string, unknown> = {}) => emit({ type: "message_end", message: assistant(content, extra) })
const endRun = (willRetry = false) => {
  emit({ type: "agent_end", messages: [], willRetry })
}
const settle = () => {
  streaming = false
  if (!old) emit({ type: "agent_settled" })
}

async function run(id: string, said: string, images: unknown[]) {
  if (said.startsWith("hello")) {
    startRun()
    emit({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } })
    emit({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } })
    emit({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hmm" } })
    await text("Hello there", 1)
    endMessage([{ type: "text", text: "Hello there" }])
    emit({ type: "turn_end", message: assistant([]), toolResults: [] })
    endRun()
    return settle()
  }
  if (said.includes("images please")) {
    startRun()
    await text(`images:${images.length}`)
    endMessage([])
    endRun()
    return settle()
  }
  if (said.startsWith("tool")) {
    const tool = said.split(" ")[1] ?? "bash"
    const payload = said.slice(`tool ${tool}`.length).trim()
    const input = payload ? JSON.parse(payload) : tool === "bash" ? { command: "ls -la" } : tool === "edit" ? { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } : { path: "a.txt" }
    startRun()
    emit({ type: "message_update", usage, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t1", toolName: tool } })
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: tool, args: input })
    let choice = "allow"
    if (process.env.FAKE_PI_NO_GATE !== "1") choice = String((await dialog({ method: "select", title: `${GATE_MARK}${JSON.stringify({ id: "t1", tool, input })}`, options: ["allow", "deny"] })).value)
    if (choice === "allow") emit({ type: "tool_execution_end", toolCallId: "t1", toolName: tool, result: { content: [{ type: "text", text: "file-list" }] }, isError: false })
    else emit({ type: "tool_execution_end", toolCallId: "t1", toolName: tool, result: { content: [{ type: "text", text: "Not approved in MendCode" }] }, isError: true })
    await text(`picked:${choice}`)
    endMessage([])
    endRun()
    return settle()
  }
  if (said.startsWith("ext-")) {
    startRun()
    const kind = said.slice(4).split(" ")[0]
    const request = kind === "confirm" ? { method: "confirm", title: "Clear it?", message: "All of it." } : kind === "select" ? { method: "select", title: "Pick one", options: ["red", "green"] } : kind === "allow" ? { method: "select", title: "Run rm -rf?", options: ["Yes", "No"] } : kind === "input" ? { method: "input", title: "Name?", placeholder: "x" } : { method: "editor", title: "Edit", prefill: "draft" }
    const answer = await dialog(request)
    await text(`answer:${JSON.stringify({ value: answer.value, confirmed: answer.confirmed, cancelled: answer.cancelled })}`)
    endMessage([])
    endRun()
    return settle()
  }
  if (said.startsWith("retry")) {
    startRun()
    endMessage([], { stopReason: "error", errorMessage: "529 overloaded" })
    endRun(true)
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 20, errorMessage: "529 overloaded" })
    await sleep(60)
    emit({ type: "agent_start" })
    await text("recovered")
    endMessage([{ type: "text", text: "recovered" }])
    endRun()
    emit({ type: "auto_retry_end", success: true, attempt: 2 })
    return settle()
  }
  if (said.startsWith("giveup")) {
    startRun()
    endMessage([], { stopReason: "error", errorMessage: "529 overloaded" })
    endRun(true)
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: "529 overloaded" })
    await sleep(30)
    emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "529 overloaded_error: Overloaded" })
    return settle()
  }
  if (said.startsWith("compaction")) {
    startRun()
    await text("part one")
    endMessage([{ type: "text", text: "part one" }])
    endRun()
    // The first agent_end is not the end: pi compacts and continues.
    compacting = true
    emit({ type: "compaction_start", reason: "overflow" })
    await sleep(80)
    compacting = false
    emit({ type: "compaction_end", reason: "overflow", result: { summary: "short summary", tokensBefore: 9000, estimatedTokensAfter: 1000 }, aborted: false, willRetry: true })
    emit({ type: "agent_start" })
    await text("part two")
    endMessage([{ type: "text", text: "part two" }])
    endRun()
    return settle()
  }
  if (said.startsWith("queued")) {
    startRun()
    await text("working")
    endMessage([{ type: "text", text: "working" }])
    emit({ type: "turn_end", message: assistant([]), toolResults: [] })
    await new Promise<void>((resolve) => {
      steerWaiter = resolve
      setTimeout(resolve, 400)
    })
    while (steers.length) {
      emit({ type: "queue_update", steering: [], followUp: [] })
      emit({ type: "turn_start" })
      await text(`steered:${steers.shift()}`)
      endMessage([])
      emit({ type: "turn_end", message: assistant([]), toolResults: [] })
    }
    endRun()
    return settle()
  }
  if (said.startsWith("slow")) {
    startRun()
    await text("working")
    if (!aborted) await new Promise<void>((resolve) => (abortWaiter = resolve))
    endMessage([], { stopReason: "aborted" })
    endRun()
    settle()
    aborted = false
    if (abortId) respond(abortId, "abort")
    return
  }
  if (said.startsWith("silent")) {
    startRun()
    return
  }
  if (said.startsWith("deaf")) {
    // Never answers abort.
    startRun()
    await text("working")
    return
  }
  if (said.startsWith("slashcmd")) {
    // Handled without any run; a stale settled from an earlier run shows up late.
    if (!old) emit({ type: "agent_settled" })
    return
  }
  if (said.startsWith("autherror")) {
    startRun()
    endMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })
    endRun()
    return settle()
  }
  if (said.startsWith("length")) {
    startRun()
    await text("cut")
    endMessage([], { stopReason: "length" })
    endRun()
    return settle()
  }
  if (said.startsWith("crash")) {
    process.stderr.write("boom: pi crashed\n")
    process.exit(3)
  }
  if (said.startsWith("dieasking")) {
    startRun()
    void dialog({ method: "input", title: "Name?" })
    await sleep(60)
    process.exit(4)
  }
  startRun()
  await text(`echo:${said}`)
  endMessage([{ type: "text", text: `echo:${said}` }])
  endRun()
  settle()
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (!line.trim()) continue
    const message = JSON.parse(line)
    log(message)
    const { id, type } = message
    if (type === "extension_ui_response") {
      dialogs.get(message.id)?.(message)
      dialogs.delete(message.id)
    } else if (type === "get_state") {
      respond(id, type, { isStreaming: streaming, isCompacting: compacting, pendingMessageCount: steers.length, sessionFile: process.env.FAKE_PI_SESSION ?? "/tmp/fake-pi/session-1.jsonl", sessionId: "s1" })
    } else if (type === "prompt") {
      const said = String(message.message ?? "")
      if (said.startsWith("reject")) refuse(id, type, "Agent is already processing")
      else {
        respond(id, type)
        void run(id, said, message.images ?? [])
      }
    } else if (type === "steer") {
      if (!streaming) refuse(id, type, "Agent is not running")
      else {
        steers.push(String(message.message))
        respond(id, type)
        steerWaiter?.()
      }
    } else if (type === "clear_queue") {
      if (old) refuse(id, type, "Unknown command: clear_queue")
      else respond(id, type, { steering: [], followUp: [] })
    } else if (type === "abort") {
      aborted = true
      abortId = id
      if (!streaming) respond(id, type)
      else abortWaiter?.()
    } else if (type === "abort_retry" || type === "set_thinking_level") respond(id, type)
    else if (type === "compact") {
      compacting = true
      emit({ type: "compaction_start", reason: "manual" })
      await sleep(30)
      compacting = false
      emit({ type: "compaction_end", reason: "manual", result: { summary: `compacted:${message.customInstructions ?? ""}`, tokensBefore: 100, estimatedTokensAfter: 10 }, aborted: false, willRetry: false })
      respond(id, type, { summary: `compacted:${message.customInstructions ?? ""}`, tokensBefore: 100, estimatedTokensAfter: 10 })
    } else if (id !== undefined) refuse(id, type, `Unknown command: ${type}`)
  }
}
