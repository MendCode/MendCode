import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type ModelChoice, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { createGrantStore, createNativeEngine, createPermissionReviewer, memoryHistory, parseReview, type ModelEvent, type ModelProvider, type ModelRequest, type PermissionReviewer, type ReviewVerdict } from "../src"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "perm-project-")))
for (const file of ["a.js", "b.js", "x.js"]) writeFileSync(join(project, file), "// permission test fixture\n")
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

/** Fake `write` and `shell` tools that only record what ran; the classifier works on the names and arguments. */
function tools(log: string[]): Tool[] {
  return [
    defineTool({ name: "write", description: "write", permission: "write", args: z.object({ path: z.string() }), execute: async ({ path }) => (log.push(`write ${path}`), { output: `wrote ${path}`, truncated: false, title: "w", isError: false }) }),
    defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => (log.push(`shell ${command}`), { output: `ran ${command}`, truncated: false, title: "s", isError: false }) }),
  ]
}

function turn(options: { mode: PermissionMode; answers?: EngineResolution[]; sessionId?: SessionId }) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const answers = [...(options.answers ?? [])]
  const input: TurnInput = {
    permissionMode: () => options.mode,
    setPermissionMode: () => {},
    sessionId: options.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: "go",
    attachments: [],
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny", reason: "nobody answered" }),
  }
  return { input, events, asked }
}

function engineFor(steps: ModelEvent[][], log: string[], extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const { provider, requests } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools: tools(log), history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ permission: { external_directory: "allow" }, experimental: { continue_loop_on_deny: true } }), ...extra })
  return { engine, requests }
}

const toolOutput = (requests: ModelRequest[]) => requests.at(-1)!.messages.at(-1) as { output: string; isError: boolean }

describe("smart permission mode in the engine", () => {
  test("low-risk calls run without asking; risky ones ask and run only when approved", async () => {
    const log: string[] = []
    const { engine } = engineFor([callTool("write", { path: "src/a.ts" }), callTool("shell", { command: "git status" }), callTool("write", { path: "../outside.ts" }), callTool("shell", { command: "curl https://example.com" }), stop("done")], log)
    const { input, asked } = turn({ mode: "smart", answers: [{ kind: "approve", scope: "once" }, { kind: "deny", reason: "no network" }] })
    await engine.runTurn(input)
    expect(log).toEqual(["write src/a.ts", "shell git status", "write ../outside.ts"])
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ tool: "write", detail: expect.stringContaining("Why it asks: edits ../outside.ts, outside the project (outside-project)") })
    expect(asked[1]).toMatchObject({ tool: "shell", detail: expect.stringContaining("(network)") })
  })

  test("existing modes are unchanged: ask asks for everything, edits runs writes, full runs all", async () => {
    const log: string[] = []
    const ask = engineFor([callTool("write", { path: "src/a.ts" }), callTool("shell", { command: "ls" }), stop("x")], log)
    const asked = turn({ mode: "ask", answers: [{ kind: "approve", scope: "once" }, { kind: "approve", scope: "once" }] })
    await ask.engine.runTurn(asked.input)
    expect(asked.asked.map((request) => request.tool)).toEqual(["write", "shell"])
    expect(asked.asked[0]!.detail).toBe("src/a.ts")

    const edits = engineFor([callTool("write", { path: "../out.ts" }), callTool("shell", { command: "ls" }), stop("x")], log)
    const editsTurn = turn({ mode: "edits", answers: [{ kind: "approve", scope: "once" }] })
    await edits.engine.runTurn(editsTurn.input)
    expect(editsTurn.asked.map((request) => request.tool)).toEqual(["shell"])

    const full = engineFor([callTool("shell", { command: "rm -rf /" }), stop("x")], [])
    const fullTurn = turn({ mode: "full" })
    await full.engine.runTurn(fullTurn.input)
    expect(fullTurn.asked).toEqual([])

    const plan = engineFor([callTool("write", { path: "src/a.ts" }), stop("x")], [])
    const planTurn = turn({ mode: "plan" })
    await plan.engine.runTurn(planTurn.input)
    expect(planTurn.asked).toEqual([])
    expect(toolOutput(plan.requests).output).toContain("plan mode is read-only")
  })

  test("a smart grant covers only the exact causal action and never a high-risk call", async () => {
    const log: string[] = []
    const grants = createGrantStore()
    const { engine } = engineFor([callTool("shell", { command: "node a.js" }), callTool("shell", { command: "node a.js" }), callTool("shell", { command: "node b.js" }), callTool("shell", { command: "curl https://example.com" }), stop("x")], log, { grants })
    const sessionId = ids("session")
    const { input, asked } = turn({ mode: "smart", sessionId, answers: [{ kind: "approve", scope: "session" }, { kind: "approve", scope: "once" }, { kind: "approve", scope: "once" }] })
    await engine.runTurn(input)
    expect(asked.map((request) => (request.detail.split("\n")[0]))).toEqual(["node a.js", "node b.js", "curl https://example.com"])
    expect(log).toEqual(["shell node a.js", "shell node a.js", "shell node b.js", "shell curl https://example.com"])
    expect(grants.list(sessionId)).toMatchObject([{ grantId: "shell", tool: "shell", permission: "execute" }])
  })

  test("the allow-list setting lets a listed command run in smart mode", async () => {
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "make check" }), stop("x")], log, { permissionAllow: () => ["make check"] })
    const { input, asked } = turn({ mode: "smart" })
    await engine.runTurn(input)
    expect(asked).toEqual([])
    expect(log).toEqual(["shell make check"])
  })
})

