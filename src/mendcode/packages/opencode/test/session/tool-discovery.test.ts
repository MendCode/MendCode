import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { searchTools, withToolDiscovery } from "../../src/session/tool-discovery"
import { memorySnapshot, memorySnapshotContent } from "../../src/session/context-memory"
import type { MessageV2 } from "../../src/session/message-v2"

const definition = (description: string) => tool({ description, inputSchema: jsonSchema({ type: "object" }) })

describe("tool discovery", () => {
  test("keeps core tools and makes secondary schemas available after discovery", async () => {
    const tools = { read: definition("Read files"), notes_find: definition("Search notes and memory"), screenshot: definition("Capture the computer screen") }
    const initial = withToolDiscovery(tools, [])
    expect(Object.keys(initial)).toEqual(["read", "tool_search"])
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

  test("memory snapshots are synthetic, frozen per turn and not confused with ordinary user text", () => {
    const content = memorySnapshotContent("<mendcode_memory>Prefer narrow tests</mendcode_memory>")
    const message = { info: { role: "user" }, parts: [{ type: "text", ...content }] } as unknown as MessageV2.WithParts
    expect(memorySnapshot(message)?.text).toContain("not a new user request or permission")
    expect(memorySnapshot({ ...message, parts: [{ ...message.parts[0], synthetic: false } as MessageV2.TextPart] })).toBeUndefined()
    expect(memorySnapshotContent("").text).toBe("")
  })
})
