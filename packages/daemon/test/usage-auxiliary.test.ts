import { afterEach, expect, test } from "bun:test"
import type { ModelEvent } from "@mendcode/engine-native"
import { UsageReport, type SessionEvent } from "@mendcode/protocol"
import { boot, openSession, say, until, type NativeHarness } from "./native-harness"
import { localDay } from "../src/usage-today"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup() })

/** A turn whose provider reports its tokens, so the turn itself has a `usage.recorded`. */
const reported = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "usage", usage: { input: 500, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "stop" }]

test("a generated title is recorded as an auxiliary call of its session, apart from the turn totals", async () => {
  const calls: string[] = []
  const h = await boot({
    steps: [reported("done")],
    // The fake completion reports usage the way the native one does (`completeWithUsage`); no provider is reached.
    complete: async () => { throw new Error("the budgeted completion must use setupComplete when it is set") },
    setupComplete: async (input) => {
      calls.push(input.system)
      return { text: "Fix the parser", usage: { provider: "chatgpt", model: input.model?.model ?? "script-1", input: 1_200, output: 9, reasoning: 3, cacheRead: 100, cacheWrite: 0 } }
    },
  })
  harnesses.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "please fix the parser")
  await until(() => h.store.sessionInfo(sessionId)?.title === "Fix the parser")
  expect(calls).toHaveLength(1)

  const day = localDay(Date.now())
  const query = async (extra: Record<string, unknown>) => {
    const reply = await h.client.send({ type: "usage.query", from: day, to: day, ...extra } as never)
    if (!reply.ok) throw new Error(reply.error.message)
    return UsageReport.parse(reply.result)
  }
  const global = await query({ scope: "global" })
  expect(global.auxiliary).toEqual([{ role: "title", provider: "chatgpt", model: "script-1", input: 1_200, output: 9, reasoning: 3, cacheRead: 100, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 }])
  // The project scope keeps it (the session's directory); another directory does not.
  expect((await query({ scope: "directory", directory: h.project }))?.auxiliary?.map((entry) => entry.role)).toEqual(["title"])
  expect((await query({ scope: "directory", directory: "/nonexistent-usage-aux" }))?.auxiliary).toBeUndefined()

  // Turn totals hold the turn's own call only: the title is not counted twice.
  const recorded = h.events.filter((event): event is Extract<SessionEvent, { type: "usage.recorded" }> => event.type === "usage.recorded" && event.sessionId === sessionId)
  expect(recorded).toHaveLength(1)
  expect(global.days.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, calls: sum.calls + row.calls }), { input: 0, output: 0, calls: 0 })).toEqual({ input: 500, output: 40, calls: 1 })
  expect(global.models.map((model) => [model.model, model.input, model.calls])).toEqual([[recorded[0]!.model, 500, 1]])
})

test("a failed auxiliary call still counts as one call of its role, with unknown tokens and cost", async () => {
  const h = await boot({
    steps: [reported("done")],
    complete: async () => "unused",
    setupComplete: async () => { throw new Error("provider down") },
  })
  harnesses.push(h)
  const sessionId = await openSession(h)
  await say(h, sessionId, "hello")
  const day = localDay(Date.now())
  await until(() => h.store.usageAuxiliary.report({ from: day, to: day }).length > 0)
  expect(h.store.usageAuxiliary.report({ from: day, to: day })).toEqual([{ role: "title", provider: "", model: "script-1", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 }])
})
