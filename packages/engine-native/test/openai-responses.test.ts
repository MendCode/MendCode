import { describe, expect, jest, test } from "bun:test"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { createNativeEngine, createResponsesProvider, memoryHistory, RetryableProviderError, sseData, toResponsesInput, type ModelEvent, type ModelRequest } from "../src"

function sse(events: unknown[], chunkSize = 7) {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("")
  const bytes = new TextEncoder().encode(text)
  // Small chunks split events and multi-byte characters across reads, like a real network stream.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
}

function provider(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const p = createResponsesProvider({
    id: "openai",
    model: "gpt-test",
    baseUrl: "https://api.example/v1/",
    effort: "low",
    headers: async () => ({ authorization: "Bearer t" }),
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
      return respond(url, init)
    },
  })
  return { p, calls }
}

const request = (): ModelRequest => ({
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  signal: new AbortController().signal,
})

async function collect(stream: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

describe("OpenAI Responses adapter", () => {
  test("discovery uses its wire alias in definitions, retained history and streaming calls", async () => {
    const { p, calls } = provider(() => new Response(sse([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "search-next", name: "mendcode_tool_search", arguments: '{"query":"mcp"}' } },
      { type: "response.completed", response: {} },
    ]), { status: 200 }))
    const input = request()
    input.tools = [{ name: "tool_search", description: "local lookup", parameters: { type: "object" } }]
    input.messages = [
      { role: "assistant", content: "", toolCalls: [{ callId: "search-old", name: "tool_search", args: { query: "capture" } }] },
      { role: "tool", callId: "search-old", name: "tool_search", output: '{"tools":[]}', isError: false, discoveredTools: [] },
    ]
    const events = await collect(p.stream(input))
    expect(calls[0]!.body.tools).toEqual([{ type: "function", name: "mendcode_tool_search", description: "local lookup", parameters: { type: "object" }, strict: false }])
    expect(calls[0]!.body.input).toEqual([
      { type: "function_call", call_id: "search-old", name: "mendcode_tool_search", arguments: '{"query":"capture"}' },
      { type: "function_call_output", call_id: "search-old", output: '{"tools":[]}' },
    ])
    expect(events[0]).toEqual({ type: "tool_call", call: { callId: "search-next", name: "tool_search", args: { query: "mcp" } } })
    expect(input.tools[0]!.name).toBe("tool_search")
    expect(input.messages[0]).toMatchObject({ toolCalls: [{ name: "tool_search" }] })
    // A saved search must stay aliased even after discovery is turned off.
    expect(toResponsesInput(input.messages)[0]!.name).toBe("mendcode_tool_search")
  })

  test("discovery refuses malformed stored arguments and wire-name conflicts before any request", async () => {
    for (const args of [null, "oops", []]) expect(() => toResponsesInput([{ role: "assistant", content: "", toolCalls: [{ callId: "bad", name: "tool_search", args }] }])).toThrow("History was preserved")
    const { p, calls } = provider(() => { throw new Error("must not request") })
    const input = request()
    input.tools = ["tool_search", "mendcode_tool_search"].map((name) => ({ name, description: "lookup", parameters: { type: "object" } }))
    expect(collect(p.stream(input))).rejects.toThrow("wire-name conflict")
    expect(calls).toHaveLength(0)
  })

  test("maps text, reasoning, tool calls and usage from the SSE stream", async () => {
    const { p, calls } = provider(
      () =>
        new Response(
          sse([
            { type: "response.reasoning_summary_text.delta", delta: "look" },
            { type: "response.output_text.delta", delta: "Leyendo ñ " },
            { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
            { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
          ]),
          { status: 200 },
        ),
    )
    const events = await collect(p.stream(request()))
    expect(events).toEqual([
      { type: "reasoning", delta: "look" },
      { type: "text", delta: "Leyendo ñ " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(calls[0]!.url).toBe("https://api.example/v1/responses")
    expect(calls[0]!.headers.authorization).toBe("Bearer t")
    expect(calls[0]!.body).toMatchObject({ model: "gpt-test", instructions: "be brief", stream: true, store: false, reasoning: { effort: "low" } })
    expect(calls[0]!.body.tools).toEqual([{ type: "function", name: "read", description: "read a file", parameters: { type: "object" }, strict: false }])
  })

  test("a function call's arguments stream as tool_input under its call id before the call is whole", async () => {
    const { p } = provider(
      () =>
        new Response(
          sse([
            { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "c1", name: "write", arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"a.ts",' },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"content":"x"}' },
            { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "c1", name: "write", arguments: '{"path":"a.ts","content":"x"}' } },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]),
          { status: 200 },
        ),
    )
    const events = await collect(p.stream(request()))
    expect(events.slice(0, 3)).toEqual([
      { type: "tool_input", callId: "c1", name: "write", delta: '{"path":"a.ts",' },
      { type: "tool_input", callId: "c1", name: "write", delta: '"content":"x"}' },
      { type: "tool_call", call: { callId: "c1", name: "write", args: { path: "a.ts", content: "x" } } },
    ])
  })

  test("history becomes paired function_call / function_call_output items", () => {
    expect(
      toResponsesInput([
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a" } }] },
        { role: "tool", callId: "c1", name: "read", output: "text", isError: false },
        { role: "assistant", content: "done", toolCalls: [] },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "c1", output: "text" },
      { role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ])
  })

  test("user images become input_image data URLs next to the text", () => {
    expect(toResponsesInput([{ role: "user", content: "what is this?", images: [{ mime: "image/png", base64: "AAA=" }] }])).toEqual([
      { role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "input_image", image_url: "data:image/png;base64,AAA=" }] },
    ])
  })

  test("hosted web search is sent as a provider tool and its call is reported with what it searched", async () => {
    const searchItem = { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "bun", queries: ["bun latest", "bun release"] } }
    const { p, calls } = provider(
      () =>
        new Response(
          sse([
            { type: "response.output_item.added", item: { id: "ws_1", type: "web_search_call", status: "in_progress" } },
            { type: "response.web_search_call.searching", item_id: "ws_1" },
            { type: "response.output_item.done", item: searchItem },
            { type: "response.output_item.added", item: { id: "ws_2", type: "web_search_call", status: "in_progress" } },
            { type: "response.output_item.done", item: { id: "ws_2", type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://bun.sh" } } },
            { type: "response.output_text.delta", delta: "v1.4.2 ([bun.sh](https://bun.sh))" },
            { type: "response.completed", response: {} },
          ]),
          { status: 200 },
        ),
    )
    const events = await collect(p.stream({ ...request(), hostedTools: ["web_search"] }))
    expect(calls[0]!.body.tools).toEqual([{ type: "function", name: "read", description: "read a file", parameters: { type: "object" }, strict: false }, { type: "web_search" }])
    expect(events).toEqual([
      { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "started" },
      { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "completed", detail: "bun latest · bun release" },
      { type: "hosted_tool", id: "ws_2", tool: "web_search", status: "started" },
      { type: "hosted_tool", id: "ws_2", tool: "web_search", status: "failed", detail: "https://bun.sh" },
      { type: "text", delta: "v1.4.2 ([bun.sh](https://bun.sh))" },
      { type: "finish", reason: "stop" },
    ])
    const plain = provider(() => new Response(sse([{ type: "response.completed", response: {} }]), { status: 200 }))
    await collect(plain.p.stream(request()))
    expect(plain.calls[0]!.body.tools).toHaveLength(1)
  })

  test("hosted image generation is offered as a provider tool and its finished call carries the image and revised prompt", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64")
    const done = { id: "ig_1", type: "image_generation_call", status: "completed", action: "generate", output_format: "png", size: "1254x1254", result: png, revised_prompt: "A small green square icon" }
    const { p, calls } = provider(
      () =>
        new Response(
          sse([
            { type: "response.output_item.added", item: { id: "ig_1", type: "image_generation_call", status: "in_progress" } },
            { type: "response.image_generation_call.in_progress", item_id: "ig_1" },
            { type: "response.image_generation_call.generating", item_id: "ig_1" },
            { type: "response.image_generation_call.completed", item_id: "ig_1" },
            { type: "response.output_item.done", item: done },
            { type: "response.output_item.added", item: { id: "ig_2", type: "image_generation_call", status: "in_progress" } },
            { type: "response.output_item.done", item: { id: "ig_2", type: "image_generation_call", status: "failed" } },
            { type: "response.output_item.added", item: { id: "ig_3", type: "image_generation_call", status: "in_progress" } },
            { type: "response.output_item.done", item: { id: "ig_3", type: "image_generation_call", status: "completed", output_format: "webp", result: "QUJD" } },
            { type: "response.output_text.delta", delta: "Here it is." },
            { type: "response.completed", response: {} },
          ]),
          { status: 200 },
        ),
    )
    const events = await collect(p.stream({ ...request(), hostedTools: ["web_search", "image_generation"] }))
    expect(calls[0]!.body.tools).toEqual([
      { type: "function", name: "read", description: "read a file", parameters: { type: "object" }, strict: false },
      { type: "web_search" },
      { type: "image_generation" },
    ])
    expect(events).toEqual([
      { type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "started" },
      { type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "completed", detail: "A small green square icon", image: { mime: "image/png", base64: png } },
      { type: "hosted_tool", id: "ig_2", tool: "image_generation", status: "started" },
      { type: "hosted_tool", id: "ig_2", tool: "image_generation", status: "failed" },
      { type: "hosted_tool", id: "ig_3", tool: "image_generation", status: "started" },
      { type: "hosted_tool", id: "ig_3", tool: "image_generation", status: "completed", image: { mime: "image/webp", base64: "QUJD" } },
      { type: "text", delta: "Here it is." },
      { type: "finish", reason: "stop" },
    ])
  })

  test("a request that never answers, or a stream that goes silent, is abandoned as a retryable stall", async () => {
    const stallingProvider = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
      createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), idleTimeoutMs: 30, fetch })
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
    const noAnswer = await collect(stallingProvider((_, init) => hang(init)).stream(request())).catch((e) => e)
    expect(noAnswer).toBeInstanceOf(RetryableProviderError)
    expect(String(noAnswer.message)).toContain("stream stalled")
    // A host known to answer at once gets a shorter limit for the headers alone; the stream keeps the idle limit.
    const quick = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
      createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), idleTimeoutMs: 5_000, headerTimeoutMs: 30, fetch })
    const startedAt = Date.now()
    const unanswered = await collect(quick((_, init) => hang(init)).stream(request())).catch((e) => e)
    expect(unanswered).toBeInstanceOf(RetryableProviderError)
    expect(String(unanswered.message)).toContain("did not answer the request")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    const slow = new ReadableStream<Uint8Array>({ start: (c) => void setTimeout(() => { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "late" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`)); c.close() }, 120) })
    expect((await collect(quick(async () => new Response(slow, { status: 200 })).stream(request()))).some((event) => event.type === "text" && event.delta === "late")).toBe(true)
    // One event, then silence: what already streamed is kept and the stall still surfaces.
    const silent = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`)) })
    const seen: ModelEvent[] = []
    const quiet = await (async () => {
      for await (const event of stallingProvider(async () => new Response(silent, { status: 200 })).stream(request())) seen.push(event)
    })().catch((e) => e)
    expect(seen).toEqual([{ type: "text", delta: "hi" }])
    expect(quiet).toBeInstanceOf(RetryableProviderError)
    expect(String(quiet.message)).toContain("stream stalled")
  })

  describe("deadlines of a host that answers at once (virtual clock)", () => {
    // The values the daemon gives the ChatGPT subscription provider (packages/daemon/src/main.ts).
    const HEADER_MS = 10_000, FIRST_EVENT_MS = 20_000, IDLE_MS = 120_000
    const encode = (text: string) => new TextEncoder().encode(text)
    const data = (event: unknown) => encode(`data: ${JSON.stringify(event)}\n\n`)
    const answer = [{ type: "response.created", response: {} }, { type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: {} }]
    /** Lets everything that is ready run without moving the virtual clock. */
    const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve() }
    const advance = async (ms: number) => { await settle(); jest.advanceTimersByTime(ms); await settle() }
    /** A fetch whose n-th request is answered by `respond[n]` (the last one repeats); `"hang"` never answers and rejects when its signal aborts. */
    function backend(respond: Array<"hang" | (() => Response)>) {
      const signals: AbortSignal[] = []
      /** For each request after the first: whether the previous request was already aborted when this one was sent. */
      const previousAborted: boolean[] = []
      const fetch = (_url: string, init: RequestInit) => {
        if (signals.length) previousAborted.push(signals.at(-1)!.aborted)
        signals.push(init.signal!)
        const step = respond[Math.min(signals.length - 1, respond.length - 1)]!
        if (step !== "hang") return Promise.resolve(step())
        return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      }
      return { fetch, signals, previousAborted }
    }
    const chatgpt = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
      createResponsesProvider({ id: "chatgpt", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), headerTimeoutMs: HEADER_MS, firstEventTimeoutMs: FIRST_EVENT_MS, fetch })
    /** Runs `stream` to its end and keeps what it yielded and how it ended. */
    function run(stream: AsyncIterable<ModelEvent>) {
      const state: { events: ModelEvent[]; done: boolean; error?: unknown } = { events: [], done: false }
      void (async () => { for await (const event of stream) state.events.push(event) })().catch((error: unknown) => void (state.error = error)).finally(() => void (state.done = true))
      return state
    }
    /** A body the test feeds by hand; `cancelled` tells whether the reader closed it. */
    function body() {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const state = { cancelled: false }
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c), cancel: () => void (state.cancelled = true) })
      return { stream, state, send: (bytes: Uint8Array) => controller.enqueue(bytes), close: () => controller.close() }
    }
    function engineTurn(fetch: (url: string, init: RequestInit) => Promise<Response>, extra: { retries?: number; signal?: AbortSignal } = {}) {
      const ids = createIdFactory()
      const waits: number[] = []
      const events: EngineEvent[] = []
      const engine = createNativeEngine({ provider: chatgpt(fetch), tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", sleep: async (ms) => void waits.push(ms), watchWake: () => () => {}, ...(extra.retries !== undefined ? { retries: extra.retries } : {}) })
      const input: TurnInput = { permissionMode: () => "ask", setPermissionMode: () => {}, sessionId: ids("session"), turnId: ids("turn"), text: "go", attachments: [], signal: extra.signal ?? new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }) }
      const state: { outcome?: Awaited<ReturnType<typeof engine.runTurn>> } = {}
      void engine.runTurn(input).then((outcome) => void (state.outcome = outcome))
      const retrying = () => events.filter((event): event is Extract<EngineEvent, { type: "retrying" }> => event.type === "retrying")
      return { state, waits, events, retrying }
    }
    const virtual = (name: string, body: () => Promise<void>) => test(name, async () => {
      jest.useFakeTimers()
      try { await body() } finally { jest.useRealTimers() }
    })

    virtual("a request with no response headers is abandoned at 10 s, closed, and marked for an immediate retry", async () => {
      const { fetch, signals } = backend(["hang"])
      const call = run(chatgpt(fetch).stream(request()))
      await advance(HEADER_MS - 1)
      expect(call.done).toBe(false)
      expect(signals[0]!.aborted).toBe(false)
      await advance(1)
      expect(call.error).toBeInstanceOf(RetryableProviderError)
      expect(call.error).toMatchObject({ message: "[PROVIDER]: chatgpt did not answer the request in 10s, stream stalled", kind: "network", immediate: true })
      expect(signals[0]!.aborted).toBe(true)
    })

    virtual("a request that keeps running out of the header deadline gets twice as long each time, so one the host answers slowly ends instead of looping", async () => {
      const { fetch, signals } = backend(["hang"])
      const provider = chatgpt(fetch)
      const first = run(provider.stream(request()))
      await advance(HEADER_MS)
      expect(first.error).toMatchObject({ message: "[PROVIDER]: chatgpt did not answer the request in 10s, stream stalled" })
      // The same conversation again: the first deadline passes without a retry, the doubled one ends it.
      const second = run(provider.stream(request()))
      await advance(HEADER_MS)
      expect(second.done).toBe(false)
      expect(signals[1]!.aborted).toBe(false)
      await advance(HEADER_MS)
      expect(second.error).toMatchObject({ message: "[PROVIDER]: chatgpt did not answer the request in 20s, stream stalled", kind: "network", immediate: true })
      const third = run(provider.stream(request()))
      await advance(HEADER_MS * 4 - 1)
      expect(third.done).toBe(false)
      await advance(1)
      expect(third.error).toMatchObject({ message: "[PROVIDER]: chatgpt did not answer the request in 40s, stream stalled" })
    })

    virtual("headers and then not one byte: abandoned at 20 s after the headers, closed, and marked for an immediate retry", async () => {
      const first = body()
      const { fetch, signals } = backend([() => new Response(first.stream, { status: 200 })])
      const call = run(chatgpt(fetch).stream(request()))
      await advance(FIRST_EVENT_MS - 1)
      expect(call.done).toBe(false)
      await advance(1)
      expect(call.error).toMatchObject({ message: "[PROVIDER]: chatgpt sent no event in 20s after answering, stream stalled", kind: "network", immediate: true })
      expect(signals[0]!.aborted).toBe(true)
      expect(first.state.cancelled).toBe(true)
    })

    virtual("the first event deadline is about any event, not text: after `response.created` only the 120 s idle limit applies", async () => {
      const first = body()
      const { fetch } = backend([() => new Response(first.stream, { status: 200 })])
      const call = run(chatgpt(fetch).stream(request()))
      await advance(FIRST_EVENT_MS - 1)
      first.send(data({ type: "response.created", response: {} }))
      await advance(IDLE_MS - 1)
      expect(call.done).toBe(false)
      await advance(1)
      // The idle limit is the old cause: it keeps its message and its backoff.
      expect(call.error).toMatchObject({ message: "[PROVIDER]: chatgpt no data for 120s, stream stalled", kind: "network", immediate: false })
      expect(call.events).toEqual([])
    })

    virtual("a reasoning stream that sends an event every 60 s for 5 minutes is not cut", async () => {
      const slow = body()
      const { fetch, signals } = backend([() => new Response(slow.stream, { status: 200 })])
      const call = run(chatgpt(fetch).stream(request()))
      await advance(1_200)
      slow.send(data({ type: "response.created", response: {} }))
      // What a thinking model sends: progress events the caller never sees, and SSE comments as keep-alives.
      for (let minute = 1; minute <= 5; minute++) {
        await advance(60_000)
        slow.send(minute % 2 ? data({ type: "response.in_progress", response: {} }) : encode(": keep-alive\n\n"))
        expect(call.done).toBe(false)
      }
      await advance(60_000)
      slow.send(data({ type: "response.output_text.delta", delta: "42" }))
      slow.send(data({ type: "response.completed", response: {} }))
      await advance(0)
      expect(call.error).toBeUndefined()
      expect(call.events).toEqual([{ type: "text", delta: "42" }, { type: "finish", reason: "stop" }])
      expect(signals[0]!.aborted).toBe(false)
    })

    virtual("a provider without these options keeps one limit for all three waits and its retry keeps the backoff", async () => {
      const plain = (fetch: (url: string, init: RequestInit) => Promise<Response>) => createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), fetch })
      const unanswered = run(plain(backend(["hang"]).fetch).stream(request()))
      await advance(IDLE_MS - 1)
      expect(unanswered.done).toBe(false)
      await advance(1)
      expect(unanswered.error).toMatchObject({ message: "[PROVIDER]: openai no data for 120s, stream stalled", immediate: false })
      const silent = run(plain(backend([() => new Response(body().stream, { status: 200 })]).fetch).stream(request()))
      await advance(IDLE_MS - 1)
      expect(silent.done).toBe(false)
      await advance(1)
      expect(silent.error).toMatchObject({ message: "[PROVIDER]: openai no data for 120s, stream stalled", immediate: false })
    })

    virtual("the engine retries a deadline at once, on a new request sent after the first one was closed", async () => {
      const { fetch, signals, previousAborted } = backend(["hang", () => new Response(sse(answer), { status: 200 })])
      const turn = engineTurn(fetch)
      await advance(HEADER_MS - 1)
      expect(signals).toHaveLength(1)
      await advance(1)
      // No clock time passes between the deadline and the answer of the second request.
      expect(turn.state.outcome).toEqual({ status: "ok" })
      expect(turn.waits).toEqual([])
      expect(turn.retrying()).toEqual([{ type: "retrying", attempt: 1, delayMs: 0, message: "chatgpt did not answer the request in 10s, stream stalled" }])
      expect(previousAborted).toEqual([true])
      expect(turn.events.filter((event) => event.type === "item.delta")).toEqual([expect.objectContaining({ text: "done" })])
    })

    virtual("the first event deadline is retried at once too, and only one stream feeds the turn", async () => {
      const first = body()
      const { fetch, previousAborted } = backend([() => new Response(first.stream, { status: 200 }), () => new Response(sse(answer), { status: 200 })])
      const turn = engineTurn(fetch)
      await advance(FIRST_EVENT_MS)
      expect(turn.state.outcome).toEqual({ status: "ok" })
      expect(turn.waits).toEqual([])
      expect(turn.retrying().map((event) => [event.delayMs, event.message])).toEqual([[0, "chatgpt sent no event in 20s after answering, stream stalled"]])
      expect(previousAborted).toEqual([true])
      expect(first.state.cancelled).toBe(true)
      // Text the abandoned request sends late has nowhere to go.
      expect(() => first.send(data({ type: "response.output_text.delta", delta: "late" }))).toThrow()
      expect(turn.events.filter((event) => event.type === "item.delta")).toEqual([expect.objectContaining({ text: "done" })])
    })

    virtual("only the first retry skips the wait, and the retry cap still ends the call", async () => {
      const { fetch, signals } = backend(["hang"])
      const turn = engineTurn(fetch, { retries: 2 })
      // Each request of the conversation gets twice the deadline of the one before: 10 s, 20 s, 40 s.
      for (const factor of [1, 2, 4]) await advance(HEADER_MS * factor)
      expect(signals).toHaveLength(3)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(turn.retrying().map((event) => [event.attempt, event.delayMs])).toEqual([[1, 0], [2, 1_000]])
      expect(turn.waits).toEqual([1_000])
      expect(turn.state.outcome).toMatchObject({ status: "error" })
      await advance(HEADER_MS * 3)
      expect(signals).toHaveLength(3)
    })

    virtual("a cancel while the request waits ends the turn: no retry, no second request", async () => {
      const user = new AbortController()
      const { fetch, signals } = backend(["hang"])
      const turn = engineTurn(fetch, { signal: user.signal })
      await advance(HEADER_MS / 2)
      user.abort()
      await advance(0)
      // The engine ends a cancelled turn without an error; the session marks it cancelled from the signal.
      expect(turn.state.outcome).toEqual({ status: "ok" })
      await advance(HEADER_MS * 3)
      expect(signals).toHaveLength(1)
      expect(signals[0]!.aborted).toBe(true)
      expect(turn.retrying()).toEqual([])
    })

    virtual("a cancel that lands with the deadline wins over the retry", async () => {
      const user = new AbortController()
      const { fetch, signals } = backend(["hang"])
      // The user's cancel is queued for the same instant as the deadline, after it.
      const provider = chatgpt((url, init) => (setTimeout(() => user.abort(), HEADER_MS), fetch(url, init)))
      const call = run(provider.stream({ ...request(), signal: user.signal }))
      const turn = engineTurn((url, init) => (setTimeout(() => user.abort(), HEADER_MS), fetch(url, init)), { signal: user.signal })
      await advance(HEADER_MS * 3)
      // One request each, both closed; the provider reports no stall and the engine announces no retry.
      expect(signals).toHaveLength(2)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(call).toMatchObject({ done: true, events: [] })
      expect(call.error).toBeUndefined()
      expect(turn.state.outcome).toEqual({ status: "ok" })
      expect(turn.retrying()).toEqual([])
    })

  })

  test("tool call arguments that loop on the same text end the stream as a retryable failure", async () => {
    const looping = (delta: string, count: number) => [
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1" } },
      ...Array.from({ length: count }, () => ({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta })),
      { type: "response.completed", response: {} },
    ]
    for (const delta of ["\n", "{}", " \t"]) {
      const { p } = provider(() => new Response(sse(looping(delta, 6_000), 4_096), { status: 200 }))
      const error = await collect(p.stream(request())).catch((e) => e)
      expect(error).toBeInstanceOf(RetryableProviderError)
      expect(String(error.message)).toContain("tool call arguments keep repeating")
    }
    // Long but varied arguments (a big file write) are fine.
    const varied = Array.from({ length: 3_000 }, (_, i) => ({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: `line ${i}\\n` }))
    const done = { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "write", arguments: "{}" } }
    const { p } = provider(() => new Response(sse([...varied, done, { type: "response.completed", response: {} }], 4_096), { status: 200 }))
    expect((await collect(p.stream(request()))).map((e) => e.type)).toEqual(["tool_call", "finish"])
  })

  test("a stream that keeps sending events the caller never sees is abandoned", async () => {
    const noise = Array.from({ length: 200 }, () => ({ type: "response.unknown_progress", padding: "x".repeat(100) }))
    const p = createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), maxSilentStreamBytes: 4_096, fetch: async () => new Response(sse([{ type: "response.output_text.delta", delta: "hi" }, ...noise], 512), { status: 200 }) })
    const seen: ModelEvent[] = []
    const error = await (async () => {
      for await (const event of p.stream(request())) seen.push(event)
    })().catch((e) => e)
    expect(seen).toEqual([{ type: "text", delta: "hi" }])
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(String(error.message)).toContain("without output")
  })

  test("a user cancel is not reported as a stall", async () => {
    const controller = new AbortController()
    const p = createResponsesProvider({
      id: "openai",
      model: "gpt-test",
      baseUrl: "https://api.example/v1",
      headers: async () => ({}),
      idleTimeoutMs: 1_000,
      fetch: (_, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    })
    setTimeout(() => controller.abort(), 10)
    expect(await collect(p.stream({ ...request(), signal: controller.signal }))).toEqual([])
  })

  test("a per-call model replaces the adapter's model and effort; without an effort the model's default applies", async () => {
    const done = () => new Response(sse([{ type: "response.completed", response: {} }]), { status: 200 })
    const { p, calls } = provider(done)
    await collect(p.stream({ ...request(), model: "gpt-6-sol", effort: "xhigh" }))
    await collect(p.stream({ ...request(), model: "gpt-6-sol" }))
    await collect(p.stream(request()))
    expect(calls.map((c) => [c.body.model, c.body.reasoning])).toEqual([
      ["gpt-6-sol", { effort: "xhigh", summary: "auto" }],
      ["gpt-6-sol", undefined],
      ["gpt-test", { effort: "low", summary: "auto" }],
    ])
  })

  test("a cache key is sent as prompt_cache_key and the session_id header; without one both are left out", async () => {
    const done = () => new Response(sse([{ type: "response.completed", response: {} }]), { status: 200 })
    const { p, calls } = provider(done)
    await collect(p.stream({ ...request(), cacheKey: "ses_1" }))
    await collect(p.stream(request()))
    expect(calls.map((c) => [c.body.prompt_cache_key, c.headers.session_id])).toEqual([
      ["ses_1", "ses_1"],
      [undefined, undefined],
    ])
    expect("prompt_cache_key" in calls[1]!.body).toBe(false)
    expect(calls[0]!.headers.authorization).toBe("Bearer t")
  })

  test("429 and 5xx are retryable with Retry-After; 4xx is a hard error", async () => {
    const limited = provider(() => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
    const error = await collect(limited.p.stream(request())).catch((e) => e)
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(error.retryAfterMs).toBe(2_000)
    const bad = provider(() => new Response("bad key", { status: 401 }))
    const hard = await collect(bad.p.stream(request())).catch((e) => e)
    expect(hard).not.toBeInstanceOf(RetryableProviderError)
    expect(String(hard.message)).toContain("401 bad key")
  })

  test("a stream that ends without response.completed is retryable; response.incomplete finishes as length", async () => {
    const cut = provider(() => new Response(sse([{ type: "response.output_text.delta", delta: "x" }]), { status: 200 }))
    expect(await collect(cut.p.stream(request())).catch((e) => e)).toBeInstanceOf(RetryableProviderError)
    const long = provider(() => new Response(sse([{ type: "response.incomplete", response: {} }]), { status: 200 }))
    expect(await collect(long.p.stream(request()))).toEqual([{ type: "finish", reason: "length" }])
  })

  test("a connection that drops mid-answer is a retryable network failure, after the text that arrived", async () => {
    const first = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "half" })}\n\n`)
    const dropped = provider(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first)
            },
            pull(controller) {
              controller.error(Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }))
            },
          }),
          { status: 200 },
        ),
    )
    const seen: ModelEvent[] = []
    const error = await (async () => {
      for await (const event of dropped.p.stream(request())) seen.push(event)
    })().catch((e) => e)
    expect(seen).toEqual([{ type: "text", delta: "half" }])
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(error.kind).toBe("network")
  })

  test("a refused connection waits for the network; a certificate failure does not", async () => {
    const refused = provider(() => {
      throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })
    })
    const offline = await collect(refused.p.stream(request())).catch((e) => e)
    expect(offline).toBeInstanceOf(RetryableProviderError)
    expect(offline.kind).toBe("network")
    const tls = provider(() => {
      throw Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })
    })
    expect(await collect(tls.p.stream(request())).catch((e) => e)).not.toBeInstanceOf(RetryableProviderError)
  })

  test("a usage-limit 429 stops the turn; 408 and a plain 429 are retried", async () => {
    const quota = provider(() => new Response('{"error":{"type":"usage_limit_reached","message":"You have hit your usage limit"}}', { status: 429 }))
    expect(await collect(quota.p.stream(request())).catch((e) => e)).not.toBeInstanceOf(RetryableProviderError)
    const timeout = provider(() => new Response("timeout", { status: 408 }))
    const error = await collect(timeout.p.stream(request())).catch((e) => e)
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(error.kind).toBe("transient")
  })

  test("a missing login is not retried", async () => {
    const p = createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => Promise.reject(new Error("[AUTH]: run codex login")), fetch: async () => new Response("") })
    const error = await collect(p.stream(request())).catch((e) => e)
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect(String(error.message)).toContain("[AUTH]")
  })

  test("the probe asks the responses endpoint with HEAD and counts any answer as online", async () => {
    const heads: Array<{ url: string; method: string | undefined }> = []
    const up = createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1/", headers: async () => ({}), fetch: async (url, init) => (heads.push({ url, method: init.method }), new Response("", { status: 405 })) })
    expect(await up.probe!()).toBe(true)
    expect(heads).toEqual([{ url: "https://api.example/v1/responses", method: "HEAD" }])
    const down = createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1", headers: async () => ({}), fetch: async () => Promise.reject(new Error("offline")) })
    expect(await down.probe!()).toBe(false)
  })
})

describe("sseData", () => {
  const read = async (chunks: string[]) => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close() } })
    const out: string[] = []
    for await (const data of sseData(body, new AbortController().signal)) out.push(data)
    return out
  }

  test("ends events at a blank LF or CRLF line wherever the reads split them; joins data lines; drops an unfinished event", async () => {
    const text = "event: a\ndata: 1\n\n: comment\r\ndata: 2\r\ndata:3\r\n\r\n\n\ndata: \n\ndata: é😀\n\ndata: tail"
    const expected = ["1", "2\n3", "é😀"]
    expect(await read([text])).toEqual(expected)
    for (let size = 1; size <= 7; size++) expect(await read(text.match(new RegExp(`[^]{1,${size}}`, "gu"))!)).toEqual(expected)
  })

  test("an event that keeps growing without ending is abandoned at the limit; ended events below it pass", async () => {
    const encoder = new TextEncoder()
    const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close() } })
    const out: string[] = []
    for await (const data of sseData(stream(["data: ok\n\n", ...Array.from({ length: 4 }, () => "data: x\n\ndata: y\n\n")]), new AbortController().signal, undefined, 64)) out.push(data)
    expect(out).toHaveLength(9)
    const endless = sseData(stream(["data: start", ...Array.from({ length: 10 }, () => "x".repeat(20))]), new AbortController().signal, undefined, 64)
    await expect((async () => { for await (const _ of endless) {} })()).rejects.toThrow("one stream event passed 64 bytes without ending")
  })

  test("a large event read in many small chunks comes out whole", async () => {
    const event = JSON.stringify({ type: "response.output_item.done", item: { arguments: "x".repeat(300_000) } })
    const text = `data: ${event}\r\n\r\ndata: [DONE]\n\n`
    expect(await read(text.match(/[^]{1,4096}/g)!)).toEqual([event, "[DONE]"])
  })
})

describe("a host with refused fields and no native compaction (Sign in with ChatGPT on api.openai.com)", () => {
  test("refused fields are removed after the model's parameters; nativeCompaction false offers no compact binding", async () => {
    const calls: Record<string, unknown>[] = []
    const p = createResponsesProvider({
      id: "chatgpt", model: "gpt-test", baseUrl: "https://api.openai.com/v1", effort: "low",
      headers: async () => ({ authorization: "Bearer t" }),
      nativeCompaction: false, routingHeader: false, unsupportedFields: ["max_output_tokens", "temperature", "service_tier", "prompt_cache_retention"],
      fetch: async (_url, init) => { calls.push(JSON.parse(String(init.body))); return new Response(sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }])) },
    })
    await collect(p.stream({ ...request(), maxOutputTokens: 100, fast: true, parameters: { temperature: 0.2, prompt_cache_retention: "24h" } } as ModelRequest))
    for (const field of ["max_output_tokens", "temperature", "service_tier", "prompt_cache_retention"]) expect(calls[0]).not.toHaveProperty(field)
    expect(calls[0]).toMatchObject({ store: false, stream: true, instructions: "be brief" })
    expect(await p.nativeBinding?.("gpt-test")).toBeUndefined()
  })
})
