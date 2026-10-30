import { describe, expect, test } from "bun:test"
import { parseCodexModels } from "../src"

const levels = (...efforts: string[]) => efforts.map((effort) => ({ effort, description: "x" }))
const payload = {
  fetched_at: "2026-09-26T00:00:00Z",
  models: [
    { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: levels("low", "medium", "high", "xhigh"), context_window: 272000 },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: levels("low", "medium", "bogus") },
    { slug: "hidden-one", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: levels("low") },
    { display_name: "no slug" },
    null,
  ],
}

describe("parseCodexModels", () => {
  test("keeps listed models in order with their known efforts, default and context window", () => {
    expect(parseCodexModels(payload)).toEqual([
      { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 272000 },
      { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "medium" },
    ])
  })
  test("a maximum window comes from the cache's max_context_window, else the known table (gpt-6-astra 872k), else stays absent", () => {
    const models = parseCodexModels({ models: [
      { slug: "gpt-6-astra", display_name: "Astra", context_window: 272000 },
      { slug: "gpt-6.1-sol", display_name: "Sol", context_window: 500000, max_context_window: 600000 },
      { slug: "gpt-6-luna", display_name: "Luna", context_window: 272000 },
      { slug: "constructor", display_name: "Prototype key" },
    ] })
    expect(models.map((model) => [model.id, model.contextWindow, model.maxContextWindow])).toEqual([
      ["gpt-6-astra", 272000, 872000],
      ["gpt-6.1-sol", 500000, 600000],
      ["gpt-6-luna", 272000, undefined],
      ["constructor", undefined, undefined],
    ])
  })
  test("anything that is not a models payload yields nothing", () => {
    expect(parseCodexModels(null)).toEqual([])
    expect(parseCodexModels({ models: "x" })).toEqual([])
  })
})


