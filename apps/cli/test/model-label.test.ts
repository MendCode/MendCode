import { describe, expect, test } from "bun:test"
import { modelLabel, modelListLabel, modelParts, modelWithEffort, prettyModelId, servedByProvider, sessionModelLabel } from "../src/view/model-label"

describe("prettyModelId", () => {
  test("names a Claude model by family and version without a table of releases", () => {
    expect(prettyModelId("claude-opus-5-5")).toBe("Opus 5.5")
    expect(prettyModelId("claude-sonnet-5-5")).toBe("Sonnet 5.5")
    expect(prettyModelId("claude-fable-5-1")).toBe("Fable 5.1")
    expect(prettyModelId("claude-sonnet-4")).toBe("Sonnet 4")
    expect(prettyModelId("claude-opus")).toBe("Opus")
    expect(prettyModelId("claude-3-5-sonnet")).toBe("Sonnet 3.5")
    expect(prettyModelId("claude-zephyr-7-3")).toBe("Zephyr 7.3")
  })

  test("drops date suffixes in every spelling", () => {
    expect(prettyModelId("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(prettyModelId("claude-sonnet-4-5@20250929")).toBe("Sonnet 4.5")
    expect(prettyModelId("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5")
    expect(prettyModelId("claude-opus-4-1-latest")).toBe("Opus 4.1")
    expect(prettyModelId("gpt-4o-2024-08-06")).toBe("GPT-4o")
  })

  test("names GPT and Gemini models", () => {
    expect(prettyModelId("gpt-6.1-sol")).toBe("GPT-6.1-Sol")
    expect(prettyModelId("gpt-6-luna")).toBe("GPT-6-Luna")
    expect(prettyModelId("gpt-5.1-codex-mini")).toBe("GPT-5.1-Codex-Mini")
    expect(prettyModelId("gpt-4o-mini")).toBe("GPT-4o-Mini")
    expect(prettyModelId("gemini-3-pro")).toBe("Gemini 3 Pro")
    expect(prettyModelId("gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash Lite")
  })

  test("strips provider and routing prefixes", () => {
    expect(prettyModelId("google-vertex-anthropic:claude-sonnet-4-5@20250929")).toBe("Sonnet 4.5")
    expect(prettyModelId("anthropic:claude-opus-5-5")).toBe("Opus 5.5")
    expect(prettyModelId("openrouter/anthropic/claude-opus-5-5")).toBe("Opus 5.5")
    expect(prettyModelId("openrouter:google/gemini-3-pro")).toBe("Gemini 3 Pro")
    expect(prettyModelId("openai/gpt-6.1-sol")).toBe("GPT-6.1-Sol")
  })

  test("returns an id of an unknown shape unchanged, prefixes and all", () => {
    for (const id of ["llama3:8b", "ollama:llama3:8b", "meta-llama/llama-3-70b", "o3-mini", "gpt-oss-120b", "claude-opus-5-5-thinking", "us.anthropic.claude-opus-4-1-v1:0", "", "mystery"]) expect(prettyModelId(id)).toBe(id)
  })

  test("leaves a name that is already a display name alone", () => {
    for (const name of ["GPT-6.1-Sol", "Opus 5.5", "Claude Sonnet 5.5", "Gemini 3 Pro"]) expect(prettyModelId(name)).toBe(name)
  })
})

describe("modelLabel with a catalog", () => {
  const models = [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude" },
    { id: "anthropic:claude-haiku-4-5-20251001", name: "claude-haiku-4-5-20251001 · Anthropic", provider: "anthropic" },
    { id: "google-vertex-anthropic:claude-sonnet-4-5", name: "Claude Sonnet 4.5 · Vertex", provider: "google-vertex-anthropic" },
  ]

  test("the catalog's display name wins, without its server tag", () => {
    expect(modelLabel("gpt-6.1-sol", { models })).toBe("GPT-6.1-Sol")
    expect(modelLabel("claude-opus", { models })).toBe("Opus")
    expect(modelLabel("google-vertex-anthropic:claude-sonnet-4-5", { models })).toBe("Sonnet 4.5")
  })

  test("a catalog name that is only the id is prettified", () => {
    expect(modelLabel("anthropic:claude-haiku-4-5-20251001", { models })).toBe("Haiku 4.5")
  })

  test("an id missing from the catalog is prettified, and a usage event's bare id finds its one catalog model", () => {
    expect(modelLabel("claude-opus-5-5", { models })).toBe("Opus 5.5")
    expect(modelLabel("claude-haiku-4-5-20251001", { models })).toBe("Haiku 4.5")
    expect(modelLabel("claude-sonnet-4-5", { models })).toBe("Sonnet 4.5")
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5")
  })

  test("one model through two providers stays distinguishable, and only then", () => {
    const both = [
      { id: "anthropic:claude-opus-5-5", name: "claude-opus-5-5 · Anthropic", provider: "anthropic" },
      { id: "openrouter:anthropic/claude-opus-5-5", name: "claude-opus-5-5 · OpenRouter", provider: "openrouter" },
      { id: "gpt-6-luna", name: "GPT-6-Luna" },
    ]
    expect(modelParts("anthropic:claude-opus-5-5", { models: both })).toEqual({ label: "Opus 5.5", qualifier: "anthropic" })
    expect(modelListLabel("openrouter:anthropic/claude-opus-5-5", { models: both })).toBe("Opus 5.5 (openrouter)")
    expect(modelListLabel("gpt-6-luna", { models: both })).toBe("GPT-6-Luna")
    // A status line or toast shows the label alone: the provider is beside it or known from the context.
    expect(modelLabel("openrouter:anthropic/claude-opus-5-5", { models: both })).toBe("Opus 5.5")
    expect(modelParts("gpt-6-luna", { models: both })).toEqual({ label: "GPT-6-Luna" })
    expect(modelLabel("gpt-6-luna")).toBe("GPT-6-Luna")
    // The bare id a usage event reports fits two models: no guess, no qualifier.
    expect(modelLabel("claude-opus-5-5", { models: both })).toBe("Opus 5.5")
  })

  test("two models that share even their provider fall back to the id", () => {
    const same = [
      { id: "openrouter:a/claude-opus-5-5", name: "claude-opus-5-5", provider: "openrouter" },
      { id: "openrouter:b/claude-opus-5-5", name: "claude-opus-5-5", provider: "openrouter" },
    ]
    expect(modelParts("openrouter:a/claude-opus-5-5", { models: same }).qualifier).toBe("openrouter:a/claude-opus-5-5")
  })

  test("joins the effort for a status line", () => {
    expect(modelWithEffort("claude-opus-5-5", "high")).toBe("Opus 5.5 · high")
    expect(modelWithEffort("claude-opus-5-5", undefined)).toBe("Opus 5.5")
  })
})

describe("a harness engine's alias and what it resolves to", () => {
  // Claude Code takes `claude-opus` (always its newest Opus) and reports the resolved id with the first answer's usage.
  const engineReport = { engine: "native", models: [
    { id: "gpt-6-luna", name: "GPT-6-Luna" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude" },
    { id: "claude-haiku", name: "Claude Haiku · Claude Code", engine: "claude" },
  ] }

  test("before the first answer the alias reads as its family, with no version guessed", () => {
    expect(sessionModelLabel({ effective: "claude-opus", catalog: engineReport })).toBe("Opus")
    expect(sessionModelLabel({ effective: "claude-haiku", catalog: engineReport })).toBe("Haiku")
  })

  test("after the first answer the resolved id the engine reported names the version", () => {
    expect(sessionModelLabel({ effective: "claude-opus", used: "claude-opus-5-5", catalog: engineReport })).toBe("Opus 5.5")
    expect(sessionModelLabel({ effective: "claude-haiku", used: "claude-haiku-4-5-20251001", catalog: engineReport })).toBe("Haiku 4.5")
    expect(sessionModelLabel({ effective: "claude-opus", used: "claude-opus-4-7[1m]", catalog: engineReport })).toBe("Opus 4.7")
  })

  test("a usage event of another model never renames the session's model", () => {
    expect(sessionModelLabel({ effective: "claude-opus", used: "claude-haiku-4-5", catalog: engineReport })).toBe("Opus")
    expect(sessionModelLabel({ effective: "gpt-6-luna", used: "gpt-6-luna-mini", catalog: engineReport })).toBe("GPT-6-Luna")
    expect(sessionModelLabel({ used: "claude-opus-5-5" })).toBe("Opus 5.5")
  })

  test("a model run through Claude Code is served by claude, not by the daemon's native engine", () => {
    expect(servedByProvider("claude-opus", engineReport)).toBe("claude")
    expect(servedByProvider("gpt-6-luna", engineReport)).toBe("chatgpt")
    expect(servedByProvider("not-listed", engineReport)).toBe("native")
    expect(servedByProvider("anthropic:x", { engine: "native", models: [{ id: "anthropic:x", provider: "anthropic" }] })).toBe("anthropic")
  })

  test("an ACP agent's model is served by the agent's harness, apart from the same model on a native provider", () => {
    const report = { engine: "native", models: [{ id: "acp:opencode", name: "OpenCode harness" }, { id: "acp:opencode/opencode/deepseek-v4.1-flash-free", name: "OpenCode/DeepSeek V4.1 Flash Free · OpenCode harness" }, { id: "opencode:deepseek-v4.1-flash", provider: "opencode" }] }
    expect(servedByProvider("acp:opencode/opencode/deepseek-v4.1-flash-free", report)).toBe("OpenCode harness")
    expect(servedByProvider("acp:opencode", report)).toBe("OpenCode harness")
    expect(servedByProvider("acp:gone/x", report)).toBe("gone")
    expect(servedByProvider("opencode:deepseek-v4.1-flash", report)).toBe("opencode")
  })
})