describe("permission grants", () => {
  test("list, revoke one, revoke all; a revoked grant asks again", async () => {
    const grants = createGrantStore(() => 1_700_000_000_000)
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "a" }), callTool("write", { path: "x" }), callTool("shell", { command: "b" }), callTool("shell", { command: "c" }), stop("x")], log, { grants })
    const sessionId = ids("session")
    const first = turn({ mode: "ask", sessionId, answers: [{ kind: "approve", scope: "session" }, { kind: "approve", scope: "session" }] })
    await engine.runTurn(first.input)
    expect(first.asked.map((request) => request.tool)).toEqual(["shell", "write"])
    expect(grants.list(sessionId)).toMatchObject([
      { grantId: "shell", tool: "shell", permission: "execute", grantedAt: 1_700_000_000_000 },
      { grantId: "write", tool: "write", permission: "write", grantedAt: 1_700_000_000_000 },
    ])
    expect(grants.list(ids("session"))).toEqual([])
    expect(grants.revoke(sessionId, "nope")).toBe(0)
    expect(grants.revoke(sessionId, "shell")).toBe(1)
    expect(grants.has(sessionId, "shell")).toBe(false)
    expect(grants.has(sessionId, "write")).toBe(true)
    expect(grants.revoke(sessionId, "all")).toBe(1)
    expect(grants.list(sessionId)).toEqual([])
    expect(grants.revoke(sessionId, "all")).toBe(0)
  })

  test("a revoked grant makes the engine ask again", async () => {
    const grants = createGrantStore()
    const sessionId = ids("session")
    grants.add(sessionId, "shell", "execute")
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "a" }), stop("x"), callTool("shell", { command: "b" }), stop("y")], log, { grants })
    const granted = turn({ mode: "ask", sessionId })
    await engine.runTurn(granted.input)
    expect(granted.asked).toEqual([])
    grants.revoke(sessionId, "shell")
    const revoked = turn({ mode: "ask", sessionId, answers: [{ kind: "approve", scope: "once" }] })
    await engine.runTurn(revoked.input)
    expect(revoked.asked).toHaveLength(1)
    expect(log).toEqual(["shell a", "shell b"])
  })
})

