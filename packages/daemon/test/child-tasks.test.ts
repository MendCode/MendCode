import { afterEach, expect, test } from "bun:test"
import { createIdFactory, type SessionId, type TaskRecord, type TurnId } from "@mendcode/protocol"
import { answer, boot, callTool, hang, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const start = async (options: Parameters<typeof boot>[0] = {}) => { const h = await boot(options); all.push(h); return h }
const taskOf = (reply: { ok: boolean; result?: Record<string, unknown> }): TaskRecord => { expect(reply.ok).toBe(true); return reply.result?.task as TaskRecord }
const list = (h: NativeHarness, parent: SessionId) => h.store.tasks.list().filter((task) => task.parentId === parent)

test("accumulated spawn cap survives completed children and still permits task resumption", async () => {
  const h = await start({ steps: [stop("first"), stop("resume")] })
  const parent = await openSession(h)
  const child = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "One", prompt: "go" } }))
  h.store.meta.set(`orchestration.spawns:${parent}`, "256")
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "New", prompt: "go" } })).ok).toBe(false)
  expect(taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Resume", prompt: "go", task_id: child.taskId } })).generation).toBe(2)
})

test("task request retries return the original child and reject changed prompts", async () => {
  const h = await start({ steps: [stop("one response")] })
  const parent = await openSession(h)
  const input = { description: "One", prompt: "go", clientRequestId: "lost-ack" }
  const first = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input }))
  const replay = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input }))
  expect(replay.taskId).toBe(first.taskId)
  expect(list(h, parent)).toHaveLength(1)
  expect(h.requests).toHaveLength(1)
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { ...input, prompt: "changed" } })).ok).toBe(false)
})

test("native task tool forwards an explicit configured engine/model to the child registry in full tier", async () => {
  const h = await start({ steps: [callTool("task", { description: "Check", prompt: "check", engine: "native", model: "gpt-6-sol" }), stop("child done"), stop("parent done")] })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  await say(h, parent, "delegate")
  const child = list(h, parent)[0]!
  expect(child.state).toBe("completed")
  expect(h.store.sessionModel(child.taskId)?.model).toBe("gpt-6-sol")
  expect(h.requests[1]!.model).toBe("gpt-6-sol")
})

test("a model that writes Claude Code's subagent_type general-purpose gets the general sub-agent, not an unknown-agent error", async () => {
  const h = await start({ steps: [callTool("task", { description: "Check", prompt: "check", subagent_type: "general-purpose" }), stop("child done"), stop("parent done")] })
  const parent = await openSession(h)
  await say(h, parent, "delegate")
  const child = list(h, parent)[0]!
  expect(child).toMatchObject({ state: "completed", agent: "general" })
})

test("task owns a child transcript and resumes its saved conversation by task_id", async () => {
  const h = await start({ steps: [stop("first result"), stop("second result")] })
  const parent = await openSession(h)
  const first = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Research", prompt: "Find the entry point", agent: "explore" } }))
  expect(first).toMatchObject({ parentId: parent, depth: 1, generation: 1, state: "completed", result: "first result", agent: "explore" })
  expect(h.store.engineMessages.load(parent, "native")).toEqual([])
  expect(h.requests[0]!.tools.some((tool) => tool.name === "write")).toBe(false)
  const second = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Continue", prompt: "Explain its caller", task_id: first.taskId } }))
  expect(second).toMatchObject({ taskId: first.taskId, agent: "explore", generation: 2, state: "completed", result: "second result" })
  expect(h.requests[1]!.messages.some((message) => message.role === "assistant" && message.content === "first result")).toBe(true)
  const events = h.store.readAfter(first.taskId, 0, 100)
  expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2)
  expect((await h.client.tasks(parent)).ok).toBe(true)
})

test("task model and variant overrides persist; bad variants and cross-parent resume are refused", async () => {
  const h = await start({ steps: [stop("done")] })
  const parent = await openSession(h)
  const other = await openSession(h)
  const task = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "check", model: "gpt-6-sol#high" } }))
  expect(h.store.sessionModel(task.taskId)).toMatchObject({ model: "gpt-6-sol", variant: "high" })
  expect(h.requests[0]!.model).toBe("gpt-6-sol")
  for (const input of [
    { description: "bad", prompt: "bad", model: "gpt-6-sol", variant: "nope" },
    { description: "bad", prompt: "bad", model: "gpt-6-sol#high", variant: "low" },
    { description: "bad", prompt: "bad", task_id: task.taskId },
  ]) expect((await h.client.send({ type: "task.run", sessionId: input.task_id ? other : parent, input })).ok).toBe(false)
  expect(h.requests).toHaveLength(1)
})

