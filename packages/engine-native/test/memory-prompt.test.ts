import { expect, test } from "bun:test"
import { createMemoryGraphTool, createMemoryTool, createRememberTool } from "../src/memory"
import { loadSystemPrompt, loadTerminalRendering } from "../src/defaults"

const remember = createRememberTool(() => "pending")
const memory = createMemoryTool({ request: () => ({}) })
const graph = createMemoryGraphTool({ graph: () => ({ nodes: [], links: [], health: { state: "empty", nodes: 0, links: 0, isolated: 0, conflicts: 0 } }) as never, link: () => undefined })

test("the save tools say what is durable and what is not, and when in doubt not to save", () => {
  for (const tool of [remember, memory]) {
    expect(tool.description).toContain("always, from now on")
    expect(tool.description).toContain("this request's content or format")
    expect(tool.description).toContain("task status")
    expect(tool.description).toMatch(/when unsure, don't/i)
  }
  expect(remember.description).not.toContain("Use sparingly")
  expect(memory.description).toContain("never secrets")
})

test("memory guidance and the orientation line stay within the prompt budget", async () => {
  const system = (await loadSystemPrompt())("/project")
  // 2381 characters before the memory and orientation wording changed; at four characters per token this may grow by 80 tokens.
  const total = remember.description.length + memory.description.length + graph.description.length + system.length
  // The call-economy wording (read several files in one call, edit with one patch, no directory listing) added ~175 characters on purpose.
  // Charts drawn in the reply without being asked for Mermaid: one sentence, ~80 characters.
  // Code found through the graph lookups first where the folder is indexed (they are listed only there): ~60 characters on purpose.
  expect(total - 2381).toBeLessThanOrEqual(660)
  expect(system).toContain("If a request needs no code, answer without tools.")
  // Code questions reach for the graph before text search, without the user having to say "use graph".
  expect(system).toContain("Find code with `graph_find`/`graph_callers` when listed, text with `grep`/`glob`")
  expect(system).not.toContain("Use the tools to inspect before you change anything")
})

test("the terminal rendering lines an engine with its own prompt gets are the packaged ones, and only those", async () => {
  const rendering = await loadTerminalRendering()
  const lines = rendering.split("\n")
  expect(lines[0]).toStartWith("Terminal rendering")
  expect(lines.slice(1).every((line) => line.startsWith("- "))).toBe(true)
  expect(rendering).toContain("```mermaid")
  expect(rendering).toContain("xychart-beta")
  expect(rendering).not.toContain("apply_patch")
  expect((await loadSystemPrompt())("/x")).toContain(rendering)
})
