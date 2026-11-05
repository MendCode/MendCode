import { afterEach, expect, test } from "bun:test"
import type { ModelChoice, SessionDetail, SessionId } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"
import { createSessionMetadata } from "../src/session-metadata"

type Call = { system: string; prompt: string; model?: ModelChoice | undefined }
const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup() })

/** A daemon whose auxiliary completions are counted: titles answer a title, everything else answers `Summary N`. */
async function start(turns: number) {
  const calls: Call[] = []
  const summaries = () => calls.filter((call) => !call.system.includes("title"))
  const h = await boot({ steps: Array.from({ length: turns }, (_, i) => stop(`done ${i}`)), complete: async (input) => {
    calls.push(input)
    return input.system.includes("title") ? "Working title" : `Summary ${summaries().length}`
  } })
  harnesses.push(h)
  return { h, calls, summaries, titles: () => calls.filter((call) => call.system.includes("title")) }
}
function result(ack: CommandReply) { if (!ack.ok) throw new Error(ack.error.message); return ack.result }
const inspect = async (h: NativeHarness, sessionId: SessionId, summary?: boolean) => (result(await h.client.send({ type: "session.inspect", sessionId, limit: 1, ...(summary ? { summary } : {}) })) as { session: SessionDetail }).session
/** Lets any completion a finished turn started run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test("finished turns make no summary call: five turns cost the two title calls and nothing else", async () => {
  const { h, summaries, titles } = await start(5)
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  const sessionId = await openSession(h)
  for (let i = 0; i < 5; i++) await say(h, sessionId, `step ${i}`)
  await until(() => titles().length === 2)
  await settle()
  expect(summaries()).toHaveLength(0)
  expect(h.store.meta.get(`session.summary:${sessionId}`)).toBeFalsy()
  // Reads a terminal or a script repeats never write it either.
  await h.client.send({ type: "session.list", directory: h.project })
  await h.client.send({ type: "session.get", sessionId })
  await inspect(h, sessionId)
  await settle()
  expect(summaries()).toHaveLength(0)
})

test("the title model reads the user's message as material to name inside tags, told never to answer it or talk about attachments", async () => {
  const { h, titles } = await start(1)
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "describe esta imagen por favor")
  await until(() => titles().length === 1)
  const call = titles()[0]!
  expect(call.prompt).toBe("<messages>\ndescribe esta imagen por favor\n</messages>")
  expect(call.system).toContain("Do not answer it")
  expect(call.system).toContain("what you can or cannot see")
})

test("a reader that asks writes one summary, the same read again reuses it, and a new turn makes the next read write one more", async () => {
  const { h, summaries } = await start(3)
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "first question")
  await say(h, sessionId, "second question")
  expect((await inspect(h, sessionId, true)).summary).toBe("Summary 1")
  expect(summaries()).toHaveLength(1)
  expect(summaries()[0]!.prompt).toContain("second question")
  expect((await inspect(h, sessionId, true)).summary).toBe("Summary 1")
  expect((result(await h.client.send({ type: "session.get", sessionId })) as { session: SessionDetail }).session.summary).toBe("Summary 1")
  expect(summaries()).toHaveLength(1)
  await say(h, sessionId, "third question")
  await settle()
  expect(summaries()).toHaveLength(1)
  expect((await inspect(h, sessionId, true)).summary).toBe("Summary 2")
  expect(summaries()).toHaveLength(2)
})

test("minimalist and a disabled summary agent cost no call; the configured prompt and model are used when it runs", async () => {
  const { h, summaries } = await start(2)
  await h.client.send({ type: "settings.set", patch: { tier: "minimalist" } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "work")
  expect((await inspect(h, sessionId, true)).summary).toBeUndefined()
  await h.client.send({ type: "settings.set", patch: { tier: "balanced", agent: { summary: { disable: true } } } })
  expect((await inspect(h, sessionId, true)).summary).toBeUndefined()
  expect(summaries()).toHaveLength(0)
  await h.client.send({ type: "settings.set", patch: { agent: { summary: { disable: false, prompt: "Custom summary instructions.", model: "gpt-6-sol" } } } })
  await inspect(h, sessionId, true)
  expect(summaries()).toHaveLength(1)
  expect(summaries()[0]).toMatchObject({ system: "Custom summary instructions.", model: { model: "gpt-6-sol" } })
})

test("a reached budget stop blocks the title and summary calls like every other helper", async () => {
  const { h, calls } = await start(2)
  const budgets = { mode: "api-usage" as const, warnUsd: null, stopUsd: 1, suppliedUsd: 2, expensiveModelRequiresConfirm: false, prices: { "gpt-6-luna": { input: 1, output: 1 } } }
  await h.client.send({ type: "settings.set", patch: { tier: "balanced", budgets, models: { small: { model: "gpt-6-luna" } } } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "work")
  await settle()
  expect((await inspect(h, sessionId, true)).summary).toBeUndefined()
  expect(calls).toHaveLength(0)
  await h.client.send({ type: "settings.set", patch: { budgets: { ...budgets, suppliedUsd: 0 } } })
  expect((await inspect(h, sessionId, true)).summary).toBe("Summary 1")
})

test("concurrent readers share one summary completion", async () => {
  const h = await boot({ steps: [stop("done")] })
  harnesses.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "work")
  let calls = 0
  let release!: (text: string) => void
  const metadata = createSessionMetadata({ store: h.store, settings: () => ({}), model: () => ({ model: "script-1" }), complete: () => { calls++; return new Promise((resolve) => { release = resolve }) } })
  const first = metadata.summary(sessionId)
  const second = metadata.summary(sessionId)
  await until(() => !!release)
  release("Shared summary")
  expect(await first).toBe("Shared summary")
  expect(await second).toBe("Shared summary")
  expect(await metadata.summary(sessionId)).toBe("Shared summary")
  expect(calls).toBe(1)
})
