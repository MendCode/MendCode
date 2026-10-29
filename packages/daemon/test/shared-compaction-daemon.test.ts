import { afterEach, expect, test } from "bun:test"
import type { ModelEvent } from "@mendcode/engine-native"
import type { SessionEvent } from "@mendcode/protocol"
import { boot, callTool, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.cleanup() })

const SUMMARY = "## Goal\nKeep the pagination fix."
const thought = (text: string): ModelEvent => ({ type: "reasoning_state", state: { provider: "scripted", model: "scripted", blocks: [{ type: "thinking", thinking: text, signature: "sig" }] } })

/**
 * Through the daemon and its real store, whose history rows are only appended: `/compact` after two turns (a tool step, signed
 * reasoning that the second turn dropped in memory) repeats the last call's request and appends the summary prompt.
 */
test("/compact <instructions> repeats the session's last request from the stored history, and its card says so", async () => {
  const h = await boot({ steps: [[thought("one"), ...callTool("probe", {})], [thought("two"), ...stop("First done")], [thought("three"), ...stop("Second done")], stop(SUMMARY)] })
  running.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "Fix pagination")
  await say(h, sessionId, "Now the empty page")
  expect(await h.client.send({ type: "session.compact", sessionId, instructions: "Keep the test names." })).toMatchObject({ ok: true })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "packed"))
  expect(h.requests).toHaveLength(4)
  const [main, compaction] = [h.requests[2]!, h.requests[3]!]
  expect(compaction.tools).toEqual(main.tools)
  expect(compaction.system).toBe(main.system)
  expect(compaction.messages.slice(0, main.messages.length)).toEqual(main.messages)
  expect(compaction.messages).toHaveLength(main.messages.length + 2)
  const prompt = (compaction.messages.at(-1) as { content: string }).content
  expect(prompt).toContain("Keep the test names.")
  expect(prompt).toContain("Do not call any tool")
  const card = h.events.find((event): event is Extract<SessionEvent, { type: "item.started" }> => event.type === "item.started" && event.kind === "compaction")
  expect(card?.meta).toMatchObject({ cachedPrefix: true })
  expect(h.store.engineMessages.load(sessionId, "native")[0]).toMatchObject({ role: "user", content: expect.stringContaining("Keep the pagination fix") })
})
