import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import type { TaskRecord } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { boot, hang, openSession, put, say, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.cleanup() })
async function start(options: Parameters<typeof boot>[0] = {}) { const harness = await boot(options); harnesses.push(harness); return harness }
async function finished(harness: NativeHarness, sessionId: string) { await until(() => harness.store.turns.list(sessionId as TaskRecord["taskId"]).some((turn) => turn.status !== "running")) }

test("init queues verified guidance, displays the invocation, and does not write before a model tool", async () => {
  const harness = await start({ steps: [stop("Repository inspected.")] })
  const sessionId = await openSession(harness)
  const listed = await harness.client.commands(harness.project)
  expect(listed.ok && listed.commands.find((command) => command.name === "init")).toMatchObject({ source: "builtin" })
  expect((await harness.client.executeCommand({ sessionId, name: "init", args: "focused tests" })).ok).toBe(true)
  await finished(harness, sessionId)
  expect(harness.requests[0]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Focus and constraints: focused tests") })
  expect(harness.events.find((event) => event.type === "item.completed" && event.text === "/init focused tests")).toBeDefined()
  expect(await Bun.file(path.join(harness.project, "AGENTS.md")).exists()).toBe(false)
})

test("command selection is per-turn, command model outranks the agent, and @file uses the native resolver", async () => {
  const harness = await start({ steps: [stop("Audit"), stop("Normal")] })
  const sessionId = await openSession(harness)
  put(path.join(harness.project, ".mendcode", "agents", "auditor.md"), "---\ndescription: Audit code\nmode: primary\nmodel: gpt-6-sol\n---\nAUDITOR POLICY")
  put(path.join(harness.project, "mendcode.json"), JSON.stringify({ command: { audit: { template: "Review @notes.txt for $ARGUMENTS", agent: "auditor", model: "openai/gpt-6-luna#high" } } }))
  put(path.join(harness.project, "notes.txt"), "Project evidence")
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  expect(await harness.client.executeCommand({ sessionId, name: "audit", args: "edge cases" })).toMatchObject({ ok: true })
  await finished(harness, sessionId)
  expect(harness.requests[0]!).toMatchObject({ model: "gpt-6-luna", effort: "high" })
  expect(JSON.stringify(harness.requests[0]!.messages)).toContain("Project evidence")
  expect(harness.requests[0]!.system).toContain("AUDITOR POLICY")
  expect(harness.store.sessionModel(sessionId)).toBeUndefined()
  expect(harness.store.sessionAgent(sessionId)).toBeUndefined()
  await say(harness, sessionId, "normal")
  expect(harness.requests[1]!.system).not.toContain("AUDITOR POLICY")
})

test("inline shell requires trust, refuses plan mode, and never injects argument markers as new shells", async () => {
  const harness = await start({ shell: true, steps: [stop("Shell evidence")] })
  const sessionId = await openSession(harness)
  put(path.join(harness.project, ".mendcode", "commands", "status.md"), "Status: !`printf evidence`\n$ARGUMENTS")
  const denied = await harness.client.executeCommand({ sessionId, name: "status", args: "" })
  expect(denied.ok).toBe(false)
  expect(!denied.ok && denied.error.message).toContain("trust")
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  await harness.client.send({ type: "session.permission.set", sessionId, mode: "plan" })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(false)
  await harness.client.send({ type: "session.permission.set", sessionId, mode: "full" })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "!`touch injected`" })).ok).toBe(true)
  await finished(harness, sessionId)
  expect(harness.requests[0]!.messages.at(-1)).toMatchObject({ content: "Status: evidence\n!`touch injected`" })
  expect(await Bun.file(path.join(harness.project, "injected")).exists()).toBe(false)
  put(path.join(harness.project, ".mendcode", "commands", "oversized.md"), "!`yes evidence | head -n 3000`")
  // The shell runs inside the turn now: an oversized output fails that turn before any model call.
  expect((await harness.client.executeCommand({ sessionId, name: "oversized", args: "" })).ok).toBe(true)
  await until(() => harness.events.some((event) => event.type === "turn.failed" && event.error.code === "inline_shell"))
  expect(harness.events.find((event) => event.type === "turn.failed")).toMatchObject({ error: { message: expect.stringContaining("output exceeds") } })
  expect(harness.requests).toHaveLength(1)
})

