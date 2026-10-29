import { describe, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, createResponsesProvider, memoryHistory, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest, type ToolSpec } from "../src"
import type { CacheBinding } from "../src/cache-policy"
import { searchLoads } from "../src/openai-responses"
import { TOOL_SEARCH_WIRE_NAME, withoutDiscovered } from "../src/tool-discovery"
import { fakeServer, sse } from "./fake-server"
import { callTool, scriptedProvider, stop, turn } from "./harness"
import { comparePrefix, fileTool, recordLineage } from "./prefix-harness"

const binding: CacheBinding = { provider: "openai", model: "test", endpoint: "https://api.openai.com/v1", auth: "api", transport: "responses", account: "opaque-account" }
const fakeTool = (name: string) => defineTool({ name, description: `tool ${name}`, permission: "read", args: z.object({}), execute: async () => ({ output: `${name} ran`, title: name, isError: false, truncated: false }) })

describe("smart cache key and tool discovery", () => {
  test("finding a tool with tool_search appends to the list and leaves the cache key alone", async () => {
    const { provider, requests } = scriptedProvider([callTool("tool_search", { query: "notebook" }), stop("done")])
    const engine = createNativeEngine({
      provider: { ...provider, id: "openai", model: "test", cacheBinding: async () => binding },
      history: memoryHistory(), tools: ["read", "shell", "edit", "notebook_edit"].map(fakeTool), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize",
      permissionPolicy: () => ({ tier: "balanced" }) as Settings, cacheConfig: () => ({ mode: "smart" }),
    })
    await engine.runTurn(turn({ text: "go" }).input)
    const names = (index: number) => requests[index]!.tools.map((tool) => tool.name)
    expect(names(0)).not.toContain("notebook_edit")
    expect(names(1)).toContain("notebook_edit")
    expect(names(1).slice(0, names(0).length)).toEqual(names(0))
    expect(requests[0]!.cacheKey).toMatch(/^mc:/)
    expect(requests[1]!.cacheKey).toBe(requests[0]!.cacheKey)
  })

  for (const promptCache of ["legacy", "smart"] as const) {
    test(`Responses (${promptCache}): a found tool changes nothing but the end of the tool list, and that is where the provider's prefix ends`, async () => {
      const calls = await recordLineage({
        adapter: "responses", promptCache,
        tools: [fileTool("read"), fileTool("grep"), fileTool("notebook_edit")],
        engineOptions: { permissionPolicy: () => ({ tier: "balanced" }) as Settings },
        turns: [{ text: "Edit the notebook", steps: [
          { calls: [{ name: "read", args: { path: "a.ipynb" } }] },
          { calls: [{ name: TOOL_SEARCH_WIRE_NAME, args: { query: "notebook" } }] },
          { calls: [{ name: "notebook_edit", args: { path: "a.ipynb" } }] },
          { text: "Done." },
        ] }],
      })
      expect(calls).toHaveLength(4)
      const [, before, after, later] = calls.map((call) => call.body)
      const names = (body: Record<string, any>) => (body.tools as Array<{ name: string }>).map((tool) => tool.name)
      expect(names(before!).at(-1)).toBe(TOOL_SEARCH_WIRE_NAME)
      expect(names(before!)).not.toContain("notebook_edit")
      expect(names(after!)).toEqual([...names(before!), "notebook_edit"])
      // What stays byte for byte: the route (body key and header), the instructions, every tool listed before and the whole earlier input.
      for (const call of calls) expect([call.body.prompt_cache_key, call.headers.session_id]).toEqual([calls[0]!.body.prompt_cache_key, calls[0]!.headers.session_id])
      expect(calls[0]!.body.prompt_cache_key).toBeTruthy()
      expect(after!.instructions).toBe(before!.instructions)
      expect(JSON.stringify(after!.tools.slice(0, before!.tools.length))).toBe(JSON.stringify(before!.tools))
      expect(JSON.stringify(after!.input.slice(0, before!.input.length))).toBe(JSON.stringify(before!.input))
      // What does not: the tool list is serialised before the instructions and the conversation, so the request before the find is not a
      // prefix of the request after it. The provider re-reads everything after the tool list once.
      expect(comparePrefix("responses", before!, after!)).toMatchObject({ firstDifference: "tools" })
      expect(comparePrefix("responses", before!, after!).share).toBeLessThan(1)
      // Once: the list does not change again, so the next request repeats the whole one before it.
      expect(comparePrefix("responses", after!, later!)).toMatchObject({ share: 1, firstDifference: "none" })
    })
  }

  test("withoutDiscovered cuts after tool_search for specs and provider bodies and leaves other lists whole", () => {
    expect(withoutDiscovered([{ name: "read" }, { name: "tool_search" }, { name: "notebook_edit" }])).toEqual([{ name: "read" }, { name: "tool_search" }])
    expect(withoutDiscovered([{ type: "function", function: { name: "read" } }, { type: "function", function: { name: "tool_search" } }, { type: "function", function: { name: "x" } }])).toHaveLength(2)
    expect(withoutDiscovered([{ name: "read" }, { name: "edit" }])).toHaveLength(2)
    // A Responses body names the search by its wire name, or lists it as the API's own tool without a name.
    expect(withoutDiscovered([{ type: "function", name: "read" }, { type: "function", name: TOOL_SEARCH_WIRE_NAME }, { type: "function", name: "x" }])).toHaveLength(2)
    expect(withoutDiscovered([{ type: "function", name: "read" }, { type: "tool_search", execution: "client" }, { type: "function", name: "x" }])).toHaveLength(2)
  })
})

