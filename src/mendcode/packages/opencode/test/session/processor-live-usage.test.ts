import { describe, expect, test } from "bun:test"
import { providerLiveUsage } from "../../src/session/processor"

describe("session processor live usage", () => {
  test("reads OpenAI Responses usage from completed raw chunks", () => {
    expect(
      providerLiveUsage({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 123_700,
            input_tokens_details: { cached_tokens: 30_000 },
            output_tokens: 1_800,
            output_tokens_details: { reasoning_tokens: 600 },
          },
        },
      }),
    ).toEqual({
      source: "provider",
      phase: "output",
      input: 123_700,
      output: 1_800,
      reasoning: 600,
      cache: { read: 30_000, write: 0 },
    })
  })

  test("merges Anthropic streaming output usage with previous input usage", () => {
    expect(
      providerLiveUsage(
        {
          type: "message_delta",
          usage: {
            output_tokens: 420,
          },
        },
        {
          source: "provider",
          phase: "input",
          input: 93_900,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
    ).toEqual({
      source: "provider",
      phase: "output",
      input: 93_900,
      output: 420,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test("reads Gemini usageMetadata token counts", () => {
    expect(
      providerLiveUsage({
        usageMetadata: {
          promptTokenCount: 10_000,
          cachedContentTokenCount: 2_000,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 50,
        },
      }),
    ).toEqual({
      source: "provider",
      phase: "output",
      input: 10_000,
      output: 300,
      reasoning: 50,
      cache: { read: 2_000, write: 0 },
    })
  })
})