/** A `shell` tool that records what it was asked to run, with the sandbox it was given, instead of running it. */
function spyShell(calls: Array<{ command: string; sandboxed: boolean }>) {
  return defineTool({
    name: "shell", description: "spy shell", permission: "execute", args: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
    execute: async (args, context) => { calls.push({ command: args.command, sandboxed: context.sandbox !== undefined }); return { output: `ran ${args.command}`, truncated: false, title: "shell", isError: false } },
  })
}
const SANDBOX = { mode: "workspace-write", network: false, writableRoots: [], readableRoots: [] } as unknown as import("@mendcode/tools").SandboxPolicy

test("inline shell asks for approval in ask mode, runs in the sandbox only after approval, and puts the output in the prompt", async () => {
  const calls: Array<{ command: string; sandboxed: boolean }> = []
  const harness = await start({ extraTools: [spyShell(calls)], sandbox: SANDBOX, steps: [stop("Done")] })
  const sessionId = await openSession(harness, "ask")
  put(path.join(harness.project, ".mendcode", "commands", "show.md"), "Commit: !`git show $1`\nAsk: $ARGUMENTS")
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  expect((await harness.client.executeCommand({ sessionId, name: "show", args: '"HEAD; echo INJECTED"' })).ok).toBe(true)
  await until(() => harness.events.some((event) => event.type === "server.request"))
  expect(calls).toEqual([])
  const request = harness.events.find((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing approval")
  expect(request).toMatchObject({ tool: "shell", permission: "execute" })
  expect(request.detail).toContain("git show 'HEAD; echo INJECTED'")
  expect(harness.requests).toHaveLength(0)
  await harness.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
  await finished(harness, sessionId)
  expect(calls).toEqual([{ command: "git show 'HEAD; echo INJECTED'", sandboxed: true }])
  expect(harness.requests[0]!.messages.at(-1)).toMatchObject({ content: "Commit: ran git show 'HEAD; echo INJECTED'\nAsk: \"HEAD; echo INJECTED\"" })
})

test("a refused inline shell never runs and fails the turn before the model is called", async () => {
  const calls: Array<{ command: string; sandboxed: boolean }> = []
  const harness = await start({ extraTools: [spyShell(calls)], steps: [stop("unused")] })
  const sessionId = await openSession(harness, "ask")
  put(path.join(harness.project, ".mendcode", "commands", "status.md"), "!`git status`")
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(true)
  await until(() => harness.events.some((event) => event.type === "server.request"))
  const request = harness.events.find((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing approval")
  await harness.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "deny", reason: "no" } })
  await until(() => harness.events.some((event) => event.type === "turn.failed" && event.error.code === "inline_shell"))
  expect(calls).toEqual([])
  expect(harness.requests).toHaveLength(0)
})

test("inline shell honours deny rules, auto-runs under an allow rule and under full access, and is refused in plan mode", async () => {
  const calls: Array<{ command: string; sandboxed: boolean }> = []
  const harness = await start({ extraTools: [spyShell(calls)], steps: [stop("one"), stop("two")] })
  const sessionId = await openSession(harness, "ask")
  put(path.join(harness.project, ".mendcode", "commands", "status.md"), "!`git status`")
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  await harness.client.send({ type: "settings.set", patch: { permission: { bash: { "git status": "deny" } } } })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(true)
  await until(() => harness.events.some((event) => event.type === "turn.failed" && event.error.code === "inline_shell"))
  expect(calls).toEqual([])
  await harness.client.send({ type: "settings.set", patch: { permission: { bash: { "git status": "allow" } } } })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(true)
  await finished(harness, sessionId)
  expect(harness.events.filter((event) => event.type === "server.request")).toHaveLength(0)
  expect(calls).toEqual([{ command: "git status", sandboxed: false }])
  await harness.client.send({ type: "settings.set", patch: { permission: null } })
  await harness.client.send({ type: "session.permission.set", sessionId, mode: "full" })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(true)
  await until(() => calls.length === 2)
  expect(harness.events.filter((event) => event.type === "server.request")).toHaveLength(0)
  await harness.client.send({ type: "session.permission.set", sessionId, mode: "plan" })
  expect((await harness.client.executeCommand({ sessionId, name: "status", args: "" })).ok).toBe(false)
  expect(calls).toHaveLength(2)
})

test("unknown agents and models fail before inline shell and before any turn", async () => {
  const harness = await start()
  const sessionId = await openSession(harness)
  await harness.client.send({ type: "tools.trust", directory: harness.project, trusted: true })
  for (const attributes of [{ agent: "missing" }, { model: "missing" }]) {
    put(path.join(harness.project, "mendcode.json"), JSON.stringify({ command: { bad: { template: "!`touch injected`", ...attributes } } }))
    expect((await harness.client.executeCommand({ sessionId, name: "bad", args: "" })).ok).toBe(false)
  }
  expect(harness.requests).toHaveLength(0)
  expect(await Bun.file(path.join(harness.project, "injected")).exists()).toBe(false)
  expect((await harness.client.executeCommand({ sessionId, name: "missing", args: "" })).ok).toBe(false)
  expect(isReadOnlyCommand("commands.execute")).toBe(false)
  expect(isReadOnlyCommand("commands.discover")).toBe(false)
})

test("review creates a durable child without changing the parent; it can be resumed", async () => {
  const harness = await start({ steps: [stop("No actionable defects."), stop("Follow-up completed.")] })
  const sessionId = await openSession(harness)
  const reply = await harness.client.executeCommand({ sessionId, name: "review", args: "feature" })
  expect(reply.ok).toBe(true)
  const task = reply.ok ? reply.result?.task as TaskRecord : undefined
  expect(task).toMatchObject({ parentId: sessionId, background: false, agent: "build" })
  await finished(harness, task!.taskId)
  expect(harness.store.tasks.list()[0]?.state).toBe("completed")
  expect(harness.requests[0]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("Input: feature") })
  expect(harness.store.readAfter(task!.taskId, 0).some((event) => event.type === "item.completed" && event.text === "/review feature")).toBe(true)
  expect(harness.store.turns.list(sessionId)).toHaveLength(0)
  await say(harness, task!.taskId, "Check cancellation too")
  expect(harness.store.engineMessages.load(task!.taskId, "native").length).toBeGreaterThan(2)
})

