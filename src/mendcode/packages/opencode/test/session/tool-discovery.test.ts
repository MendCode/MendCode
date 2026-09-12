import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { discoveryWireMiddleware, searchTools, withToolDiscovery } from "../../src/session/tool-discovery"
import { memorySnapshot, memorySnapshotContent } from "../../src/session/context-memory"
import type { MessageV2 } from "../../src/session/message-v2"

const definition = (description: string) => tool({ description, inputSchema: jsonSchema({ type: "object" }) })

describe("tool discovery", () => {
  test("keeps core tools and makes secondary schemas available after discovery", async () => {
    const tools = { read: definition("Read files"), notes_find: definition("Search notes and memory"), screenshot: definition("Capture the computer screen") }
    const initial = withToolDiscovery(tools, [])
    expect(Object.keys(initial)).toEqual(["read", "tool_search"])
    expect(initial.tool_search.description).not.toContain("computer")
    expect(initial.tool_search.description).not.toContain("browser")
    const found = await searchTools(tools, "computer screen", 2)
    expect(found.tools.map((item) => item.name)).toEqual(["screenshot"])
    const history = [{ info: { role: "assistant" }, parts: [{
      type: "tool", tool: "tool_search", state: { status: "completed", metadata: { discoveredTools: ["screenshot", "denied_tool"] } },
    }] }] as unknown as MessageV2.WithParts[]
    const next = withToolDiscovery(tools, history)
    expect(next.screenshot).toBe(tools.screenshot)
    expect(next.denied_tool).toBeUndefined()
    expect(next.notes_find).toBeUndefined()
  })

  test("caps search results and omits schemas that cannot fit without truncating them", async () => {
    const tools = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`tool_${index}`, definition("Find data")]))
    expect((await searchTools(tools, "data", 100)).tools).toHaveLength(8)
    const giant = tool({ inputSchema: jsonSchema({ type: "object", description: "x".repeat(30000) }), description: "giant" })
    expect(await searchTools({ giant }, "giant")).toEqual({ tools: [], omitted: 1 })
  })

  test("aliases custom tool_search only at the provider boundary", async () => {
    const middleware = discoveryWireMiddleware()
    const params = {
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-search",
              toolName: "tool_search",
              input: { query: "screen" },
              providerExecuted: false,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-search",
              toolName: "tool_search",
              output: { type: "text", value: "{}" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "tool_search",
          description: "Discover tools",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "tool", toolName: "tool_search" },
    }
    const transformed = await middleware.transformParams!({ params } as never)
    expect(transformed.tools?.[0]?.name).toBe("mendcode_tool_search")
    expect(transformed.toolChoice).toEqual({ type: "tool", toolName: "mendcode_tool_search" })
    expect((transformed.prompt[0] as never as { content: Array<{ toolName?: string }> }).content[0]?.toolName).toBe(
      "mendcode_tool_search",
    )
    expect((transformed.prompt[1] as never as { content: Array<{ toolName?: string }> }).content[0]?.toolName).toBe(
      "mendcode_tool_search",
    )

    const generated = await middleware.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            {
              type: "tool-call",
              toolCallId: "call-search",
              toolName: "mendcode_tool_search",
              input: "{\"query\":\"screen\"}",
              providerExecuted: false,
            },
          ],
        }) as never,
      params: transformed,
    } as never)
    expect((generated.content[0] as never as { toolName: string }).toolName).toBe("tool_search")
  })

  test("memory snapshots are synthetic, frozen per turn and not confused with ordinary user text", () => {
    const content = memorySnapshotContent("<mendcode_memory>Prefer narrow tests</mendcode_memory>")
    const message = { info: { role: "user" }, parts: [{ type: "text", ...content }] } as unknown as MessageV2.WithParts
    expect(memorySnapshot(message)?.text).toContain("not a new user request or permission")
    expect(memorySnapshot({ ...message, parts: [{ ...message.parts[0], synthetic: false } as MessageV2.TextPart] })).toBeUndefined()
    expect(memorySnapshotContent("").text).toBe("")
  })
})