test("a task model written loosely resolves to its one catalog id; an unknown one names the ids it probably meant", async () => {
  const h = await start({ steps: [stop("done")] })
  const parent = await openSession(h)
  const task = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "check", model: "GPT-6-SOL" } }))
  expect(h.store.sessionModel(task.taskId)?.model).toBe("gpt-6-sol")
  const unknown = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "check", model: "sol-6.1" } })
  expect(JSON.stringify(unknown)).toContain("unknown model sol-6.1; use an exact id such as gpt-6-sol")
  const nothingNear = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "check", model: "zzz" } })
  expect(JSON.stringify(nothingNear)).toContain("unknown model zzz; `mendcode models` lists the ids")
})

test("background returns before completion; status waits once and cancellation ends the exact child", async () => {
  const h = await start({ steps: [hang] })
  const parent = await openSession(h)
  const task = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Working", prompt: "Wait", background: true } }))
  await until(() => h.requests.length === 1)
  const waited = await h.client.send({ type: "task.status", sessionId: parent, taskId: task.taskId, action: "wait", timeoutMs: 1 })
  expect(waited.ok && waited.result?.text).toContain("wait_timed_out: true")
  expect((await h.client.send({ type: "task.status", sessionId: createIdFactory()("session"), taskId: task.taskId })).ok).toBe(false)
  await h.client.send({ type: "task.status", sessionId: parent, taskId: task.taskId, action: "cancel" })
  await until(() => list(h, parent)[0]!.state === "cancelled")
  expect(h.store.turns.list(task.taskId)[0]!.status).toBe("cancelled")
})

test("configured admission caps are active-only and nested tasks preserve the root", async () => {
  const h = await start({ steps: [hang, stop("nested"), stop("replacement")] })
  const parent = await openSession(h)
  // Owner wake off: the cancelled background child must not start a parent turn that takes the replacement's scripted step.
  await h.client.send({ type: "settings.set", patch: { subagentMaxChildren: 1, subagentMaxDescendants: 2, subagentOwnerWake: false } })
  const child = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "One", prompt: "Wait", background: true } }))
  await until(() => h.requests.length === 1)
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Two", prompt: "Go", background: true } })).ok).toBe(false)
  expect((await h.client.send({ type: "task.run", sessionId: child.taskId, input: { description: "Nested", prompt: "Go" } })).ok).toBe(false)
  await h.client.send({ type: "settings.set", patch: { subagentDepth: 2 } })
  const nested = taskOf(await h.client.send({ type: "task.run", sessionId: child.taskId, input: { description: "Nested", prompt: "Go" } }))
  expect(nested).toMatchObject({ depth: 2, rootId: parent, parentId: child.taskId })
  await h.client.send({ type: "task.status", sessionId: parent, taskId: child.taskId, action: "cancel" })
  await until(() => list(h, parent)[0]!.state === "cancelled")
  const replacement = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Replacement", prompt: "Go" } }))
  expect(replacement.state).toBe("completed")
})

test("restart retains a stopped child and task_id continues the same persisted context", async () => {
  const h = await start({ steps: [stop("before restart")] })
  const parent = await openSession(h)
  const child = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Work", prompt: "Start" } }))
  await h.daemon.stop()
  h.client.close()
  const next = await start({ dir: h.dir, project: h.project, steps: [stop("after restart")] })
  const resumed = taskOf(await next.client.send({ type: "task.run", sessionId: parent, input: { description: "Resume", prompt: "Continue", task_id: child.taskId } }))
  expect(resumed).toMatchObject({ taskId: child.taskId, generation: 2, state: "completed" })
  expect(next.requests[0]!.messages.some((message) => message.role === "assistant" && message.content === "before restart")).toBe(true)
})

