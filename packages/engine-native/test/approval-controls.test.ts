import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { createGrantStore, createNativeEngine, createPermissionReviewer, memoryHistory, type EngineHooks, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "approval-controls-")))
afterAll(() => rmSync(project, { recursive: true, force: true }))

function scriptedProvider(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  return { provider, requests }
}

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args } }, { type: "finish", reason: "tool_calls" }]

function tools(log: string[]): Tool[] {
  return [
    defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => (log.push(command), { output: `ran ${command}`, truncated: false, title: "s", isError: false }) }),
  ]
}

function turn(options: { mode: PermissionMode; answers?: EngineResolution[]; sessionId: SessionId }) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const answers = [...(options.answers ?? [])]
  const input: TurnInput = {
    permissionMode: () => options.mode,
    setPermissionMode: () => {},
    sessionId: options.sessionId,
    turnId: ids("turn"),
    text: "go",
    attachments: [],
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny", reason: "nobody answered" }),
  }
  return { input, asked }
}

function engineFor(steps: ModelEvent[][], log: string[], extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const { provider, requests } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools: tools(log), history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ experimental: { continue_loop_on_deny: true } }), ...extra })
  return { engine, requests }
}

const lastOutput = (requests: ModelRequest[]) => (requests.at(-1)!.messages.at(-1) as { output: string; isError: boolean }).output

describe("approve one retry after a reviewer denial", () => {
  function denyingReviewer() {
    const asked: string[] = []
    const reviewer = createPermissionReviewer({
      complete: async ({ prompt }) => {
        asked.push(prompt)
        return '{"verdict":"deny","reason":"looks like exfiltration"}'
      },
      modelFor: () => ({ model: "reviewer-small" }),
    })
    return { reviewer, asked }
  }

  test("the next identical call runs once without the reviewer or a prompt; the one after is reviewed again", async () => {
    const grants = createGrantStore()
    const { reviewer, asked } = denyingReviewer()
    const sessionId = ids("session")
    const log: string[] = []
    const { engine, requests } = engineFor([callTool("shell", { command: "node push.js" }), stop("a"), callTool("shell", { command: "node push.js" }), stop("b"), callTool("shell", { command: "node push.js" }), stop("c")], log, { grants, permissionReviewer: reviewer })

    const first = turn({ mode: "smart", sessionId })
    await engine.runTurn(first.input)
    expect(log).toEqual([])
    expect(lastOutput(requests)).toBe("denied by the permission reviewer: looks like exfiltration")
    expect(grants.lastDenial(sessionId)).toMatchObject({ tool: "shell", reason: "looks like exfiltration" })
    expect(grants.lastDenial(sessionId)!.summary).toContain("node push.js")

    expect(grants.approveRetry(sessionId)).toMatchObject({ tool: "shell" })
    const second = turn({ mode: "smart", sessionId })
    await engine.runTurn(second.input)
    expect(log).toEqual(["node push.js"])
    expect(second.asked).toEqual([])
    expect(asked).toHaveLength(1)

    const third = turn({ mode: "smart", sessionId })
    await engine.runTurn(third.input)
    expect(log).toEqual(["node push.js"])
    expect(asked).toHaveLength(2)
  })

  test("a different call does not use the retry, and nothing recent means nothing to approve", async () => {
    const grants = createGrantStore()
    const { reviewer } = denyingReviewer()
    const sessionId = ids("session")
    expect(grants.approveRetry(sessionId)).toBeUndefined()
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "node a.js" }), stop("a"), callTool("shell", { command: "node b.js" }), stop("b")], log, { grants, permissionReviewer: reviewer })
    await engine.runTurn(turn({ mode: "smart", sessionId }).input)
    grants.approveRetry(sessionId)
    await engine.runTurn(turn({ mode: "smart", sessionId }).input)
    expect(log).toEqual([])
  })

  test("the denial and the approval expire", () => {
    let now = 1_000
    const grants = createGrantStore(() => now)
    const sessionId = ids("session")
    grants.noteDenial(sessionId, { fingerprint: "f1", tool: "shell", summary: "node x", reason: "no" })
    now += 11 * 60_000
    expect(grants.lastDenial(sessionId)).toBeUndefined()
    expect(grants.approveRetry(sessionId)).toBeUndefined()
    grants.noteDenial(sessionId, { fingerprint: "f2", tool: "shell", summary: "node y", reason: "no" })
    expect(grants.approveRetry(sessionId)).toBeDefined()
    now += 11 * 60_000
    expect(grants.takeRetry(sessionId, "f2")).toBe(false)
  })
})

