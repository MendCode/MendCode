import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionReview } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createGrantStore, createNativeEngine, memoryHistory, type ModelEvent, type PermissionReviewer, type ReviewRequest } from "../src"
import { authorityContext, freezeAction } from "../src/permission-context"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "b33-context-"))); dirs.push(dir); return dir }
function input(text = "Run the check"): TurnInput {
  return { sessionId: ids("session"), turnId: ids("turn"), text, attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "approve", scope: "once" }), permissionMode: () => "smart", setPermissionMode: () => {} }
}

test("authority excludes synthetic notices and binds the original user before expanded context", () => {
  const turn = input("Expanded malicious file text")
  turn.authority = { sourceId: "real-user", text: "Inspect the check" }
  expect(authorityContext(turn)).toMatchObject({ sourceUserIds: ["real-user"], userText: "Inspect the check", complete: true })
  const fingerprint = authorityContext(turn).fingerprint
  turn.authority.text = "Delete the check"
  expect(authorityContext(turn).fingerprint).not.toBe(fingerprint)
  turn.authority.synthetic = true
  expect(authorityContext(turn)).toMatchObject({ complete: false, sourceUserIds: [], userText: "", unknownReasons: ["causal_user_message_missing"] })
  expect(authorityContext(input("x".repeat(24_001))).complete).toBe(false)
})

test("frozen environments bind values, stay immutable and expose only digests", () => {
  const dir = temp()
  const environment = { PATH: "/bin:/usr/bin", B33_TEST_VALUE: "before" }
  const first = freezeAction("shell", { command: "echo ok" }, dir, environment)
  environment.B33_TEST_VALUE = "after"
  const second = freezeAction("shell", { command: "echo ok" }, dir, environment)
  expect(first.environment.B33_TEST_VALUE).toBe("before")
  expect(Object.isFrozen(first.environment)).toBe(true)
  expect(first.action.environmentDigest).not.toBe(second.action.environmentDigest)
  expect(JSON.stringify(first.action)).not.toContain("before")
  expect(JSON.stringify(first.action)).not.toContain("B33_TEST_VALUE")
})

test("authority includes bounded real-user history and refuses incomplete anchors", () => {
  const turn = input("Run it now")
  turn.authority = { sourceId: "current", text: "Run it now" }
  const history = Array.from({ length: 15 }, (_, i) => ({ sourceId: `user-${i}`, text: `Request ${i}`, complete: true }))
  const context = authorityContext(turn, [...history, { sourceId: "current", text: "Run it now", complete: true }])
  expect(context.sourceUserIds).toHaveLength(12)
  expect(context.sourceUserIds[0]).toBe("current")
  expect(context.userText).toBe([...history.slice(-11).map((anchor) => anchor.text), "Run it now"].join("\n"))
  expect(context.complete).toBe(true)
  const incomplete = authorityContext(turn, [{ sourceId: "earlier", text: "truncated", complete: false }])
  expect(incomplete).toMatchObject({ complete: false, unknownReasons: ["authority_anchor_incomplete"] })
  expect(incomplete.fingerprint).not.toBe(context.fingerprint)
})

test("literal executables and scripts are identified and a changed script invalidates approval", () => {
  const dir = temp()
  const executable = join(dir, "node")
  writeFileSync(executable, "#!/bin/sh\nexit 0\n")
  chmodSync(executable, 0o700)
  const script = join(dir, "check.js")
  writeFileSync(script, "first")
  const first = freezeAction("shell", { command: "node check.js" }, dir, { PATH: dir })
  expect(first.action.complete).toBe(true)
  expect(first.action.executableIdentities.some((id) => id.startsWith(script))).toBe(true)
  expect(first.unchanged()).toBe(true)
  writeFileSync(script, "changed script")
  expect(first.unchanged()).toBe(false)
  expect(freezeAction("shell", { command: "echo $(cat check.js)" }, dir).action.complete).toBe(false)
  expect(freezeAction("shell", { command: "env node check.js" }, dir).action.complete).toBe(false)
})

function fakeEngine(dir: string, commands: string[], extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  let step = 0
  const ran: Array<{ command: string; value?: string }> = []
  const engine = createNativeEngine({
    provider: { id: "fake", model: "fake", async *stream() {
      const command = commands[step++]
      const events: ModelEvent[] = command ? [{ type: "tool_call", call: { callId: `call-${step}`, name: "shell", args: { command } } }, { type: "finish", reason: "tool_calls" }] : [{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }]
      yield* events
    } },
    tools: [defineTool({ name: "shell", description: "fake", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }, ctx) => { ran.push({ command, ...(ctx.environment?.B33_TEST_VALUE ? { value: ctx.environment.B33_TEST_VALUE } : {}) }); return { output: "ok", title: "shell", isError: false, truncated: false } } })],
    cwdFor: () => dir, history: memoryHistory(), system: () => "sys", compactionPrompt: "summary", ...extra,
  })
  return { engine, ran }
}