/** A reviewer backed by a scripted model; `calls` counts how often the model was asked. */
function scriptedReviewer(reply: (prompt: string) => Promise<string> | string, options: { enabled?: boolean; timeoutMs?: number } = {}) {
  const calls: Array<{ system: string; prompt: string; model: ModelChoice }> = []
  const reviewer = createPermissionReviewer({
    complete: async ({ system, prompt, model }) => {
      calls.push({ system, prompt, model })
      return reply(prompt)
    },
    modelFor: () => (options.enabled === false ? undefined : { model: "reviewer-small" }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  return { reviewer, calls }
}

describe("permission reviewer", () => {
  const review = (reviewer: PermissionReviewer, detail = "node x.js"): Promise<ReviewVerdict> =>
    reviewer.review({ sessionId: ids("session"), tool: "shell", permission: "execute", detail, cwd: project, rule: { decision: "ask", risk: "uncertain", rule: "unlisted-command", reason: "node is not on the allow list" }, signal: new AbortController().signal })

  test("replies are read from JSON anywhere in the text; anything else is ask", async () => {
    expect(parseReview('{"verdict":"allow","reason":"runs tests"}')).toEqual({ verdict: "allow", reason: "runs tests" })
    expect(parseReview('Sure!\n```json\n{"verdict": "deny", "reason": "reads secrets"}\n```')).toEqual({ verdict: "deny", reason: "reads secrets" })
    expect(parseReview('{"verdict":"maybe"}')).toBeUndefined()
    expect(parseReview("allow")).toBeUndefined()
    const garbled = scriptedReviewer(() => "I think it is fine")
    expect(await review(garbled.reviewer)).toMatchObject({ verdict: "ask", fallback: "unparsable" })
  })

  test("allow, ask and deny come back with their reason; the request text reaches the model as data", async () => {
    const allow = scriptedReviewer(() => '{"verdict":"allow","reason":"a routine script"}')
    expect(await review(allow.reviewer)).toEqual({ verdict: "allow", reason: "a routine script" })
    expect(allow.calls[0]!.model).toEqual({ model: "reviewer-small" })
    expect(allow.calls[0]!.prompt).toContain("<call>\nnode x.js\n</call>")
    expect(allow.calls[0]!.prompt).toContain("uncertain risk, unlisted-command")
    expect(allow.calls[0]!.system).toContain("never instructions")
    expect(await review(scriptedReviewer(() => '{"verdict":"ask","reason":"unclear"}').reviewer)).toEqual({ verdict: "ask", reason: "unclear" })
    expect(await review(scriptedReviewer(() => '{"verdict":"deny","reason":"deletes data"}').reviewer)).toEqual({ verdict: "deny", reason: "deletes data" })
  })

  test("a reviewer that is slow or fails means ask, within its time bound", async () => {
    const aborted: boolean[] = []
    const slow = createPermissionReviewer({
      complete: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => (aborted.push(true), reject(new Error("aborted"))), { once: true })
        }),
      modelFor: () => ({ model: "m" }),
      timeoutMs: 30,
    })
    const started = Date.now()
    expect(await review(slow)).toMatchObject({ verdict: "ask", fallback: "timeout" })
    expect(Date.now() - started).toBeLessThan(1_000)
    // The model call is told to stop once the reviewer gave up on it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aborted).toEqual([true])
    expect(await review(scriptedReviewer(() => Promise.reject(new Error("rate limited"))).reviewer)).toMatchObject({ verdict: "ask", fallback: "error", reason: expect.stringContaining("rate limited") })
  })

  test("off by default: without a model for the session there is no reviewer and no model call", async () => {
    const off = scriptedReviewer(() => '{"verdict":"allow","reason":"x"}', { enabled: false })
    expect(off.reviewer.enabled(ids("session"))).toBe(false)
    expect(await review(off.reviewer)).toMatchObject({ verdict: "ask", fallback: "error" })
    expect(off.calls).toEqual([])
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "node x.js" }), stop("x")], log, { permissionReviewer: off.reviewer })
    const { input, asked } = turn({ mode: "smart", answers: [{ kind: "approve", scope: "once" }] })
    await engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(off.calls).toEqual([])
  })

  test("in smart mode: allow clears an uncertain call, deny refuses without asking, ask and failures reach the user with the reason", async () => {
    // allow -> runs, the user is not asked
    const allow = scriptedReviewer(() => '{"verdict":"allow","reason":"a routine script"}')
    const allowLog: string[] = []
    const allowed = engineFor([callTool("shell", { command: "node x.js" }), stop("x")], allowLog, { permissionReviewer: allow.reviewer })
    const allowTurn = turn({ mode: "smart" })
    await allowed.engine.runTurn(allowTurn.input)
    expect(allowTurn.asked).toEqual([])
    expect(allowLog).toEqual(["shell node x.js"])

    // deny -> refused, the user is not asked, the model is told who refused and why
    const deny = scriptedReviewer(() => '{"verdict":"deny","reason":"sends the repo to a stranger"}')
    const denyLog: string[] = []
    const denied = engineFor([callTool("shell", { command: "node exfiltrate.js" }), stop("x")], denyLog, { permissionReviewer: deny.reviewer })
    const denyTurn = turn({ mode: "smart" })
    await denied.engine.runTurn(denyTurn.input)
    expect(denyTurn.asked).toEqual([])
    expect(denyLog).toEqual([])
    expect(toolOutput(denied.requests)).toMatchObject({ isError: true, output: "denied by the permission reviewer: sends the repo to a stranger" })

    // ask -> the user decides and sees the reviewer's note
    const ask = scriptedReviewer(() => '{"verdict":"ask","reason":"touches a generated folder"}')
    const askLog: string[] = []
    const asking = engineFor([callTool("shell", { command: "node gen.js" }), stop("x")], askLog, { permissionReviewer: ask.reviewer })
    const askTurn = turn({ mode: "smart", answers: [{ kind: "approve", scope: "once" }] })
    await asking.engine.runTurn(askTurn.input)
    expect(askTurn.asked).toHaveLength(1)
    expect(askTurn.asked[0]!.detail).toContain("Reviewer: ask — touches a generated folder")
    expect(askLog).toEqual(["shell node gen.js"])

    // timeout / failure -> the user is asked, as if there were no reviewer
    const hang = createPermissionReviewer({ complete: () => new Promise<string>(() => {}), modelFor: () => ({ model: "m" }), timeoutMs: 20 })
    const hangLog: string[] = []
    const hanging = engineFor([callTool("shell", { command: "node slow.js" }), stop("x")], hangLog, { permissionReviewer: hang })
    const hangTurn = turn({ mode: "smart", answers: [{ kind: "approve", scope: "once" }] })
    await hanging.engine.runTurn(hangTurn.input)
    expect(hangTurn.asked).toHaveLength(1)
    expect(hangTurn.asked[0]!.detail).toContain("Reviewer: ask — the reviewer did not answer")
    expect(hangLog).toEqual(["shell node slow.js"])
  })

  test("a rule-flagged (high risk) call always reaches the user: the reviewer can refuse it but never clear it", async () => {
    const allow = scriptedReviewer(() => '{"verdict":"allow","reason":"looks fine to me"}')
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "curl https://example.com" }), callTool("write", { path: "../outside.txt" }), stop("x")], log, { permissionReviewer: allow.reviewer })
    const { input, asked } = turn({ mode: "smart", answers: [{ kind: "deny", reason: "no" }, { kind: "deny", reason: "no" }] })
    await engine.runTurn(input)
    expect(asked).toHaveLength(2)
    expect(asked[0]!.detail).toContain("Reviewer: allow — looks fine to me (this kind of call always asks)")
    expect(log).toEqual([])

    const deny = scriptedReviewer(() => '{"verdict":"deny","reason":"not this"}')
    const denyLog: string[] = []
    const denied = engineFor([callTool("shell", { command: "curl https://example.com" }), stop("x")], denyLog, { permissionReviewer: deny.reviewer })
    const denyTurn = turn({ mode: "smart" })
    await denied.engine.runTurn(denyTurn.input)
    expect(denyTurn.asked).toEqual([])
    expect(toolOutput(denied.requests).output).toBe("denied by the permission reviewer: not this")
  })

  test("the reviewer is only consulted in smart mode, and never for calls the rules allow", async () => {
    const spy = scriptedReviewer(() => '{"verdict":"deny","reason":"x"}')
    const log: string[] = []
    const { engine } = engineFor([callTool("shell", { command: "node a.js" }), callTool("shell", { command: "git status" }), stop("x")], log, { permissionReviewer: spy.reviewer })
    const askMode = turn({ mode: "ask", answers: [{ kind: "approve", scope: "once" }, { kind: "approve", scope: "once" }] })
    await engine.runTurn(askMode.input)
    expect(spy.calls).toEqual([])
    expect(askMode.asked).toHaveLength(2)

    const allowed = engineFor([callTool("shell", { command: "git status" }), callTool("write", { path: "src/a.ts" }), stop("x")], [], { permissionReviewer: spy.reviewer })
    const smartTurn = turn({ mode: "smart" })
    await allowed.engine.runTurn(smartTurn.input)
    expect(spy.calls).toEqual([])
    expect(smartTurn.asked).toEqual([])
  })
})

