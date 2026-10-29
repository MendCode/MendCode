import { describe, expect, test } from "bun:test"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory, RetryableProviderError, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()
const CONTINUE = "continue from the cut"

type Step = ModelEvent[] | Error | ((request: ModelRequest) => AsyncIterable<ModelEvent>)

/** Replays one scripted response per model call and records every request it received. */
function scriptedProvider(steps: Step[], probe?: () => Promise<boolean>) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      if (step instanceof Error) throw step
      if (typeof step === "function") return yield* step(request)
      yield* step
    },
    ...(probe ? { probe } : {}),
  }
  return { provider, requests }
}

function turn(signal: AbortSignal = new AbortController().signal) {
  const events: EngineEvent[] = []
  const input: TurnInput = {
    permissionMode: () => "ask",
    setPermissionMode: () => {},
    sessionId: ids("session"),
    turnId: ids("turn"),
    text: "go",
    attachments: [],
    signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async () => ({ kind: "deny" }),
  }
  return { input, events }
}

const network = (message = "ECONNRESET") => new RetryableProviderError(`[PROVIDER]: ${message}`, undefined, "network")
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
/** Streams `text` in pieces, then the connection drops. */
const cutAfter = (...pieces: string[]) =>
  async function* (): AsyncIterable<ModelEvent> {
    for (const delta of pieces) yield { type: "text", delta }
    throw network("stream interrupted: ECONNRESET")
  }
const noWake = () => () => {}

function engineWith(provider: ModelProvider, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const history = memoryHistory()
  const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", continuationPrompt: CONTINUE, sleep: async () => {}, watchWake: noWake, ...extra })
  return { engine, history }
}

const texts = (events: EngineEvent[]) => events.filter((e) => e.type === "item.delta").map((e) => (e as { text: string }).text)

