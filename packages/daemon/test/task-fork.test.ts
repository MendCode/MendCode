import { afterEach, expect, test } from "bun:test"
import type { ModelRequest } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { boot, callTool, openSession, say, stop, type NativeHarness } from "./native-harness"

/** `task` with `fork: true` on the daemon (feature `task_fork`): the child's first request repeats the parent's latest one. Scripted model, temp dirs. */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function start(steps: NonNullable<Parameters<typeof boot>[0]>["steps"], fork = true) {
  const h = await boot({ ...(steps ? { steps } : {}) })
  cleanups.push(() => h.cleanup())
  await h.client.send({ type: "settings.set", patch: { tier: "full", ...(fork ? { features: { task_fork: true } } : {}) } })
  return h
}
const children = (h: NativeHarness, parent: SessionId) => h.store.tasks.list().filter((task) => task.parentId === parent)
const toolNames = (request: ModelRequest) => request.tools.map((tool) => tool.name)
const taskResult = (request: ModelRequest) => JSON.stringify(request.messages.at(-1))

test("a forked child's first request is the parent's latest one (system, tools, messages, cache key) plus its task", async () => {
  const h = await start([
    stop("noted"),
    callTool("task", { description: "Recall the word", prompt: "Say the code word.", fork: true }),
    stop("plum"),
    stop("the child said plum"),
  ])
  const parent = await openSession(h)
  await say(h, parent, "The code word is plum.")
  await say(h, parent, "Ask a forked helper for the code word.")
  const [, delegating, child] = h.requests as [ModelRequest, ModelRequest, ModelRequest, ModelRequest]
  expect(JSON.stringify(delegating.tools.find((tool) => tool.name === "task")!.parameters)).toContain("\"fork\"")
  expect(child.system).toBe(delegating.system)
  expect(toolNames(child)).toEqual(toolNames(delegating))
  expect(child.messages.slice(0, delegating.messages.length)).toEqual(delegating.messages)
  expect(child.messages).toHaveLength(delegating.messages.length + 1)
  expect(JSON.stringify(child.messages.at(-1))).toContain("forked from the conversation above")
  expect(JSON.stringify(child.messages.at(-1))).toContain("Say the code word.")
  expect(child.cacheKey).toBe(delegating.cacheKey)
  expect([child.effort, child.parameters]).toEqual([delegating.effort, delegating.parameters])
  const task = children(h, parent)[0]!
  expect([task.state, task.fork, task.result]).toEqual(["completed", true, "plum"])
  expect(h.store.sessionModel(task.taskId)?.model).toBe(h.store.sessionModel(parent)?.model ?? "script-1")
  expect(taskResult(h.requests[3]!)).toContain("context: forked")
})

test("a fork asked for another model runs fresh and says why; without fork the child starts with its prompt alone", async () => {
  const h = await start([
    callTool("task", { description: "Other model", prompt: "Answer on another model.", fork: true, model: "gpt-6-sol" }),
    stop("fresh answer"),
    callTool("task", { description: "Plain", prompt: "Plain child." }),
    stop("plain answer"),
    stop("done"),
  ])
  const parent = await openSession(h)
  await say(h, parent, "Delegate twice.")
  const [delegating, other, , plain] = h.requests as [ModelRequest, ModelRequest, ModelRequest, ModelRequest]
  for (const child of [other, plain]) {
    expect(child.messages).toHaveLength(1)
    expect(child.cacheKey).not.toBe(delegating.cacheKey)
    expect(toolNames(child)).not.toContain("plan_submit")
  }
  expect(taskResult(h.requests[2]!)).toContain("context: fresh (fork unavailable: another model cannot read the parent's cache)")
  expect(taskResult(h.requests[4]!)).not.toContain("context:")
  expect(children(h, parent).map((task) => task.fork)).toEqual([undefined, undefined])
})

test("without task_fork the argument is not offered and a client's fork is refused", async () => {
  const h = await start([stop("plain")], false)
  const parent = await openSession(h)
  await say(h, parent, "hello")
  expect(JSON.stringify(h.requests[0]!.tools.find((tool) => tool.name === "task")!.parameters)).not.toContain("\"fork\"")
  const refused = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", fork: true } })
  expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("task_fork") } })
  expect(children(h, parent)).toHaveLength(0)
})
