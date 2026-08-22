import { describe, expect, test } from "bun:test"
import {
  parseCodexAppServerUsage,
  parseCodexSubscriptionUsage,
  subscriptionWindowLabel,
} from "@/cli/cmd/tui/routes/stats/subscription-usage"

describe("stats subscription usage", () => {
  test("reads the official Codex app-server rate-limit response", () => {
    const usage = parseCodexAppServerUsage({
      rateLimits: {
        planType: "pro",
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_788_000_000 },
        secondary: null,
      },
      rateLimitsByLimitId: null,
    })
    expect(usage).toMatchObject({
      provider: "codex",
      plan: "pro",
      windows: [{ label: "5h", usedPercent: 22, windowMinutes: 300, resetsAt: 1_788_000_000_000 }],
    })
  })

  test("reads the latest valid Codex rate-limit event", () => {
    const usage = parseCodexSubscriptionUsage(
      [
        JSON.stringify({ payload: { type: "token_count", info: { rate_limits: null } } }),
        JSON.stringify({
          timestamp: "2026-08-22T12:00:00.000Z",
          payload: {
            type: "token_count",
            info: {
              rate_limits: {
                plan_type: "pro",
                primary: { used_percent: 18, window_minutes: 300, resets_at: 1_788_000_000 },
                secondary: { used_percent: 89, window_minutes: 10_080, resets_at: 1_788_500_000 },
              },
            },
          },
        }),
      ].join("\n"),
    )

    expect(usage).toEqual({
      provider: "codex",
      plan: "pro",
      updatedAt: Date.parse("2026-08-22T12:00:00.000Z"),
      windows: [
        { label: "5h", usedPercent: 18, windowMinutes: 300, resetsAt: 1_788_000_000_000 },
        { label: "7d", usedPercent: 89, windowMinutes: 10_080, resetsAt: 1_788_500_000_000 },
      ],
    })
  })

  test("ignores malformed lines and clamps provider percentages", () => {
    const usage = parseCodexSubscriptionUsage(
      `{not-json}\n${JSON.stringify({
        payload: {
          type: "token_count",
          info: { rate_limits: { primary: { used_percent: 140, window_minutes: 60 } } },
        },
      })}`,
    )
    expect(usage?.windows[0]).toMatchObject({ label: "1h", usedPercent: 100 })
    expect(subscriptionWindowLabel(45)).toBe("45m")
  })
})
