import { afterEach, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import type { SessionEvent } from "@mendcode/protocol"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.cleanup() })

test("native compaction queues one follow-up after history replacement; reconnect replays its saved panel", async () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const h = await boot({ steps: [stop("Original answer"), async () => { await ready; return stop("## Saved memory\n\nKeep the local tests.") }, stop("Follow-up complete")] })
  running.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "Original work")
  await h.client.send({ type: "session.compact", sessionId })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "writing"))
  const writing = h.events.findLast((event) => event.type === "compaction.updated")!
  if (writing.type !== "compaction.updated") throw new Error("missing compaction")
  expect(await h.client.setCompactionFollowUp(sessionId, writing.turnId, "Now run the tests")).toMatchObject({ ok: true })
  release()
  await until(() => h.requests.length === 3 && h.events.some((event) => event.type === "turn.completed" && event.turnId !== writing.turnId && event.at >= writing.at))
  const packed = h.events.findLast((event) => event.type === "compaction.updated")
  expect(packed).toMatchObject({ state: "packed", followUp: "Now run the tests", followUpQueueId: expect.any(String) })
  expect(h.events.filter((event) => event.type === "queue.added" && event.text === "Now run the tests")).toHaveLength(1)
  expect(h.requests[2]!.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("Saved memory") })
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: "Now run the tests" })
  expect(await h.client.setCompactionFollowUp(sessionId, writing.turnId, "Too late")).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  const replay: SessionEvent[] = []
  const observer = createClient({ socketPath: h.daemon.socketPath, name: "compaction-replay", onEvent: (event) => void replay.push(event) })
  try {
    await observer.connect()
    await observer.subscribe(sessionId, 0)
    await until(() => replay.some((event) => event.type === "compaction.updated" && event.state === "packed"))
    expect(replay.findLast((event) => event.type === "compaction.updated")).toEqual(packed)
  } finally { await observer.close() }
})

test("a summary-free compaction retains a redacted follow-up without calling the model again", async () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  // An empty reply to the request that repeats the last call is retried once as the compaction's own request: empty again here.
  const h = await boot({ steps: [stop("Original"), async () => { await ready; return stop("") }, stop("")] })
  running.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "Original")
  await h.client.send({ type: "session.compact", sessionId })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "writing"))
  const writing = h.events.findLast((event) => event.type === "compaction.updated")!
  if (writing.type !== "compaction.updated") throw new Error("missing compaction")
  const fakeKey = "s" + "k-" + "a".repeat(48)
  await h.client.setCompactionFollowUp(sessionId, writing.turnId, `Use ${fakeKey} for tests`)
  release()
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "skipped"))
  const event = h.events.findLast((event) => event.type === "compaction.updated")!
  if (event.type !== "compaction.updated") throw new Error("missing compaction")
  expect(event.followUp).not.toContain(fakeKey)
  expect(event.followUp).toContain("secret:")
  expect(event.followUpQueueId).toBeUndefined()
  expect(h.requests).toHaveLength(3)
})
