import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ModelRequest } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { boot, callTool, openSession, say, stop, type NativeHarness } from "./native-harness"

/** `task` with `bare: true`: the child runs with the PR reviewer's limits (no instruction files, memory or skills). Scripted model, temp dirs. */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function start(steps: NonNullable<Parameters<typeof boot>[0]>["steps"]) {
  const h = await boot({ ...(steps ? { steps } : {}) })
  cleanups.push(() => h.cleanup())
  await h.client.send({ type: "settings.set", patch: { tier: "full", features: { task_fork: true, task_bare: true } } })
  return h
}
const children = (h: NativeHarness, parent: SessionId) => h.store.tasks.list().filter((task) => task.parentId === parent)
const limitsOf = async (h: NativeHarness, sessionId: SessionId) => {
  const reply = await h.client.send({ type: "session.run.configure", sessionId })
  return reply.ok ? (reply.result as { limits: Record<string, unknown> }).limits : undefined
}
const BARE_LIMITS = { noContextFiles: true, noMemory: true, noHooks: true, noAgentPrompt: true, excludeTools: ["skill"] }

test("a bare child runs without instruction files, memory or skills; a plain child keeps them", async () => {
  const h = await start([
    callTool("task", { description: "Clean opinion", prompt: "Is a 12px label readable?", bare: true }),
    callTool("read", { path: "ui/label.css" }),
    stop("barely"),
    callTool("task", { description: "Plain", prompt: "Plain child." }),
    callTool("read", { path: "ui/label.css" }),
    stop("plain answer"),
    stop("done"),
  ])
  mkdirSync(path.join(h.project, "ui"), { recursive: true })
  writeFileSync(path.join(h.project, "ui/AGENTS.md"), "NEARBY HOUSE STYLE")
  writeFileSync(path.join(h.project, "ui/label.css"), ".label { font-size: 12px }")
  const parent = await openSession(h)
  await say(h, parent, "Ask a clean helper, then a plain one.")
  expect(JSON.stringify((h.requests[0] as ModelRequest).tools.find((tool) => tool.name === "task")!.parameters)).toContain("\"bare\"")
  const [bare, plain] = children(h, parent)
  expect([bare!.bare, bare!.result]).toEqual([true, "barely"])
  expect(await limitsOf(h, bare!.taskId)).toEqual(BARE_LIMITS)
  // Only the prompt reaches it: no summary of the parent's conversation.
  expect((h.requests[1] as ModelRequest).messages).toHaveLength(1)
  // A read below the project brings no nearby AGENTS.md into the bare child; the plain child's read does.
  expect(JSON.stringify((h.requests[2] as ModelRequest).messages)).toContain("font-size: 12px")
  expect(JSON.stringify((h.requests[2] as ModelRequest).messages)).not.toContain("NEARBY HOUSE STYLE")
  expect(JSON.stringify((h.requests[5] as ModelRequest).messages)).toContain("NEARBY HOUSE STYLE")
  expect(plain!.bare).toBeUndefined()
  expect(await limitsOf(h, plain!.taskId)).toEqual({})
})

test("a file mentioned in a bare child's prompt comes without its nearby AGENTS.md; a plain child's mention brings it", async () => {
  const h = await start([
    callTool("task", { description: "Clean opinion", prompt: "Is @ui/label.css readable?", bare: true }),
    stop("barely"),
    callTool("task", { description: "Plain", prompt: "Is @ui/label.css readable?" }),
    stop("plain answer"),
    stop("done"),
  ])
  mkdirSync(path.join(h.project, "ui"), { recursive: true })
  writeFileSync(path.join(h.project, "ui/AGENTS.md"), "NEARBY HOUSE STYLE")
  writeFileSync(path.join(h.project, "ui/label.css"), ".label { font-size: 12px }")
  const parent = await openSession(h)
  await say(h, parent, "Ask a clean helper, then a plain one.")
  const bare = JSON.stringify((h.requests[1] as ModelRequest).messages)
  expect(bare).toContain("font-size: 12px")
  expect(bare).not.toContain("NEARBY HOUSE STYLE")
  expect(JSON.stringify((h.requests[3] as ModelRequest).messages)).toContain("NEARBY HOUSE STYLE")
})

