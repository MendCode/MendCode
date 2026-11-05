import { describe, expect, test } from "bun:test"
import type { ModelRequest } from "../src"
import { bedrockBody } from "../src/amazon-bedrock"

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read it" }], tools: [], signal: new AbortController().signal, parameters: { temperature: 0.4, topP: 0.9 }, ...over })
const body = (model: string, over: Partial<ModelRequest> = {}) => bedrockBody(request({ model, ...over }), "amazon-bedrock", model) as any

describe("Bedrock thinking follows the Claude model", () => {
  test.each([
    "anthropic.claude-opus-5-5-v1:0",
    "us.anthropic.claude-opus-5-5-v1:0",
    "global.anthropic.claude-sonnet-5-5-v1:0",
    "eu.anthropic.claude-haiku-5-5-v1:0",
    "anthropic.claude-fable-5",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0",
  ])("%s gets adaptive thinking with the effort and no budget", (model) => {
    const sent = body(model, { effort: "high" })
    expect(sent.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } })
    expect(JSON.stringify(sent)).not.toContain("budget_tokens")
    expect(sent.inferenceConfig).toEqual({ maxTokens: 4096 })
  })

  test("adaptive keeps the requested output cap and an ARN alias is read from bedrockModelId", () => {
    expect(body("anthropic.claude-opus-5-5-v1:0", { effort: "low", maxOutputTokens: 8000 }).inferenceConfig.maxTokens).toBe(8000)
    const alias = body("anthropic.claude-alias", { effort: "medium", parameters: { bedrockModelId: "arn:aws:bedrock:us-east-1:1:inference-profile/global.anthropic.claude-sonnet-5-5-v1:0" } })
    expect(alias.additionalModelRequestFields).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } })
  })

  test("a model that cannot turn thinking off gets effort low for none", () => {
    expect(body("anthropic.claude-opus-5-5-v1:0", { effort: "none" }).additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" } })
  })

  test.each(["anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic.claude-opus-4-20250514-v1:0"])("older %s keeps the token budget", (model) => {
    const sent = body(model, { effort: "low" })
    expect(sent.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } })
    expect(sent.inferenceConfig).toEqual({ maxTokens: 4096 })
  })

  test("an explicit parameters.thinking wins on a current model", () => {
    const thinking = { type: "enabled", budget_tokens: 5000 }
    const sent = body("us.anthropic.claude-opus-5-5-v1:0", { effort: "high", parameters: { thinking } })
    expect(sent.additionalModelRequestFields).toEqual({ thinking })
  })

  test("a non-Claude Bedrock model gets no thinking", () => {
    for (const model of ["amazon.nova-lite-v1:0", "us.meta.llama3-1-70b-instruct-v1:0"]) {
      const sent = body(model, { effort: "high" })
      expect(sent.additionalModelRequestFields).toBeUndefined()
      expect(sent.inferenceConfig).toEqual({ maxTokens: 4096, temperature: 0.4, topP: 0.9 })
    }
  })
})
