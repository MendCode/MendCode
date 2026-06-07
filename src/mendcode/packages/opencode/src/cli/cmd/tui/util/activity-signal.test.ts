import { describe, expect, test } from "bun:test"
import { resolveActivityPhase } from "./activity-signal"

describe("resolveActivityPhase", () => {
  test("labels busy request without assistant evidence as sending", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
      }),
    ).toBe("sending")
  })

  test("labels live answer output as generating instead of thinking", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        hasReasoning: true,
        livePhase: "output",
        liveOutputTokens: 42,
        liveReasoningTokens: 0,
      }),
    ).toBe("sending")
  })

  test("live answer output wins over stale tool parts", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        toolNames: ["bash"],
        livePhase: "output",
        liveOutputTokens: 20,
      }),
    ).toBe("sending")
  })

  test("active tool work wins over live answer output", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        toolNames: ["bash"],
        activeToolNames: ["apply_patch"],
        livePhase: "output",
        liveOutputTokens: 20,
      }),
    ).toBe("patching")
  })

  test("active running command is not hidden by provider output counters", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        activeToolNames: ["bash"],
        livePhase: "output",
        liveOutputTokens: 20,
      }),
    ).toBe("running")
  })

  test("keeps real reasoning as thinking before answer output starts", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        hasReasoning: true,
        livePhase: "input",
        liveOutputTokens: 0,
        liveReasoningTokens: 12,
      }),
    ).toBe("thinking")
  })

  test("does not treat reasoning-only output totals as answer generation", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        hasReasoning: true,
        livePhase: "output",
        liveOutputTokens: 80,
        liveReasoningTokens: 80,
      }),
    ).toBe("thinking")
  })

  test("answer text wins even when provider reports reasoning separately", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        hasReasoning: true,
        hasAnswerText: true,
        livePhase: "output",
        liveOutputTokens: 20,
        liveReasoningTokens: 80,
      }),
    ).toBe("sending")
  })
})