describe("engine resilience", () => {
  test("an answer cut mid-stream continues in the same item, with the repeated words trimmed", async () => {
    const { provider, requests } = scriptedProvider([cutAfter("The migration copies ", "the tables first"), stop("the tables first, then swaps the reads.")])
    const { engine, history } = engineWith(provider)
    const { input, events } = turn()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(events.filter((e) => e.type === "item.started")).toHaveLength(1)
    expect(texts(events).join("")).toBe("The migration copies the tables first, then swaps the reads.")
    expect(events.filter((e) => e.type === "item.completed")).toEqual([expect.objectContaining({ status: "ok", text: "The migration copies the tables first, then swaps the reads." })])
    // The retry sends the partial back as the assistant's turn, followed by the continuation prompt.
    expect(requests[1]!.messages.slice(-2)).toEqual([
      { role: "assistant", content: "The migration copies the tables first", toolCalls: [] },
      { role: "user", content: CONTINUE },
    ])
    // History keeps one whole answer, never the prompt.
    const saved = (await history.load(input.sessionId))!
    expect(saved.at(-1)).toMatchObject({ role: "assistant", content: "The migration copies the tables first, then swaps the reads." })
    expect(saved.some((m) => m.role === "user" && m.content === CONTINUE)).toBe(false)
  })

  test("two cuts in a row still end as one answer", async () => {
    const { provider } = scriptedProvider([cutAfter("Alpha beta "), cutAfter("gamma "), network(), stop("delta.")])
    const { engine } = engineWith(provider)
    const { input, events } = turn()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(texts(events).join("")).toBe("Alpha beta gamma delta.")
    expect(events.filter((e) => e.type === "item.started")).toHaveLength(1)
  })

  test("two hours offline: the turn keeps waiting at 30 s and finishes when the network is back", async () => {
    // 31.5 s of short waits, then 30 s each: 250 failures is just over two hours.
    const failures = 250
    const { provider } = scriptedProvider([...Array.from({ length: failures }, () => network()), stop("back online")])
    const waits: number[] = []
    const { engine } = engineWith(provider, { sleep: async (ms) => void waits.push(ms) })
    const { input, events } = turn()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    const retries = events.filter((e) => e.type === "retrying") as Array<Extract<EngineEvent, { type: "retrying" }>>
    expect(retries).toHaveLength(failures)
    expect(retries.every((e) => e.offline === true)).toBe(true)
    expect(Math.max(...retries.map((e) => e.delayMs))).toBe(30_000)
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(2 * 3_600_000)
    expect(texts(events).join("")).toBe("back online")
  })

  test("a host that answers again ends the long wait early", async () => {
    let probes = 0
    const { provider } = scriptedProvider([...Array.from({ length: 8 }, () => network()), stop("ok")], async () => ++probes > 1)
    const waits: number[] = []
    const { engine } = engineWith(provider, { sleep: async (ms) => void waits.push(ms) })
    expect(await engine.runTurn(turn().input)).toEqual({ status: "ok" })
    // The seventh wait (30 s) stops at the second probe, 10 s in; the eighth at the next one, 5 s in.
    expect(waits.reduce((a, b) => a + b, 0)).toBe(500 + 1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 10_000 + 5_000)
  })

  test("cancelling while waiting ends the turn without another request", async () => {
    const controller = new AbortController()
    const { provider, requests } = scriptedProvider([network(), stop("never")])
    const { engine } = engineWith(provider, { sleep: async () => controller.abort() })
    const { input, events } = turn(controller.signal)
    expect((await engine.runTurn(input)).status).not.toBe("error")
    expect(requests).toHaveLength(1)
    expect(texts(events)).toEqual([])
  })

  test("cancelling while waiting after a cut closes the partial answer as cancelled", async () => {
    const controller = new AbortController()
    const { provider, requests } = scriptedProvider([cutAfter("half an answer"), stop("never")])
    const { engine } = engineWith(provider, { sleep: async () => controller.abort() })
    const { input, events } = turn(controller.signal)
    await engine.runTurn(input)
    expect(requests).toHaveLength(1)
    expect(events.filter((e) => e.type === "item.completed")).toEqual([expect.objectContaining({ status: "cancelled", text: "half an answer" })])
  })

  test("a login that fails while reconnecting stops the turn instead of waiting forever", async () => {
    const { provider, requests } = scriptedProvider([network(), network(), new Error("[PROVIDER]: scripted 401 unauthorized"), stop("never")])
    const { engine } = engineWith(provider)
    expect(await engine.runTurn(turn().input)).toMatchObject({ status: "error", code: "provider_error" })
    expect(requests).toHaveLength(3)
  })

  test("a wake from sleep drops a silent stream and continues the answer", async () => {
    let wake: (() => void) | undefined
    const { provider, requests } = scriptedProvider([
      async function* (request) {
        yield { type: "text", delta: "Before the lid closed" } as ModelEvent
        wake!()
        // A dead connection: nothing more arrives until the call's signal aborts.
        if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
      },
      stop(", and after it opened."),
    ])
    const { engine } = engineWith(provider, {
      watchWake: (onWake) => {
        wake = onWake
        return () => {}
      },
    })
    const { input, events } = turn()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(requests).toHaveLength(2)
    expect(texts(events).join("")).toBe("Before the lid closed, and after it opened.")
    expect(events.find((e) => e.type === "retrying")).toMatchObject({ offline: true })
  })

  test("a whole tool call that arrived before the cut runs without asking again", async () => {
    const { provider, requests } = scriptedProvider([
      async function* () {
        yield { type: "tool_call", call: { callId: "c1", name: "missing_tool", args: {} } } as ModelEvent
        throw network()
      },
      stop("done"),
    ])
    const { engine } = engineWith(provider)
    const { input, events } = turn()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", callId: "c1" })
    expect(events.some((e) => e.type === "retrying")).toBe(false)
  })

  test("the retries option still caps attempts", async () => {
    const { provider, requests } = scriptedProvider([network(), network(), network(), stop("late")])
    const { engine } = engineWith(provider, { retries: 2 })
    expect(await engine.runTurn(turn().input)).toMatchObject({ status: "error" })
    expect(requests).toHaveLength(3)
  })
})