describe("client-executed tool search (Responses, the ChatGPT backend's shape)", () => {
  const spec = (name: string): ToolSpec => ({ name, description: `tool ${name}`, parameters: { type: "object", properties: {} } })
  const wire = (name: string) => ({ type: "function", name, description: `tool ${name}`, parameters: { type: "object", properties: {} }, strict: false })
  const searchEntry = { type: "tool_search", execution: "client", description: "tool tool_search", parameters: { type: "object", properties: {} } }
  const found: ModelMessage[] = [
    { role: "user", content: "Edit the notebook" },
    { role: "assistant", content: "", toolCalls: [{ callId: "s1", name: "tool_search", args: { query: "notebook" } }] },
    { role: "tool", callId: "s1", name: "tool_search", output: '{"tools":[]}', isError: false, discoveredTools: ["read", "notebook_edit"] },
  ]
  const completed = () => sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }])
  const refused = () => new Response('{"detail":"Unsupported tool type: tool_search"}', { status: 400 })
  const run = async (provider: ModelProvider, request: Partial<ModelRequest> = {}) => {
    const events: ModelEvent[] = []
    for await (const event of provider.stream({ system: "sys", messages: found, tools: [spec("read"), spec("tool_search"), spec("notebook_edit")], conversationId: "ses_a", signal: new AbortController().signal, ...request })) events.push(event)
    return events
  }
  const hosted = (handler: Parameters<typeof fakeServer>[0], clientToolSearch = true) => {
    const server = fakeServer(handler)
    return { server, provider: createResponsesProvider({ id: "chatgpt", model: "gpt-test", baseUrl: `${server.url}/v1`, headers: async () => ({ authorization: "Bearer t" }), clientToolSearch }) }
  }

  test("a found tool is defined in the search result at the tail of the input; the tool list keeps its bytes through the find and after it", async () => {
    const calls = await recordLineage({
      adapter: "responses", promptCache: "legacy", clientToolSearch: true,
      tools: [fileTool("read"), fileTool("grep"), fileTool("notebook_edit")],
      engineOptions: { permissionPolicy: () => ({ tier: "balanced" }) as Settings },
      turns: [{ text: "Edit the notebook", steps: [
        { calls: [{ name: "read", args: { path: "a.ipynb" } }] },
        { calls: [{ name: "tool_search", args: { query: "notebook" } }] },
        { calls: [{ name: "notebook_edit", args: { path: "a.ipynb" } }] },
        { text: "Done." },
      ] }],
    })
    expect(calls).toHaveLength(4)
    const [first, before, after, later] = calls.map((call) => call.body)
    // The pinned bytes: one list for every call of the session, with the search as the API's own tool and no found tool in it.
    for (const body of [before!, after!, later!]) expect(JSON.stringify(body.tools)).toBe(JSON.stringify(first!.tools))
    expect(first!.tools.at(-1)).toMatchObject({ type: "tool_search", execution: "client" })
    expect(first!.tools.map((tool: { name?: string }) => tool.name)).not.toContain("notebook_edit")
    // The search and its result are the API's own items; the result is the definition, loaded where the conversation already was.
    const [search, result] = after!.input.slice(before!.input.length)
    expect(search).toEqual({ type: "tool_search_call", call_id: "call_1_0", execution: "client", arguments: { query: "notebook" }, status: "completed" })
    expect(result).toMatchObject({ type: "tool_search_output", call_id: "call_1_0", status: "completed", execution: "client" })
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]).toMatchObject({ type: "function", name: "notebook_edit", strict: false, defer_loading: true })
    expect(result.tools[0].parameters).toBeTruthy()
    // Every request starts with the whole one before it: nothing is read uncached because of the find.
    expect(comparePrefix("responses", before!, after!)).toMatchObject({ share: 1, firstDifference: "none" })
    expect(comparePrefix("responses", after!, later!)).toMatchObject({ share: 1, firstDifference: "none" })
    // The found tool ran: its real output is in the next request.
    expect(later!.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_2_0" })
    expect(later!.input.at(-1).output).toStartWith("notebook_edit a.ipynb")
  })

  test("searchLoads defines a found tool once, in the last search that names it (a repeated search is never answered empty), and keeps listed what no search result carries", () => {
    const tools = [spec("read"), spec("tool_search"), spec("from_code"), spec("notebook_edit"), spec("lsp")]
    const messages: ModelMessage[] = [
      ...found,
      { role: "tool", callId: "s2", name: "tool_search", output: "", isError: false, discoveredTools: ["notebook_edit", "lsp", "gone"] },
      { role: "tool", callId: "s3", name: "tool_search", output: "boom", isError: true, discoveredTools: ["from_code"] },
      { role: "tool", callId: "c1", name: "code", output: "", isError: false, discoveredTools: ["from_code"] },
    ]
    const { loads, listed } = searchLoads(tools, messages)
    // `read` is always listed and `gone` is no longer in the catalogue: neither is defined again.
    expect([...loads].map(([callId, specs]) => [callId, specs.map((tool) => tool.name)])).toEqual([["s1", []], ["s2", ["notebook_edit", "lsp"]], ["s3", []]])
    expect(listed.map((tool) => tool.name)).toEqual(["read", "tool_search", "from_code"])
    expect(searchLoads([spec("read"), spec("edit")], messages).listed).toHaveLength(2)
  })

  test("the request: search entry, no found tool in the list, and a model's tool_search_call becomes a tool_search call for the host", async () => {
    const { server, provider } = hosted(() => sse([
      { type: "response.output_item.done", item: { type: "tool_search_call", id: "tsc_1", call_id: "s9", execution: "client", arguments: { query: "lsp", limit: 1 }, status: "completed" } },
      { type: "response.output_item.done", item: { type: "tool_search_call", id: "tsc_2", call_id: "hosted", execution: "server", arguments: {}, status: "completed" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]))
    try {
      const events = await run(provider)
      expect(server.requests[0]!.body.tools).toEqual([wire("read"), searchEntry])
      expect(server.requests[0]!.body.input.slice(1)).toEqual([
        { type: "tool_search_call", call_id: "s1", execution: "client", arguments: { query: "notebook" }, status: "completed" },
        { type: "tool_search_output", call_id: "s1", status: "completed", execution: "client", tools: [{ ...wire("notebook_edit"), defer_loading: true }] },
      ])
      expect(events.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", call: { callId: "s9", name: "tool_search", args: { query: "lsp", limit: 1 } } }])
      expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    } finally { server.stop() }
  })

  test("a backend that refuses the shape gets the same call with the plain function, once, and the session stays on it", async () => {
    const { server, provider } = hosted((request) => request.body.tools.some((tool: { type: string }) => tool.type === "tool_search") ? refused() : completed())
    try {
      expect((await run(provider)).at(-1)).toEqual({ type: "finish", reason: "stop" })
      expect(server.requests).toHaveLength(2)
      // Today's shape, whole: the function under its wire name, the found tool appended to the list, the search as a function call.
      expect(server.requests[1]!.body.tools).toEqual([wire("read"), { ...wire(TOOL_SEARCH_WIRE_NAME), description: "tool tool_search" }, wire("notebook_edit")])
      expect(server.requests[1]!.body.input.slice(1)).toEqual([
        { type: "function_call", call_id: "s1", name: TOOL_SEARCH_WIRE_NAME, arguments: '{"query":"notebook"}' },
        { type: "function_call_output", call_id: "s1", output: '{"tools":[]}' },
      ])
      // Remembered: the next call of the session is one request, in the function shape.
      await run(provider)
      expect(server.requests).toHaveLength(3)
      expect(server.requests[2]!.body.tools).toEqual(server.requests[1]!.body.tools)
      // Another session tries the shape for itself.
      await run(provider, { conversationId: "ses_b" })
      expect(server.requests).toHaveLength(5)
      expect(server.requests[3]!.body.tools).toEqual([wire("read"), searchEntry])
    } finally { server.stop() }
  })

  test("a request refused in both shapes fails with the second answer and switches nothing; a server error is not a refusal", async () => {
    let status = 400
    const { server, provider } = hosted(() => status === 200 ? completed() : new Response('{"detail":"context too long"}', { status }))
    try {
      await expect(run(provider)).rejects.toThrow("[PROVIDER]: chatgpt 400")
      expect(server.requests).toHaveLength(2)
      status = 500
      await expect(run(provider)).rejects.toThrow("[PROVIDER]: chatgpt 500")
      expect(server.requests).toHaveLength(3)
      status = 200
      await run(provider)
      expect(server.requests).toHaveLength(4)
      expect([2, 3].map((index) => server.requests[index]!.body.tools)).toEqual([[wire("read"), searchEntry], [wire("read"), searchEntry]])
    } finally { server.stop() }
  })

  test("only the ChatGPT backend uses the shape by default; without tool_search in the request nothing changes", async () => {
    const shapeAt = async (baseUrl: string, tools?: ToolSpec[]) => {
      const bodies: Array<Record<string, any>> = []
      const provider = createResponsesProvider({ id: "p", model: "gpt-test", baseUrl, headers: async () => ({ authorization: "Bearer t" }), fetch: async (_url, init) => (bodies.push(JSON.parse(String(init.body))), completed()) })
      await run(provider, tools ? { tools } : {})
      return bodies[0]!.tools.map((tool: { type: string; name?: string }) => tool.name ?? tool.type)
    }
    expect(await shapeAt("https://chatgpt.com/backend-api/codex")).toEqual(["read", "tool_search"])
    expect(await shapeAt("https://api.openai.com/v1")).toEqual(["read", TOOL_SEARCH_WIRE_NAME, "notebook_edit"])
    expect(await shapeAt("https://openrouter.ai/api/v1")).toEqual(["read", TOOL_SEARCH_WIRE_NAME, "notebook_edit"])
    expect(await shapeAt("https://chatgpt.com/backend-api/codex", [spec("read"), spec("notebook_edit")])).toEqual(["read", "notebook_edit"])
  })
})