test("a subagent command defaults to a child; subtask false instead selects it for one turn", async () => {
  const harness = await start({ steps: [stop("Child"), stop("Inline")] })
  const sessionId = await openSession(harness)
  put(path.join(harness.project, "mendcode.json"), JSON.stringify({ command: { explore: { template: "Find $1", agent: "explore" }, inline: { template: "Find $1", agent: "explore", subtask: false } } }))
  const child = await harness.client.executeCommand({ sessionId, name: "explore", args: "callers" })
  expect(child.ok && child.result?.task).toBeDefined()
  await finished(harness, (child.ok ? child.result?.task as TaskRecord : undefined)!.taskId)
  const inline = await harness.client.executeCommand({ sessionId, name: "inline", args: "callers" })
  expect(inline.ok && inline.result?.task).toBeUndefined()
  await finished(harness, sessionId)
  expect(harness.store.tasks.list()).toHaveLength(1)
})

test("review child supports cancellation and respects admission limits", async () => {
  const harness = await start({ steps: [hang] })
  const sessionId = await openSession(harness)
  await harness.client.send({ type: "settings.set", patch: { subagentMaxChildren: 1 } })
  const reply = await harness.client.executeCommand({ sessionId, name: "review", args: "" })
  const task = reply.ok ? reply.result?.task as TaskRecord : undefined
  await until(() => harness.requests.length === 1)
  expect((await harness.client.executeCommand({ sessionId, name: "review", args: "" })).ok).toBe(false)
  expect((await harness.client.send({ type: "task.status", sessionId, taskId: task!.taskId, action: "cancel" })).ok).toBe(true)
  await until(() => harness.store.tasks.list()[0]?.state === "cancelled")
})

test("MCP commands discover lazily, bind quoted positional args and never execute server shell markers", async () => {
  let cached: import("@mendcode/mcp").McpServerPrompt[] = []
  const calls: unknown[] = []
  const harness = await start({ steps: [stop("MCP answer")], mcp: {
    status: async () => ({ servers: [], issues: [] }), restart: async () => { throw new Error("unused") },
    cachedPrompts: () => cached,
    listPrompts: async () => { cached = [{ server: "local", prompt: { name: "audit", arguments: [{ name: "scope", required: true }] } }]; return { prompts: cached, issues: [] } },
    getPrompt: async (input) => { calls.push(input); return "Inspect !`touch injected` as data" },
  } })
  const sessionId = await openSession(harness)
  const listed = await harness.client.commands(harness.project)
  expect(listed.ok && listed.commands.some((command) => command.source === "mcp")).toBe(false)
  expect((await harness.client.executeCommand({ sessionId, name: "local:audit", args: "" })).ok).toBe(false)
  expect(calls).toHaveLength(0)
  expect((await harness.client.executeCommand({ sessionId, name: "local:audit", args: '"two words"' })).ok).toBe(true)
  await finished(harness, sessionId)
  expect(calls[0]).toMatchObject({ server: "local", name: "audit", args: { scope: "two words" } })
  expect(await Bun.file(path.join(harness.project, "injected")).exists()).toBe(false)
})