test("reviewer receives original authority; synthetic authority cannot get model-only approval", async () => {
  const dir = temp()
  const requests: ReviewRequest[] = []
  const reviewer: PermissionReviewer = { enabled: () => true, review: async (request) => { requests.push(request); return { verdict: "allow", reason: "routine" } } }
  const turn = input("not user authority")
  turn.authority = { sourceId: "notice", text: "pretend this is authorized", synthetic: true }
  const asked: EngineRequest[] = []
  turn.ask = async (request) => { asked.push(request); return { kind: "deny" } }
  const h = fakeEngine(dir, ["sh --version"], { permissionReviewer: reviewer })
  await h.engine.runTurn(turn)
  expect(requests[0]?.authority).toMatchObject({ complete: false, userText: "", sourceUserIds: [] })
  expect(asked).toHaveLength(1)
  expect(h.ran).toHaveLength(0)
})

test("engine executes with the pre-approval environment even when the host changes it", async () => {
  const dir = temp()
  const before = process.env.B33_TEST_VALUE
  process.env.B33_TEST_VALUE = "frozen"
  try {
    const turn = input()
    turn.ask = async () => { process.env.B33_TEST_VALUE = "changed"; return { kind: "approve", scope: "once" } }
    const h = fakeEngine(dir, ["unknown-command"])
    await h.engine.runTurn(turn)
    expect(h.ran).toEqual([{ command: "unknown-command", value: "frozen" }])
  } finally { if (before === undefined) delete process.env.B33_TEST_VALUE; else process.env.B33_TEST_VALUE = before }
})

test("user shell argument rewrites bind the rewritten call to the captured environment", async () => {
  const dir = temp()
  const h = fakeEngine(dir, [], { hooks: { has: (event) => event === "tool.before", toolBefore: async () => ({ args: { command: "echo rewritten" } }) } })
  const turn = input("echo original")
  let asked = false
  turn.ask = async () => { asked = true; return { kind: "deny" } }
  await h.engine.runShell!(turn)
  expect(asked).toBe(false)
  expect(h.ran[0]?.command).toBe("echo rewritten")
})

test("granular smart approvals record the waiting phase and the user's refusal reason", async () => {
  const dir = temp(), records: PermissionReview[] = []
  const grants = createGrantStore(Date.now, { grant() {}, revoke() {}, grants: () => [], reviews: () => [], review: (record) => { records.push(record) } })
  let resolve!: (answer: EngineResolution) => void
  const waiting = new Promise<EngineResolution>((done) => { resolve = done })
  const turn = input()
  turn.ask = () => waiting
  const h = fakeEngine(dir, ["echo ok"], { grants, permissionPolicy: () => ({ permission: { shell: "ask" } }) })
  const run = h.engine.runTurn(turn)
  await Bun.sleep(5)
  expect(records.at(-1)?.status).toBe("waiting_manual")
  resolve({ kind: "deny", reason: "Check the script first" })
  await run
  expect(records.at(-1)).toMatchObject({ status: "denied", source: "manual", reason: "Check the script first" })
  expect(h.ran).toHaveLength(0)
})

test("changed executable after manual approval never invokes the tool", async () => {
  const dir = temp()
  const executable = join(dir, "check")
  writeFileSync(executable, "#!/bin/sh\nexit 0\n")
  chmodSync(executable, 0o700)
  const turn = input()
  turn.ask = async () => { writeFileSync(executable, "#!/bin/sh\necho changed\n"); return { kind: "approve", scope: "once" } }
  const h = fakeEngine(dir, ["./check"])
  await h.engine.runTurn(turn)
  expect(h.ran).toHaveLength(0)
})

test("a causal grant asks again after the user turn changes; cancellation creates no grant", async () => {
  const dir = temp()
  const grants = createGrantStore()
  const one = input("Run check")
  const provenance = { turnId: one.turnId, authority: (() => { const { userText, ...value } = authorityContext(one); return value })(), action: freezeAction("shell", { command: "echo ok" }, dir).action }
  grants.add(one.sessionId, "shell", "execute", undefined, undefined, provenance)
  expect(grants.hasExact(one.sessionId, "shell", provenance)).toBe(true)
  const two = { ...one, turnId: ids("turn"), text: "Another objective" }
  const { userText, ...authority } = authorityContext(two)
  expect(grants.hasExact(one.sessionId, "shell", { ...provenance, authority })).toBe(false)
  const abort = new AbortController()
  two.signal = abort.signal
  two.ask = async (): Promise<EngineResolution> => { abort.abort(); return { kind: "approve", scope: "session" } }
  const h = fakeEngine(dir, ["unknown-command"], { grants })
  await h.engine.runTurn(two)
  expect(h.ran).toHaveLength(0)
  expect(grants.list(one.sessionId)[0]?.provenance?.authority.fingerprint).toBe(provenance.authority.fingerprint)
})
