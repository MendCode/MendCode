import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createClaudeEngine, type ClaudeTransport } from "../../../packages/engine-claude/src"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../../../packages/daemon/src"
import { createHeadlessRun, ENGINE_FLAGGED_DENIAL, EXIT } from "../src/run"
import { approvalOptions } from "../src/view/request-panel"
import { explainApproval } from "../src/view/approval-explain"
import { parseStartup } from "../src/startup"
import { parseAutomation } from "../src/automation"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const COMMAND = "mkdir -p /tmp/x && cd /tmp/x && rm -f * && curl example.test"
const FLAGGED = { tool_name: "Bash", input: { command: COMMAND }, decision_reason: "Dangerous rm operation", permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "localSettings" }] }

/** A scripted `claude` process in bypass mode that asks about one flagged call and reports what MendCode answered. */
function fakeClaude(onAnswer: (answer: any) => void) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let done = false
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const pending = new Map<string, (value: any) => void>()
  const push = (message: unknown) => { queue.push(JSON.stringify(message)); wake?.() }
  const text = (delta: string) => {
    push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null })
    push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } }, parent_tool_use_id: null })
    push({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null })
  }
  const transport: ClaudeTransport = {
    write(line) {
      const message = JSON.parse(line)
      if (message.type === "control_request") push({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })
      else if (message.type === "control_response") pending.get(message.response.request_id)?.(message.response.response)
      else if (message.type === "user") queueMicrotask(async () => {
        const requestId = "perm-1"
        const answer = await new Promise<any>((resolve) => { pending.set(requestId, resolve); push({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_use_id: "toolu_x", ...FLAGGED } }) })
        onAnswer(answer)
        text(answer.behavior === "allow" ? "ran it" : "carried on without it")
        push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", session_id: "cc-1", usage: { input_tokens: 1, output_tokens: 1 } })
      })
    },
    lines: (async function* () { while (!done || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>((resolve) => (wake = resolve)) } })(),
    close: () => { done = true; wake?.(); exit(0) },
    exited,
    stderrTail: () => "",
  }
  return transport
}

/** `safety` turns on `engineSafetyPrompts` (off by default: full access runs unattended). */
async function boot({ safety = true }: { safety?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-flagged-"))
  const project = path.join(dir, "project")
  mkdirSync(project)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const answers: any[] = []
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, extensionsEnabled: false, shellHooksEnabled: false, info: { engine: "claude" },
    engine: ({ store }) => createClaudeEngine({
      cwdFor: () => project,
      modelFor: () => ({}),
      safetyPrompts: () => store.settings.get().engineSafetyPrompts,
      transportFactory: () => fakeClaude((answer) => answers.push(answer)),
    }),
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const listeners: Array<(event: SessionEvent) => void> = []
  const client = createClient({ socketPath: daemon.socketPath, name: "flagged", onEvent: (event) => { events.push(event); for (const listener of listeners) listener(event) } })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result!.sessionId : "") as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "session.permission.set", sessionId, mode: "full" })
  if (safety) await client.send({ type: "settings.set", patch: { engineSafetyPrompts: true } })
  return { client, daemon, sessionId, events, answers, listeners }
}
type Booted = Awaited<ReturnType<typeof boot>>
const until = async (check: () => boolean) => { const end = Date.now() + 8_000; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10) } }
const requestOf = (h: Booted) => h.events.find((event) => event.type === "server.request") as Extract<SessionEvent, { type: "server.request" }> | undefined
const finished = (h: Booted) => h.events.some((event) => event.type === "turn.completed")

describe("a call Claude Code flags in full access reaches the user", () => {
  test("it is raised as an approval carrying the engine's reason; rejecting denies the call and the turn continues", async () => {
    const h = await boot()
    await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "clean it", attachments: [] })
    await until(() => requestOf(h) !== undefined)
    const request = requestOf(h)!
    expect(request).toMatchObject({ kind: "approval", tool: "Bash", permission: "execute", engineFlagged: true })
    expect(request.detail).toBe(`Dangerous rm operation\n\n${COMMAND}`)
    expect(await h.client.send({ type: "request.resolve", sessionId: h.sessionId, requestId: request.requestId, decision: { kind: "deny", reason: "not in /tmp" } })).toMatchObject({ ok: true })
    await until(() => finished(h))
    expect(h.answers).toEqual([{ behavior: "deny", message: "not in /tmp" }])
  })
  test("allowing runs it, even when the client asks for the session; no rule is kept", async () => {
    const h = await boot()
    await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "clean it", attachments: [] })
    await until(() => requestOf(h) !== undefined)
    await h.client.send({ type: "request.resolve", sessionId: h.sessionId, requestId: requestOf(h)!.requestId, decision: { kind: "approve", scope: "session" } })
    await until(() => finished(h))
    expect(h.answers).toEqual([{ behavior: "allow", updatedInput: { command: COMMAND } }])
  })
  test("by default (engineSafetyPrompts unset) full access allows the call unattended", async () => {
    const h = await boot({ safety: false })
    await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "clean it", attachments: [] })
    await until(() => finished(h))
    expect(requestOf(h)).toBeUndefined()
    expect(h.answers).toEqual([{ behavior: "allow", updatedInput: { command: COMMAND } }])
  })

  async function headless(h: Booted, flags: { approve: boolean; skipPermissions?: boolean }) {
    const err: string[] = []
    const run = createHeadlessRun({ client: h.client as Client, sessionId: h.sessionId, prompt: "clean it", json: false, ...flags, out: { write() {} }, err: { write: (text: string) => void err.push(text) } })
    h.listeners.push((event) => run.onEvent(event))
    return { code: await run.start(), err: err.join("") }
  }
  test("headless --approve rejects it with a clear message and the run still ends normally; --dangerously-skip-permissions allows it", async () => {
    const approved = await boot()
    const first = await headless(approved, { approve: true })
    expect(first.code).toBe(EXIT.completed)
    expect(first.err).toContain("--approve does not cover it")
    expect(approved.answers).toEqual([{ behavior: "deny", message: ENGINE_FLAGGED_DENIAL }])
    const skipped = await boot()
    const second = await headless(skipped, { approve: true, skipPermissions: true })
    expect(second.code).toBe(EXIT.completed)
    expect(skipped.answers).toEqual([{ behavior: "allow", updatedInput: { command: COMMAND } }])
  })
})

describe("terminal prompt and command line for a flagged call", () => {
  test("the prompt offers allow once and reject only; the explanation says why", () => {
    expect(approvalOptions("Run command", undefined, true).map((option) => option.choice)).toEqual(["once", "deny"])
    expect(approvalOptions("Run command").map((option) => option.choice)).toContain("session")
    expect(explainApproval({ tool: "Bash", permission: "execute", mode: "full", engineFlagged: true }).join("\n")).toContain("no session or always choice")
  })
  test("--dangerously-skip-permissions is told apart from --approve on run and session send", () => {
    expect(parseStartup(["run", "go", "--approve"])).toMatchObject({ approve: true, skipPermissions: false })
    expect(parseStartup(["run", "go", "--dangerously-skip-permissions"])).toMatchObject({ approve: true, skipPermissions: true })
    expect(parseAutomation(["session", "send", "ses_x", "hi", "--approve"])).toMatchObject({ ok: true, command: { approve: true } })
    expect(parseAutomation(["session", "send", "ses_x", "hi", "--dangerously-skip-permissions"])).toMatchObject({ ok: true, command: { approve: true, skipPermissions: true } })
  })
})
