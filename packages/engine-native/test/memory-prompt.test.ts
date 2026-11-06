import { expect, test } from "bun:test"
import { createMemoryGraphTool, createMemoryTool, createRememberTool } from "../src/memory"
import { loadSystemPrompt } from "../src/defaults"

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
  // What the terminal draws (swatches, callouts, path links, images) moved out of this file into packages/daemon/prompts/rendering.md, sent by prompt mode; only the diff-card line stayed.
  expect(total - 2381).toBeLessThanOrEqual(0)
  expect(system).toContain("If a request needs no code, answer without tools.")
  // Code questions reach for the graph before text search, without the user having to say "use graph".
  expect(system).toContain("Find code with `graph_find`/`graph_callers` when listed, text with `grep`/`glob`")
  expect(system).not.toContain("Use the tools to inspect before you change anything")
})

test("the base prompt no longer carries the terminal rendering block: the prompt mode decides how much of it a model gets", async () => {
  const system = (await loadSystemPrompt())("/x")
  expect(system).not.toContain("Terminal rendering")
  expect(system).not.toContain("mermaid")
  expect(system).toContain("Edits already show as diff cards")
})