test("a resumed bare child gets its limits again after they were lost (a daemon restart keeps none)", async () => {
  const h = await start([stop("first"), stop("second")])
  const parent = await openSession(h)
  const first = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Clean", prompt: "One.", bare: true } })
  expect(first.ok).toBe(true)
  const [task] = children(h, parent)
  await h.client.send({ type: "session.run.configure", sessionId: task!.taskId, noContextFiles: null, excludeTools: null })
  const resumed = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Clean", prompt: "Two.", task_id: task!.taskId } })
  expect(resumed.ok).toBe(true)
  expect(await limitsOf(h, task!.taskId)).toEqual(BARE_LIMITS)
})

test("without task_bare the argument is not offered and a client's bare is refused", async () => {
  const h = await boot({ steps: [stop("plain")] })
  cleanups.push(() => h.cleanup())
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const parent = await openSession(h)
  await say(h, parent, "hello")
  expect(JSON.stringify(h.requests[0]!.tools.find((tool) => tool.name === "task")!.parameters)).not.toContain("\"bare\"")
  const refused = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", bare: true } })
  expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("task_bare") } })
  expect(children(h, parent)).toHaveLength(0)
})

test("bare is refused with fork, and on a task that already ran with its context", async () => {
  const h = await start([stop("plain")])
  const parent = await openSession(h)
  const both = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", fork: true, bare: true } })
  expect(both).toMatchObject({ ok: false, error: { message: expect.stringContaining("fork and bare exclude each other") } })
  expect(children(h, parent)).toHaveLength(0)
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Plain", prompt: "x" } })).ok).toBe(true)
  const [plain] = children(h, parent)
  const late = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Plain", prompt: "y", task_id: plain!.taskId, bare: true } })
  expect(late).toMatchObject({ ok: false, error: { message: expect.stringContaining("bare applies to a new task only") } })
  expect(children(h, parent)[0]!.bare).toBeUndefined()
})

test("a bare child gets no agent profile's prompt, even a user's own general; naming an agent is refused", async () => {
  const h = await start([callTool("task", { description: "Clean", prompt: "Judge this.", bare: true }), stop("clean"), callTool("task", { description: "Plain", prompt: "Judge too." }), stop("plain"), stop("done")])
  mkdirSync(path.join(h.dir, "agents"), { recursive: true })
  writeFileSync(path.join(h.dir, "agents", "general.md"), "---\ndescription: The user's own general helper\nmode: subagent\n---\nUSER HOUSE CONVENTIONS")
  const parent = await openSession(h)
  await say(h, parent, "Ask a clean helper.")
  const [bare] = children(h, parent)
  expect(bare!.result).toBe("clean")
  expect((h.requests[1] as ModelRequest).system).not.toContain("USER HOUSE CONVENTIONS")
  // The same profile does reach a plain child.
  expect((h.requests[3] as ModelRequest).system).toContain("USER HOUSE CONVENTIONS")
  const named = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", bare: true, agent: "general" } })
  expect(named).toMatchObject({ ok: false, error: { message: expect.stringContaining("bare runs no agent profile") } })
})

test("bare is refused on an engine that takes no run limits (pi), before any child exists", async () => {
  const h = await boot({ steps: [stop("plain")], extraModels: [{ id: "pi:fake", name: "Pi fake", engine: "pi", efforts: [] }] })
  cleanups.push(() => h.cleanup())
  await h.client.send({ type: "settings.set", patch: { tier: "full", features: { task_bare: true } } })
  const parent = await openSession(h)
  const refused = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", bare: true, model: "pi:fake" } })
  expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("would still load its own instructions and skills") } })
  expect(children(h, parent)).toHaveLength(0)
})
