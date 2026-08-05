import { describe, expect, test } from "bun:test"
import { resolveActivityPhase, trailingActivityToolNames } from "./activity-signal"

describe("resolveActivityPhase", () => {
  test("keeps reconnecting transport out of generating phases", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        connection: "reconnecting",
        livePhase: "output",
        liveOutputTokens: 42,
      }),
    ).toBe("blocked")
  })

  test("keeps active editing phases visible while the transport reconnects", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        connection: "reconnecting",
        activeToolNames: ["apply_patch"],
      }),
    ).toBe("patching")
    expect(
      resolveActivityPhase({
        status: "busy",
        connection: "connecting",
        activeToolNames: ["edit"],
      }),
    ).toBe("editing")
  })

  test("keeps a terminally disconnected transport blocked over stale tool state", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        connection: "disconnected",
        activeToolNames: ["apply_patch"],
      }),
    ).toBe("blocked")
  })

  test("keeps the latest completed edit visible until new assistant output starts", () => {
    const parts = [
      { type: "reasoning", text: "Planning the change" },
      { type: "text", text: "I will update the file." },
      { type: "tool", tool: "edit", state: { status: "completed" } },
      { type: "step-finish" },
    ]
    expect(trailingActivityToolNames(parts)).toEqual(["edit"])
    expect(
      resolveActivityPhase({
        status: "busy",
        latestToolNames: trailingActivityToolNames(parts),
        hasAnswerText: true,
        livePhase: "output",
        liveOutputTokens: 200,
      }),
    ).toBe("editing")
  })

  test("drops a completed edit once newer assistant output appears", () => {
    expect(
      trailingActivityToolNames([
        { type: "tool", tool: "edit", state: { status: "completed" } },
        { type: "text", text: "The edit is complete." },
      ]),
    ).toEqual([])
  })

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

  test("labels memory extraction as memory work", () => {
    expect(
      resolveActivityPhase({
        status: "busy",
        statusKind: "memory-extract",
        livePhase: "output",
        liveOutputTokens: 42,
      }),
    ).toBe("memory")
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
