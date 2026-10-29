import { afterEach, expect, test } from "bun:test"
import type { ModelEvent } from "@mendcode/engine-native"
import type { SessionId, TaskRecord } from "@mendcode/protocol"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMentionRouting, leadingMention } from "../src/agent-mentions"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const child = (h: NativeHarness, parent: SessionId) => h.store.tasks.list().find((task) => task.parentId === parent)!
const lastUser = (index: number) => JSON.stringify(h!.requests[index]!.messages.filter((message) => message.role === "user").at(-1))
async function explore(h: NativeHarness, parent: SessionId, background = false) {
  const reply = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Find the router", prompt: "Find the router", agent: "explore", ...(background ? { background } : {}) } })
  expect(reply.ok).toBe(true)
  return (reply as unknown as { result: { task: TaskRecord } }).result.task
}
const submit = (h: NativeHarness, sessionId: SessionId, text: string) => h.client.send({ type: "user.submit", sessionId, text, attachments: [] })

test("a prompt opening with @agent continues this session's idle child of that agent and says it was delivered", async () => {
  h = await boot({ steps: [stop("router is in src/router.ts"), stop("called from main.ts"), stop("parent read the result"), stop("spare")] })
  const parent = await openSession(h)
  const first = await explore(h, parent)
  const ack = await submit(h, parent, "@explore who calls it?")
  expect(ack).toMatchObject({ ok: true, result: { handled: true, mention: { agent: "explore", taskId: first.taskId, delivery: "delivered" }, notice: expect.stringContaining("delivered") } })
  await until(() => child(h!, parent).generation === 2 && child(h!, parent).state === "completed")
  // The child's own conversation goes on: it sees its first answer and the message without the @name.
  expect(lastUser(1)).toContain("who calls it?")
  expect(lastUser(1)).not.toContain("@explore")
  expect(JSON.stringify(h.requests[1]!.messages)).toContain("router is in src/router.ts")
  expect(child(h, parent)).toMatchObject({ background: true, result: "called from main.ts" })
})

test("a message for a child that is still working is queued and reaches it as soon as its step ends", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const slow = async (): Promise<ModelEvent[]> => { await gate; return stop("first pass") }
  // The parent's wake (its background child ended) and the child's second pass race for the next calls: answer by who asks.
  const either = (request: { messages: unknown[] }) => stop(JSON.stringify(request.messages.at(-1)).includes("also check the tests") ? "second pass" : "parent woke")
  h = await boot({ steps: [slow, either, either, either, either] })
  const parent = await openSession(h)
  await explore(h, parent, true)
  await until(() => h!.requests.length === 1)
  const ack = await submit(h, parent, "@explore, also check the tests")
  expect(ack).toMatchObject({ ok: true, result: { handled: true, mention: { delivery: "queued" }, notice: expect.stringContaining("queued") } })
  expect(h.requests).toHaveLength(1)
  release()
  await until(() => child(h!, parent).generation === 2 && child(h!, parent).state === "completed")
  expect(lastUser(1)).toContain("also check the tests")
  expect(child(h, parent).result).toBe("second pass")
})

test("without a child of that agent, with agentMentions delegate, or with sub-agents off, @agent stays a note to the model", async () => {
  h = await boot({ steps: [stop("no child yet"), stop("explored"), stop("delegated"), stop("off")] })
  const parent = await openSession(h)
  await say(h, parent, "@explore find the router")
  expect(JSON.stringify(h.requests[0]!.messages)).toContain("<agent-mention name=\\\"explore\\\">")
  await explore(h, parent)
  await h.client.send({ type: "settings.set", patch: { agentMentions: "delegate" } })
  await say(h, parent, "@explore again")
  expect(JSON.stringify(h.requests[2]!.messages)).toContain("<agent-mention name=\\\"explore\\\">")
  // Minimalist has no task tool, so a note that asks for it would only cost tokens.
  await h.client.send({ type: "settings.set", patch: { agentMentions: "address", tier: "minimalist" } })
  await say(h, parent, "@explore once more")
  expect(JSON.stringify(h.requests[3]!.messages.at(-1))).not.toContain("agent-mention")
})

test("only a known name at the very start addresses an agent, and only with a message after it", () => {
  const known = ["explore", "general"]
  expect(leadingMention("@explore, where is main?", known)).toEqual({ name: "explore", message: "where is main?" })
  expect(leadingMention("  @general: summarize", known)).toEqual({ name: "general", message: "summarize" })
  expect(leadingMention("ask @explore where main is", known)).toBeUndefined()
  expect(leadingMention("@explorer where", known)).toBeUndefined()
  expect(leadingMention("@explore   ", known)).toBeUndefined()
})

test("held messages survive a restart: the next routing resumes the interrupted child with them and clears the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mention-routing-"))
  try {
    const file = path.join(dir, "agent-mentions.json")
    const running = { taskId: "session_child" as SessionId, parentId: "session_parent" as SessionId, agent: "explore", state: "running", updatedAt: 1 } as TaskRecord
    const first = createMentionRouting({ children: () => [running], resume: async (_, task) => task, failed: () => {}, file })
    expect(await first.send(running.parentId, "explore", "also check the tests")).toMatchObject({ delivery: "queued" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const resumed: string[] = []
    const interrupted = { ...running, state: "interrupted" } as TaskRecord
    createMentionRouting({ children: () => [interrupted], task: () => interrupted, resume: async (_, task, prompt) => (resumed.push(prompt), task), failed: () => {}, file })
    await until(() => resumed.length === 1)
    expect(resumed).toEqual(["also check the tests"])
    expect(existsSync(file)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
