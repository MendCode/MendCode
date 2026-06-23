import { describe, expect, test } from "bun:test"
import {
  buildUsageInsights,
  formatInsightDuration,
  normalizeUsageInsights,
  type InsightMessage,
  type InsightSession,
  type SessionInsightInput,
  type UsageInsights,
} from "../../src/cli/cmd/tui/util/usage-insights"

const base = new Date("2026-06-14T12:00:00Z").getTime()

function item(input: { session?: Partial<InsightSession>; messages?: InsightMessage[] }): SessionInsightInput {
  return {
    session: {
      id: "ses_1",
      title: "Test",
      agent: "build",
      summary: { files: 2, additions: 4, deletions: 1 },
      time: { created: base, updated: base },
      ...input.session,
    },
    messages: input.messages ?? [],
  }
}

describe("usage insights", () => {
  test("aggregates tokens, user words, response time, and tools by day", () => {
    const insights = buildUsageInsights(
      [
        item({
          messages: [
            {
              info: { id: "msg_1", role: "user", agent: "build", time: { created: base } },
              parts: [{ type: "text", text: "ship the dashboard today" }],
            },
            {
              info: {
                id: "msg_2",
                role: "assistant",
                agent: "build",
                providerID: "openai",
                modelID: "gpt-test",
                cost: 0.12,
                tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 2 } },
                time: { created: base + 1000, completed: base + 61_000 },
              },
              parts: [
                {
                  type: "tool",
                  tool: "bash",
                  state: { status: "completed", time: { start: base + 2000, end: base + 5000 } },
                },
              ],
            },
          ],
        }),
      ],
      { start: base, end: base },
    )

    expect(insights.totals.sessions).toBe(1)
    expect(insights.totals.userWords).toBe(4)
    expect(insights.totals.tokens).toBe(157)
    expect(insights.days.at(-1)?.inputTokens).toBe(100)
    expect(insights.days.at(-1)?.outputTokens).toBe(40)
    expect(insights.days.at(-1)?.reasoningTokens).toBe(10)
    expect(insights.days.at(-1)?.cacheTokens).toBe(7)
    expect(insights.totals.aiResponseMs).toBe(60_000)
    expect(insights.totals.toolMs).toBe(3_000)
    expect(insights.totals.changedFiles).toBe(2)
    expect(insights.topTools[0]).toEqual({ name: "bash", count: 1 })
    expect(insights.topModels[0]?.name).toBe("openai/gpt-test")
  })

  test("computes active-day streaks from user or token activity", () => {
    const day = 24 * 60 * 60 * 1000
    const insights = buildUsageInsights(
      [
        item({
          session: { id: "ses_a", time: { created: base - day, updated: base - day } },
          messages: [{ info: { id: "msg_a", role: "user", time: { created: base - day } }, parts: [] }],
        }),
        item({
          session: { id: "ses_b", time: { created: base, updated: base } },
          messages: [{ info: { id: "msg_b", role: "user", time: { created: base } }, parts: [] }],
        }),
      ],
      { start: base - day * 2, end: base },
    )

    expect(insights.totals.activeDays).toBe(2)
    expect(insights.totals.currentStreak).toBe(2)
    expect(insights.totals.longestStreak).toBe(2)
  })

  test("normalizes legacy cached days without daily token mix fields", () => {
    const legacy = {
      days: [
        {
          day: "2026-06-14",
          time: base,
          sessions: 1,
          messages: 2,
          userMessages: 1,
          userWords: 4,
          tokens: 157,
          cost: 0.12,
          aiResponseMs: 60_000,
          toolMs: 3_000,
          changedFiles: 2,
        },
      ],
      totals: {
        sessions: 1,
        messages: 2,
        userMessages: 1,
        userWords: 4,
        tokens: 157,
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheTokens: 7,
        cost: 0.12,
        aiResponseMs: 60_000,
        toolMs: 3_000,
        changedFiles: 2,
        activeDays: 1,
        currentStreak: 1,
        longestStreak: 1,
        peakTokens: 157,
        longestTaskMs: 60_000,
        sessionsWithCodeChanges: 1,
      },
      topTools: [],
      topAgents: [],
      topModels: [],
    } as unknown as UsageInsights

    const normalized = normalizeUsageInsights(legacy)
    const normalizedDay = normalized?.days[0]

    expect(normalizedDay?.inputTokens).toBe(0)
    expect(normalizedDay?.outputTokens).toBe(0)
    expect(normalizedDay?.reasoningTokens).toBe(0)
    expect(normalizedDay?.cacheTokens).toBe(0)
    expect(normalized?.totals.cacheTokens).toBe(7)
  })

  test("formats multi-day durations with normalized days and hours", () => {
    expect(formatInsightDuration(116 * 60 * 60 * 1000)).toBe("4d 20h")
  })
})
