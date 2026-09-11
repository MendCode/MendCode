import { describe, expect, test } from "bun:test"
import { fingerprintPrefix, selectCacheIdentity } from "@/session/cache-lineage"

describe("cache lineage", () => {
  test("inherits only an identical fingerprint while keeping runtime identity separate", () => {
    const inherited = selectCacheIdentity({
      sessionID: "child-session",
      transportAffinity: "child-affinity",
      ownLineageID: "child-lineage",
      parent: { lineageID: "root-lineage", cacheKey: "root-cache", fingerprint: "same" },
      fingerprint: "same",
      legacyKey: "child-cache",
    })
    const forked = selectCacheIdentity({
      sessionID: "child-session",
      transportAffinity: "child-affinity",
      ownLineageID: "child-lineage",
      parent: { lineageID: "root-lineage", cacheKey: "root-cache", fingerprint: "different" },
      fingerprint: "same",
      legacyKey: "child-cache",
    })

    expect(inherited).toEqual({
      runtimeSessionID: "child-session",
      transportAffinity: "child-affinity",
      cacheKey: "root-cache",
      lineageID: "root-lineage",
      compatible: true,
      reason: "cache prefix fingerprint matches the parent",
    })
    expect(forked.cacheKey).toBe("child-cache")
    expect(forked.lineageID).toBe("child-lineage")
    expect(forked.compatible).toBe(false)
  })

  test("does not create a fingerprint without account/project scope or with unknown transport", () => {
    const common = {
      projectScope: "project-1",
      prefix: "stable",
      toolDefinitions: [],
      settings: {},
      serializationRevision: "serializer-1",
    }
    expect(
      fingerprintPrefix({
        ...common,
        binding: {
          providerID: "openai",
          modelID: "openai/gpt-6-astra",
          apiModelID: "gpt-6-astra",
          endpoint: "https://api.openai.com/v1/responses",
          auth: "api",
          transport: "responses-http",
          sdk: "@ai-sdk/openai",
          accountScope: "account-1",
        },
      }),
    ).toMatch(/^[a-f0-9]{64}$/)
    expect(
      fingerprintPrefix({
        ...common,
        binding: {
          providerID: "openai",
          modelID: "openai/gpt-6-astra",
          apiModelID: "gpt-6-astra",
          endpoint: "https://api.openai.com/v1/responses",
          auth: "unknown",
          transport: "responses-http",
          sdk: "@ai-sdk/openai",
          accountScope: "account-1",
        },
      }),
    ).toBeNull()
  })
})
