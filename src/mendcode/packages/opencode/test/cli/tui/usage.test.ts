import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@mendcode/sdk/v2"
import {
  assistantTokenTotals,
  compactContextTokenLabel,
  formatAssistantLiveUsage,
  formatAssistantUsage,
  formatAssistantUsageTotal,
  formatWorkingLiveTokenUsage,
  formatLatestAssistantContextUsage,
  usableContextLimit,
} from "../../../src/cli/cmd/tui/util/usage"

function assistant(input: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: input.id ?? "msg_1",
    sessionID: input.sessionID ?? "ses_1",
    role: "assistant",
    agent: input.agent ?? "build",
    modelID: input.modelID ?? "test-model",
    providerID: input.providerID ?? "test-provider",
    mode: input.mode ?? "build",
    parentID: input.parentID ?? "parent_1",
    path: input.path ?? { cwd: "/tmp", root: "/tmp" },
    cost: input.cost ?? 0,
    tokens: input.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: input.time ?? { created: 1, completed: 2 },
    ...input,
  }
}

describe("usage", () => {
  test("counts cache as upload and reasoning as download", () => {
    const result = assistantTokenTotals(
      assistant({
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        },
      }),
    )

    expect(result.input).toBe(125)
    expect(result.output).toBe(60)
    expect(result.context).toBe(185)
  })

  test("formats assistant usage compactly", () => {
    const result = formatAssistantUsage(
      assistant({
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        },
      }),
    )

    expect(result?.tokens).toBe("↑125 ↓60")
    expect(result?.compact).toBe("test-model · ↑125 ↓60")
    expect(result?.contextLabel).toBe("ctx 185")
    expect(result?.rawInput).toBe(100)
    expect(result?.rawOutput).toBe(50)
    expect(result?.cacheRead).toBe(20)
    expect(result?.cacheWrite).toBe(5)
  })

  test("formats context percent without parentheses", () => {
    const providers = new Map([
      [
        "test-provider",
        {
          id: "test-provider",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              limit: { context: 1000, output: 100 },
            },
          },
        } as any,
      ],
    ])
    const result = formatAssistantUsage(
      assistant({
        tokens: {
          input: 280,
          output: 40,
          reasoning: 10,
          cache: { read: 0, write: 0 },
        },
      }),
      providers,
    )

    expect(result?.contextPercent).toBe(37)
    expect(result?.contextLimit).toBe(900)
    expect(result?.contextLabel).toBe("ctx 330 37%")
    expect(result?.contextLabel).not.toContain("(")
  })

  test("uses input window minus reserve when provider exposes separate input and output limits", () => {
    const model = {
      id: "test-model",
      name: "Test Model",
      limit: { context: 400_000, input: 272_000, output: 128_000 },
    } as any

    expect(usableContextLimit(model)).toBe(252_000)
  })

  test("keeps compact context hover labels fixed width", () => {
    expect(compactContextTokenLabel(42)).toBe("42  ")
    expect(compactContextTokenLabel(9_999)).toBe("9999")
    expect(compactContextTokenLabel(105_200)).toBe("105K")
    expect(compactContextTokenLabel(1_250_000)).toBe("1.3M")
  })

  test("aggregates assistant usage totals and keeps the last used model", () => {
    const result = formatAssistantUsageTotal([
      assistant({
        modelID: "first-model",
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 3 } },
      }),
      assistant({
        id: "msg_2",
        modelID: "second-model",
        cost: 0.02,
        tokens: { input: 20, output: 8, reasoning: 2, cache: { read: 0, write: 0 } },
      }),
    ])

    expect(result?.model).toBe("second-model")
    expect(result?.scope).toBe("total")
    expect(result?.tokens).toBe("↑35 ↓15")
    expect(result?.contextLimit).toBeUndefined()
    expect(result?.contextPercent).toBeUndefined()
    expect(result?.contextLabel).toBe("total 50")
    expect(result?.cost).toBe(0.03)
  })

  test("formats live usage with model variant and context", () => {
    const result = formatAssistantLiveUsage(
      assistant({
        variant: "low",
        liveUsage: {
          source: "estimate",
          phase: "output",
          input: 100,
          output: 25,
          reasoning: 5,
          cache: { read: 10, write: 0 },
        },
      }),
    )

    expect(result?.detail).toBe("live estimate · test-model · low · ↑110 ↓30 · ctx 140")
  })

  test("marks compact working token usage as estimated without text noise", () => {
    expect(
      formatWorkingLiveTokenUsage({
        source: "estimate",
        phase: "output",
        input: 100,
        output: 25,
        reasoning: 5,
        cache: { read: 10, write: 0 },
      }),
    ).toBe("↓~30")
  })

  test("raw working token usage can expose reasoning tokens separately", () => {
    expect(
      formatWorkingLiveTokenUsage(
        {
          source: "estimate",
          phase: "output",
          input: 100,
          output: 25,
          reasoning: 5,
          cache: { read: 10, write: 0 },
        },
        { showReasoning: true },
      ),
    ).toBe("↓~30 · 5 reasoning tokens")
  })

  test("does not mark provider compact working token usage as estimated", () => {
    expect(
      formatWorkingLiveTokenUsage({
        source: "provider",
        phase: "input",
        input: 100,
        output: 0,
        reasoning: 0,
        cache: { read: 10, write: 5 },
      }),
    ).toBe("↑115")
  })

  test("latest context usage ignores live-only active messages", () => {
    const result = formatLatestAssistantContextUsage([
      assistant({
        id: "msg_1",
        tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      assistant({
        id: "msg_2",
        time: { created: 3 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        liveUsage: {
          source: "estimate",
          phase: "output",
          input: 30_000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ])

    expect(result?.context).toBe(1_200)
  })

  test("latest context usage can filter to main agents", () => {
    const result = formatLatestAssistantContextUsage(
      [
        assistant({
          id: "msg_1",
          agent: "build",
          tokens: { input: 10_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        assistant({
          id: "msg_2",
          agent: "reviewer",
          tokens: { input: 80_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      undefined,
      { include: (message) => message.agent === "build" },
    )

    expect(result?.context).toBe(11_000)
  })
})