describe("project rules saved by always allow", () => {
  test("an allow rule for a command prefix applies in that project only and leaves other commands asking", async () => {
    const sessionId = ids("session")
    const log: string[] = []
    const policy = () => ({ projectConfig: { [project]: { permission: { bash: { "git status *": "allow" as const } } } }, experimental: { continue_loop_on_deny: true } })
    const { engine } = engineFor([callTool("shell", { command: "git status -s" }), callTool("shell", { command: "git push" }), stop("x")], log, { permissionPolicy: policy })
    const run = turn({ mode: "ask", sessionId, answers: [{ kind: "approve", scope: "once" }] })
    await engine.runTurn(run.input)
    expect(log).toEqual(["git status -s", "git push"])
    expect(run.asked.map((request) => request.detail)).toEqual([expect.stringContaining("git push")])

    const elsewhere = engineFor([callTool("shell", { command: "git status -s" }), stop("x")], [], { cwdFor: () => join(project, "other"), permissionPolicy: policy })
    const other = turn({ mode: "ask", sessionId: ids("session"), answers: [{ kind: "approve", scope: "once" }] })
    await elsewhere.engine.runTurn(other.input)
    expect(other.asked).toHaveLength(1)
  })

  test("a user-level deny written later still wins over the saved allow", async () => {
    const sessionId = ids("session")
    const log: string[] = []
    const policy = () => ({ projectConfig: { [project]: { permission: { bash: { "git status *": "allow" as const } } } }, permission: { bash: { "git status *": "deny" as const } }, experimental: { continue_loop_on_deny: true } })
    const { engine } = engineFor([callTool("shell", { command: "git status" }), stop("x")], log, { permissionPolicy: policy })
    await engine.runTurn(turn({ mode: "ask", sessionId }).input)
    expect(log).toEqual([])
  })

  test("a saved project allow beats a broader user ask", async () => {
    const log: string[] = []
    const policy = () => ({ projectConfig: { [project]: { permission: { bash: { "git status *": "allow" as const } } } }, permission: { bash: "ask" as const }, experimental: { continue_loop_on_deny: true } })
    const { engine } = engineFor([callTool("shell", { command: "git status" }), stop("x")], log, { permissionPolicy: policy })
    const run = turn({ mode: "ask", sessionId: ids("session") })
    await engine.runTurn(run.input)
    expect(log).toEqual(["git status"])
    expect(run.asked).toEqual([])
  })
})

describe("PermissionRequest hook", () => {
  const hooks = (refuse: string | undefined, seen: string[]): EngineHooks => ({
    has: (name) => name === "permission.request",
    permissionRequest: async (event) => {
      seen.push(`${event.tool}: ${event.detail}`)
      return refuse ? { deny: refuse } : undefined
    },
  })

  test("a refusal skips the prompt and tells the model who refused; no refusal leaves the prompt", async () => {
    const seen: string[] = []
    const log: string[] = []
    const refused = engineFor([callTool("shell", { command: "make deploy" }), stop("x")], log, { hooks: hooks("deploys are frozen", seen) })
    const first = turn({ mode: "ask", sessionId: ids("session") })
    await refused.engine.runTurn(first.input)
    expect(first.asked).toEqual([])
    expect(log).toEqual([])
    expect(lastOutput(refused.requests)).toContain("blocked by a PermissionRequest hook: deploys are frozen")
    expect(seen).toEqual(["shell: make deploy"])

    const quiet = engineFor([callTool("shell", { command: "make deploy" }), stop("x")], log, { hooks: hooks(undefined, seen) })
    const second = turn({ mode: "ask", sessionId: ids("session"), answers: [{ kind: "approve", scope: "once" }] })
    await quiet.engine.runTurn(second.input)
    expect(second.asked).toHaveLength(1)
    expect(log).toEqual(["make deploy"])
  })

  test("it is not consulted when a rule already allows the call", async () => {
    const seen: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "ls" }), stop("x")], [], { hooks: hooks("never", seen), permissionPolicy: () => ({ permission: { bash: { "ls *": "allow" as const } } }) })
    const run = turn({ mode: "ask", sessionId: ids("session") })
    await engine.runTurn(run.input)
    expect(seen).toEqual([])
    expect(run.asked).toEqual([])
  })
})
