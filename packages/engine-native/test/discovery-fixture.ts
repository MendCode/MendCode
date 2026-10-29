import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src/engine"
import { callTool, scriptedProvider, stop } from "./harness"

/** Local provider and secondary service fixture shared by CLI interaction tests and text-frame rendering. */
export function discoveryFixture(state: "found" | "empty" | "invalid") {
  const query = state === "empty" ? "unavailable" : "symbols"
  const { provider, requests } = scriptedProvider([
    callTool("tool_search", { query, ...(state === "invalid" ? { limit: 9 } : {}) }),
    stop(state === "found" ? "Found the local symbol tool." : state === "empty" ? "No matching tools." : "Search limit must be 1–8."),
  ])
  const engine = createNativeEngine({
    provider, tools: [], history: memoryHistory(), cwdFor: () => "/work/project", system: () => "sys", compactionPrompt: "summarize",
    permissionPolicy: () => ({ experimental: { tool_discovery: true } }),
    projectTools: async () => [defineTool({
      name: "mcp__local__symbols", description: "Find project symbols", permission: "read",
      args: z.strictObject({ query: z.string().max(200) }),
      execute: async () => { throw new Error("lookup must not execute discovered tools") },
    })],
  })
  return { engine, requests, query }
}
