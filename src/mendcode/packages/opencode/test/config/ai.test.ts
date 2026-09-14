import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { Config } from "../../src/config/config"

describe("ai configuration schema", () => {
  test("accepts additive compaction and orchestration fields", () => {
    const parsed = Config.Info.zod.safeParse({
      compaction: {
        strategy: "auto",
        portable_mode: "incremental",
        timeout_ms: 10_000,
        max_summary_tokens: 4_096,
        on_native_error: "portable",
      },
      ai: {
        version: 1,
        orchestration: {
          enabled: true,
          profiles: {
            review: {
              strategy: "critic",
              primary: { providerID: "openai", modelID: "gpt-5.6" },
              critic: { role: "build" },
              limits: {
                maxModelRequests: 4,
                maxTotalTokens: 20_000,
                maxRuntimeMs: 120_000,
                unknownCost: "block",
              },
            },
          },
        },
      },
    })
    expect(parsed.success).toBe(true)
  })

  test("rejects out-of-range bounded fields", () => {
    const parsed = Config.Info.zod.safeParse({
      compaction: { timeout_ms: 999, max_summary_tokens: 9_000 },
      ai: {
        version: 1,
        orchestration: {
          enabled: true,
          profiles: {
            x: {
              strategy: "single",
              primary: { role: "build" },
              limits: {
                maxModelRequests: 0,
                maxTotalTokens: 1,
                maxRuntimeMs: 999,
                unknownCost: "block",
              },
            },
          },
        },
      },
    })
    expect(parsed.success).toBe(false)
  })

  test("effect schema and zod compatibility surfaces describe the same valid shape", () => {
    const value = {
      ai: {
        version: 1,
        orchestration: { enabled: false, profiles: {} },
      },
    } as const
    expect(Config.Info.zod.safeParse(value).success).toBe(true)
    expect(Schema.decodeUnknownSync(Config.Info)(value)).toEqual(value)
  })
})
