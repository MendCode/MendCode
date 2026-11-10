import { describe, expect, test } from "bun:test"
import { RetryableProviderError, type ModelEvent } from "@mendcode/engine-native"
import { retryingCompletion } from "../src/completion-retry"

const overloaded = () => new RetryableProviderError("[PROVIDER]: chatgpt Our servers are currently overloaded. Please try again later.")

function scripted(runs: Array<ModelEvent[] | Error | { events: ModelEvent[]; then: Error }>) {
  let calls = 0
  const attempt = async function* (): AsyncGenerator<ModelEvent> {
    const run = runs[calls++]!
    if (run instanceof Error) throw run
    if (Array.isArray(run)) { yield* run; return }
    yield* run.events
    throw run.then
  }
  return { attempt, calls: () => calls }
}

async function collect(events: AsyncIterable<ModelEvent>) {
  const seen: ModelEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

describe("retryingCompletion", () => {
  test("an overloaded provider is waited out and the completion succeeds on the next attempt", async () => {
    const waits: number[] = []
    const run = scripted([overloaded(), overloaded(), [{ type: "text", delta: "{}" }]])
    const events = await collect(retryingCompletion({ attempt: run.attempt, signal: new AbortController().signal, sleep: async (ms) => void waits.push(ms) }))
    expect(events).toEqual([{ type: "text", delta: "{}" }])
    expect(run.calls()).toBe(3)
    expect(waits).toEqual([500, 1_000])
  })

  test("the provider's retry-after wins over a shorter backoff", async () => {
    const waits: number[] = []
    const run = scripted([new RetryableProviderError("[PROVIDER]: rate limited", 7_000), [{ type: "text", delta: "ok" }]])
    await collect(retryingCompletion({ attempt: run.attempt, signal: new AbortController().signal, sleep: async (ms) => void waits.push(ms) }))
    expect(waits).toEqual([7_000])
  })

  test("the failure surfaces once the retries are spent", async () => {
    const run = scripted([overloaded(), overloaded(), overloaded()])
    await expect(collect(retryingCompletion({ attempt: run.attempt, signal: new AbortController().signal, retries: 2, sleep: async () => {} }))).rejects.toThrow("overloaded")
    expect(run.calls()).toBe(3)
  })

  test("a failure that does not pass by itself is not retried", async () => {
    const run = scripted([new Error("[PROVIDER]: invalid model"), [{ type: "text", delta: "never" }]])
    await expect(collect(retryingCompletion({ attempt: run.attempt, signal: new AbortController().signal, sleep: async () => {} }))).rejects.toThrow("invalid model")
    expect(run.calls()).toBe(1)
  })

  test("a failure after text has streamed is final, so shown text is never repeated", async () => {
    const run = scripted([{ events: [{ type: "text", delta: "half" }], then: overloaded() }, [{ type: "text", delta: "again" }]])
    const seen: ModelEvent[] = []
    await expect((async () => { for await (const event of retryingCompletion({ attempt: run.attempt, signal: new AbortController().signal, sleep: async () => {} })) seen.push(event) })()).rejects.toThrow("overloaded")
    expect(seen).toEqual([{ type: "text", delta: "half" }])
    expect(run.calls()).toBe(1)
  })

  test("a cancelled completion stops waiting and does not try again", async () => {
    const controller = new AbortController()
    const run = scripted([overloaded(), [{ type: "text", delta: "late" }]])
    await expect(collect(retryingCompletion({ attempt: run.attempt, signal: controller.signal, sleep: async () => controller.abort() }))).rejects.toThrow("overloaded")
    expect(run.calls()).toBe(1)
  })
})
