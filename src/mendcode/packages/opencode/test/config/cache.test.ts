import { describe, expect, test } from "bun:test"
import { ConfigCache } from "@/config/cache"

describe("cache configuration", () => {
  test("keeps legacy behavior when no cache policy is configured", () => {
    expect(ConfigCache.selectCacheConfig({ config: undefined, projectScope: "/repo", sessionID: "ses_1" })).toEqual({
      mode: "legacy",
      source: "default",
      reason: "cache policy is not configured",
    })
  })

  test("applies session, project, provider, and model restrictions", () => {
    const config: ConfigCache.Info = {
      mode: "smart",
      projects: {
        "/repo": { mode: "smart" },
      },
      sessions: {
        mode: "selected",
        include: ["ses_allowed"],
      },
      providers: {
        openai: {
          models: ["gpt-6-astra"],
        },
      },
    }

    expect(
      ConfigCache.selectCacheConfig({
        config,
        projectScope: "/repo/",
        sessionID: "ses_allowed",
        providerID: "openai",
        modelID: "openai/gpt-6-astra",
        apiModelID: "gpt-6-astra",
      }).mode,
    ).toBe("smart")
    expect(
      ConfigCache.selectCacheConfig({
        config,
        projectScope: "/repo",
        sessionID: "ses_other",
        providerID: "openai",
        modelID: "openai/gpt-6-astra",
        apiModelID: "gpt-6-astra",
      }),
    ).toMatchObject({ mode: "off", source: "session" })
    expect(
      ConfigCache.selectCacheConfig({
        config,
        projectScope: "/repo",
        sessionID: "ses_allowed",
        providerID: "openai",
        modelID: "openai/gpt-5.5",
        apiModelID: "gpt-5.5",
      }),
    ).toMatchObject({ mode: "off", source: "model" })
  })

  test("updates exact provider models and session selections without mutating input", () => {
    const current: ConfigCache.Info = {
      providers: { openai: { mode: "smart", models: ["gpt-5.5"] } },
      sessions: { mode: "selected", include: ["ses_old"] },
    }
    const next = ConfigCache.updateCacheConfig(current, {
      action: "enable",
      providerID: "openai",
      modelID: "gpt-6-astra",
    })
    const withSession = ConfigCache.updateCacheConfig(next, { action: "disable", sessionID: "ses_old" })

    expect(next.providers?.openai?.models).toEqual(["gpt-5.5", "gpt-6-astra"])
    expect(withSession.sessions?.include).toEqual([])
    expect(withSession.sessions?.exclude).toEqual(["ses_old"])
    expect(current.providers?.openai?.models).toEqual(["gpt-5.5"])
    expect(current.sessions?.exclude).toBeUndefined()
  })

  test("accepts the public JSON configuration shape", () => {
    expect(
      ConfigCache.Info.zod.parse({
        mode: "smart",
        projects: { "/repo": { mode: "smart" } },
        sessions: { mode: "selected", include: ["ses_1"], exclude: [] },
        providers: { openai: { mode: "smart", models: ["gpt-6-astra"], exclude_models: [] } },
      }),
    ).toEqual({
      mode: "smart",
      projects: { "/repo": { mode: "smart" } },
      sessions: { mode: "selected", include: ["ses_1"], exclude: [] },
      providers: { openai: { mode: "smart", models: ["gpt-6-astra"], exclude_models: [] } },
    })
  })
})
