import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema, tool, wrapLanguageModel } from "ai"
import { discoveryWireMiddleware, withToolDiscovery } from "../../src/session/tool-discovery"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"
import { prepareCodexChatGPTOAuthRequest } from "../../src/plugin/codex"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

const args = { query: "computer desktop screenshot click type mouse", limit: 2 }
const reply = {
  id: "resp_fixture", created_at: 0, model: "gpt-5",
  output: [{ type: "message", id: "msg_reply", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
}

describe("discovery arguments at the Responses wire boundary", () => {
  test("a local discovery function must not become a native tool_search_call", async () => {
    let request: { input: Array<Record<string, unknown>> } | undefined
    const model = wrapLanguageModel({ model: createOpenAI({
      apiKey: "fixture-only",
      fetch: (async (_url, init) => {
        request = JSON.parse(String(init?.body))
        return Response.json({
          id: "resp_fixture", created_at: 0, model: "gpt-5", output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        })
      }) as typeof fetch,
    }).responses("gpt-5"), middleware: discoveryWireMiddleware() })
    await model.doGenerate({
      prompt: [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_discovery", toolName: "tool_search", input: args }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call_discovery", toolName: "tool_search", output: { type: "text", value: "found computer_capture" } }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      tools: [{ type: "function", name: "tool_search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
      providerOptions: { openai: { store: false } },
    })
    const call = request!.input[0]
    expect(call.type).toBe("function_call")
    expect(JSON.parse(String(call.arguments))).toEqual(args)
    expect(call.call_id).toBe("call_discovery")
  })

  for (const status of ["completed", "error", "running", "pending"] as const) {
    for (const oauth of [false, true]) {
      test(`persisted ${status} discovery survives ${oauth ? "OAuth" : "API key"} follow-up`, async () => {
        const inventory = { computer_capture: tool({ description: "computer desktop screenshot", inputSchema: jsonSchema({ type: "object" }) }) }
        const tools = withToolDiscovery(inventory, [])
        const result = await tools.tool_search.execute!(args, { toolCallId: "call_discovery", messages: [] })
        const state = status === "completed"
          ? { status, input: args, ...result as object, time: { start: 0, end: 1 } }
          : status === "error" ? { status, input: args, error: "cancelled", time: { start: 0, end: 1 } }
          : status === "running" ? { status, input: args, time: { start: 0 } }
          : { status, input: args, raw: JSON.stringify(args) }
        const history = JSON.parse(JSON.stringify([{
          info: { id: "msg_assistant", sessionID: "session_fixture", role: "assistant", modelID: "gpt-5", providerID: "openai" },
          parts: [{ id: "part_tool", messageID: "msg_assistant", sessionID: "session_fixture", type: "tool", tool: "tool_search", callID: "call_discovery", state }],
        }])) as MessageV2.WithParts[]
        const before = JSON.stringify(history)
        const messages = await MessageV2.toModelMessages(history, {
          id: "gpt-5", providerID: "openai", api: { id: "gpt-5", npm: "@ai-sdk/openai" },
        } as Provider.Model)
        let wire: { input: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> } | undefined
        const model = wrapLanguageModel({
          middleware: discoveryWireMiddleware(),
          model: createOpenAI({ apiKey: "fixture-only", fetch: (async (_url, init) => {
            wire = JSON.parse(String(oauth ? prepareCodexChatGPTOAuthRequest({ body: init?.body, headers: new Headers(), responsesLite: false }) : init?.body))
            return Response.json(reply)
          }) as typeof fetch }).responses("gpt-5"),
        })
        await generateText({ model, messages: [...messages, { role: "user", content: "continue" }], tools, maxRetries: 0, providerOptions: { openai: { store: false } } })
        const call = wire!.input.find((item) => item.type === "function_call")!
        expect(call.name).toBe("mendcode_tool_search")
        expect(JSON.parse(String(call.arguments))).toEqual(args)
        expect(wire!.input.find((item) => item.type === "function_call_output")?.call_id).toBe(call.call_id)
        expect(wire!.input.some((item) => item.type === "tool_search_call")).toBe(false)
        expect(wire!.tools.find((item) => item.name === "mendcode_tool_search")?.type).toBe("function")
        expect(JSON.stringify(history)).toBe(before)
        if (status === "completed") expect(withToolDiscovery(inventory, history).computer_capture).toBeDefined()
      })
    }
  }

  test("rejects missing historical discovery input without dispatch or invented arguments", async () => {
    let requests = 0
    const model = wrapLanguageModel({
      middleware: discoveryWireMiddleware(),
      model: createOpenAI({ apiKey: "fixture-only", fetch: (async (_url, _init) => { requests++; return Response.json(reply) }) as typeof fetch }).responses("gpt-5"),
    })
    await expect(model.doGenerate({ prompt: [{ role: "assistant", content: [{ type: "tool-call", toolName: "tool_search", toolCallId: "call_invalid", input: undefined }] }] })).rejects.toThrow("fork the session")
    expect(requests).toBe(0)
  })

  test("streamed discovery calls return to the host name without changing IDs or JSON", async () => {
    const input = { query: "captura ñ", nested: { values: [1, false, null] } }
    const item = { type: "function_call", status: "completed", id: "fc_1", call_id: "call_1", name: "mendcode_tool_search", arguments: JSON.stringify(input) }
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { usage: reply.usage } },
    ]
    const model = wrapLanguageModel({
      middleware: discoveryWireMiddleware(),
      model: createOpenAI({ apiKey: "fixture-only", fetch: (async (_url, _init) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch }).responses("gpt-5"),
    })
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "find tools" }] }], tools: [{ type: "function", name: "tool_search", inputSchema: { type: "object" } }] })
    const chunks: LanguageModelV3StreamPart[] = []
    const reader = result.stream.getReader()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
    expect(chunks.filter((part) => part.type === "error")).toEqual([])
    expect(chunks.find((part) => part.type === "tool-input-start")).toMatchObject({ toolName: "tool_search", id: "call_1" })
    const call = chunks.find((part) => part.type === "tool-call")!
    expect(call).toMatchObject({ toolName: "tool_search", toolCallId: "call_1" })
    expect(JSON.parse(call.input)).toEqual(input)
  })

  test("does not remap genuine provider-native discovery or unrelated function names", async () => {
    const middleware = discoveryWireMiddleware()
    const model = createOpenAI({ apiKey: "fixture-only" }).responses("gpt-5")
    const params = { prompt: [], tools: [{ type: "provider" as const, name: "tool_search", id: "openai.tool_search" as const, args: {} }] }
    expect(await middleware.transformParams!({ type: "generate", model, params })).toBe(params)
    const ordinary = { prompt: [], tools: [{ type: "function" as const, name: "read", inputSchema: { type: "object" as const } }] }
    expect(await middleware.transformParams!({ type: "generate", model, params: ordinary })).toBe(ordinary)
  })
})