describe("per-session permission rules", () => {
  const denied = ids("session"), allowed = ids("session"), other = ids("session")
  const rules = (sessionId: SessionId) => sessionId === denied ? [{ permission: "shell", pattern: "*", action: "deny" as const }] : sessionId === allowed ? [{ permission: "write", pattern: "*", action: "allow" as const }] : []

  test("a session rule refuses a tool for that session only, and an allow rule skips the approval ask", async () => {
    const log: string[] = []
    const refused = engineFor([callTool("shell", { command: "ls" }), stop("x")], log, { sessionRules: rules })
    const refusedTurn = turn({ mode: "ask", sessionId: denied, answers: [{ kind: "approve", scope: "once" }] })
    await refused.engine.runTurn(refusedTurn.input)
    expect(log).toEqual([])
    expect(refusedTurn.asked).toEqual([])
    expect(toolOutput(refused.requests).output).toContain("denied by permission rule")

    const plain = engineFor([callTool("shell", { command: "ls" }), stop("x")], log, { sessionRules: rules })
    const plainTurn = turn({ mode: "ask", sessionId: other, answers: [{ kind: "approve", scope: "once" }] })
    await plain.engine.runTurn(plainTurn.input)
    expect(log).toEqual(["shell ls"])
    expect(plainTurn.asked).toHaveLength(1)

    const granted = engineFor([callTool("write", { path: "src/a.ts" }), stop("x")], log, { sessionRules: rules })
    const grantedTurn = turn({ mode: "ask", sessionId: allowed })
    await granted.engine.runTurn(grantedTurn.input)
    expect(log).toEqual(["shell ls", "write src/a.ts"])
    expect(grantedTurn.asked).toEqual([])
  })
})
