import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src/engine"
import { callTool, scriptedProvider, stop } from "./harness"

/** Host tool events, with a local fake service: shared by CLI interaction checks and frame rendering. */
export function codeModeFixture(state: "selected" | "denied" | "invalid" | "syntax") {
  const code = state === "selected" ? 'const found = search({query: "symbols"}); const result = await tools[found.tools[0].name]({path: "src/main.ts"}); console.log("2 symbols"); return JSON.parse(result.output).names'
    : state === "syntax" ? "return {"
    : `return await tools.mcp__local__symbols({path: ${state === "invalid" ? "1" : '"src/main.ts"'}})`
  const text = state === "selected" ? "Found start and stop in src/main.ts." : state === "denied" ? "Symbol lookup was denied." : state === "invalid" ? "Symbol lookup needs a string path." : "Code has an unclosed object."
  const { provider, requests } = scriptedProvider([callTool("code", { code }), stop(text)])
  let calls = 0
  const engine = createNativeEngine({
    provider, tools: [], history: memoryHistory(), cwdFor: () => "/work/project", system: () => "sys", compactionPrompt: "summarize",
    permissionPolicy: () => ({ experimental: { code_mode: true, tool_discovery: true }, ...(state === "denied" ? { permission: { "mcp__local__symbols": "deny" } } : {}) }),
    projectTools: async () => [defineTool({
      name: "mcp__local__symbols", description: "Find local project symbols", permission: "read",
      args: z.strictObject({ path: z.string() }),
      execute: async ({ path }) => { calls++; return { output: JSON.stringify({ path, names: ["start", "stop"], intermediate: "local index details" }), title: "symbols", isError: false, truncated: false } },
    })],
  })
  return { engine, requests, text, calls: () => calls }
}