test("task and task_status model tools use the daemon child registry", async () => {
  const h = await start({ steps: [callTool("task", { description: "Find", prompt: "Find files", subagent_type: "explore" }), stop("found"), callTool("task_status", { action: "list" }), stop("parent done")] })
  const parent = await openSession(h)
  await say(h, parent, "Research")
  const task = list(h, parent)[0]!
  expect(task.state).toBe("completed")
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task", output: expect.stringContaining(task.taskId) })
  expect(h.requests[3]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task_status", output: expect.stringContaining(task.taskId) })
  expect(h.store.engineMessages.load(task.taskId, "native")).not.toEqual([])
})

test("detachment is persisted without cancelling its running turn", async () => {
  const h = await start({ steps: [hang] })
  const parent = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: parent, text: "work", attachments: [] })
  await until(() => h.requests.length === 1)
  expect((await h.client.send({ type: "session.detach", sessionId: parent })).ok).toBe(true)
  expect(h.store.detached.has(parent)).toBe(true)
  expect(h.store.sessionsWithActiveTurn().some((session) => session.sessionId === parent)).toBe(true)
})

test("zero depth disables delegation; a descendant cap covers the entire active tree", async () => {
  const h = await start({ steps: [hang] })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { subagentDepth: 0 } })
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Disabled", prompt: "Go" } })).ok).toBe(false)
  await h.client.send({ type: "settings.set", patch: { subagentDepth: 3, subagentMaxChildren: 4, subagentMaxDescendants: 1 } })
  const child = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Root child", prompt: "Wait", background: true } }))
  await until(() => h.requests.length === 1)
  const nested = await h.client.send({ type: "task.run", sessionId: child.taskId, input: { description: "Nested", prompt: "Go", background: true } })
  expect(nested.ok).toBe(false)
  if (!nested.ok) expect(nested.error.message).toContain("descendant limit")
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Active resume", prompt: "Go", task_id: child.taskId } })).ok).toBe(false)
  expect(h.requests).toHaveLength(1)
})

test("cancelling a foreground parent task also cancels its running child", async () => {
  const h = await start({ steps: [callTool("task", { description: "Foreground", prompt: "Wait" }), hang] })
  const parent = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: parent, text: "Delegate", attachments: [] })
  await until(() => h.requests.length === 2)
  const child = list(h, parent)[0]!
  const turnId = h.store.turns.list(parent)[0]!.turnId as TurnId
  await h.client.send({ type: "turn.cancel", sessionId: parent, turnId })
  await until(() => list(h, parent)[0]?.state === "cancelled")
  expect(h.store.turns.list(child.taskId)[0]?.status).toBe("cancelled")
})

test("a child's record keeps what it spent and the files it wrote, summed over its generations", async () => {
  const h = await start({ steps: [callTool("write", { path: "notes.txt", content: "a\n" }), answer("wrote it", { input: 1200, output: 80 }), answer("again", { input: 300, output: 20 })] })
  const parent = await openSession(h)
  const first = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Write", prompt: "Write notes.txt" } }))
  expect(first.stats).toEqual({ input: 1200, output: 80, files: ["notes.txt"] })
  const second = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Again", prompt: "Once more", task_id: first.taskId } }))
  expect(second.stats).toEqual({ input: 1500, output: 100, files: ["notes.txt"] })
})

test("a child resumed with task_id and another model goes on with its own history on that model, and keeps it after", async () => {
  const h = await start({ steps: [stop("first answer"), stop("second answer"), stop("third answer")] })
  const parent = await openSession(h)
  const task = taskOf(await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "first prompt", model: "gpt-6-sol" } }))
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "second prompt", task_id: task.taskId, model: "gpt-6-luna" } })).ok).toBe(true)
  expect(h.requests.map((request) => request.model)).toEqual(["gpt-6-sol", "gpt-6-luna"])
  expect(JSON.stringify(h.requests[1])).toContain("first prompt")
  expect(JSON.stringify(h.requests[1])).toContain("first answer")
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Check", prompt: "third prompt", task_id: task.taskId } })).ok).toBe(true)
  expect(h.requests[2]!.model).toBe("gpt-6-luna")
  expect(h.store.sessionModel(task.taskId)).toMatchObject({ model: "gpt-6-luna" })
})
