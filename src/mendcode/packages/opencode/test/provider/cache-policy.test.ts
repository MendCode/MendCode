import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import {
  applyLegacyCaching,
  defaultCacheAdapters,
  fingerprintPrefix,
  normalizeCacheObservation,
  resolveCacheAdapter,
  resolveCacheRequestPolicy,
  type CacheAdapter,
  type CacheBinding,
} from "@/provider/cache-policy"
import type * as Provider from "@/provider/provider"

function binding(overrides: Partial<CacheBinding> = {}): CacheBinding {
  return {
    providerID: "openai",
    modelID: "openai/gpt-6-astra",
    apiModelID: "gpt-6-astra",
    endpoint: "https://api.openai.com/v1/responses",
    auth: "api",
    transport: "responses-http",
    sdk: "@ai-sdk/openai",
    accountScope: "account-1",
    ...overrides,
  }
}

const model = {
  providerID: "anthropic",
  api: { id: "claude-3-5-sonnet", npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com" },
} as unknown as Provider.Model

describe("cache policy", () => {
  test("resolves a model adapter before a provider adapter and falls back safely", () => {
    const modelAdapter: CacheAdapter = {
      id: "astra-model",
      scope: "model",
      matches: (input) => input.apiModelID === "gpt-6-astra",
      capabilities: () => ({
        key: true,
        explicitBreakpoints: false,
        retentionSeconds: null,
        refresh: false,
        lineage: false,
      }),
    }

    expect(resolveCacheAdapter(binding(), [modelAdapter, ...defaultCacheAdapters]).id).toBe("astra-model")
    expect(resolveCacheAdapter(binding({ providerID: "unknown", sdk: "unknown" })).id).toBe("legacy-fallback")
    expect(() => resolveCacheAdapter(binding(), [{ ...modelAdapter, id: "second-model" }, modelAdapter])).toThrow(
      "Ambiguous cache adapters",
    )
  })

  test("fingerprints only complete, reproducible prefixes", () => {
    const input = {
      binding: binding(),
      projectScope: "project-1",
      prefix: { system: "stable", order: { b: 2, a: 1 } },
      toolDefinitions: [
        { name: "read", schema: { type: "object" } },
        { name: "write", schema: { type: "object" } },
      ],
      settings: { effort: "high" },
      serializationRevision: "serializer-1",
    }
    const same = fingerprintPrefix({
      ...input,
      prefix: { order: { a: 1, b: 2 }, system: "stable" },
    })
    const first = fingerprintPrefix(input)
    const reorderedTools = fingerprintPrefix({ ...input, toolDefinitions: [...input.toolDefinitions].reverse() })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(same).toBe(first)
    expect(reorderedTools).not.toBe(first)
    expect(fingerprintPrefix({ ...input, binding: binding({ accountScope: undefined }) })).toBeNull()
    expect(fingerprintPrefix({ ...input, prefix: { type: "image", data: "opaque" } })).toBeNull()
    expect(fingerprintPrefix({ ...input, binding: binding({ endpoint: "not-a-url" }) })).toBeNull()
  })

  test("keeps existing provider annotations in one reusable function", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "user", content: "request" },
    ]
    const result = applyLegacyCaching(messages, model)

    expect(result[0]?.providerOptions).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } })
    expect(result[1]?.providerOptions).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } })
  })

  test("distinguishes observed zero from unavailable cache metrics", () => {
    expect(
      normalizeCacheObservation({ inputTokens: 10_000, readTokens: 8_000, writeTokens: 0, observedAtMs: 100 }),
    ).toEqual({
      inputTokens: 10_000,
      readTokens: 8_000,
      writeTokens: 0,
      hitRatio: 0.8,
      observedAtMs: 100,
      state: "hit_observed",
      expiresAtMs: null,
    })
    expect(normalizeCacheObservation({ inputTokens: 10_000, readTokens: 0, observedAtMs: 100 })).toMatchObject({
      state: "miss_observed",
      hitRatio: 0,
    })
    expect(normalizeCacheObservation({ inputTokens: 10_000, observedAtMs: 100 })).toMatchObject({
      state: "unknown",
      readTokens: null,
      hitRatio: null,
    })
    expect(
      normalizeCacheObservation({ inputTokens: 10, readTokens: 11, writeTokens: 12, observedAtMs: 100 }),
    ).toMatchObject({
      state: "unknown",
      readTokens: null,
      writeTokens: null,
    })
    expect(() => normalizeCacheObservation({ observedAtMs: -1 })).toThrow(RangeError)
  })

  test("allows only verified passive bindings in smart mode", () => {
    expect(
      resolveCacheRequestPolicy({
        config: { mode: "smart" },
        binding: binding(),
      }),
    ).toMatchObject({ mode: "smart", useCacheKey: true, allowManagedKey: true, adapterID: "openai" })
    expect(
      resolveCacheRequestPolicy({
        config: { mode: "smart" },
        binding: binding({ auth: "oauth", transport: "responses-lite" }),
      }),
    ).toMatchObject({ mode: "smart", useCacheKey: true, allowManagedKey: false, adapterID: "openai" })
    expect(
      resolveCacheRequestPolicy({
        config: { mode: "smart" },
        binding: binding({ auth: "oauth", transport: "responses-lite", endpoint: "https://example.invalid" }),
      }),
    ).toMatchObject({ mode: "smart", useCacheKey: false })
    expect(
      resolveCacheRequestPolicy({
        config: { mode: "off" },
        binding: binding(),
      }),
    ).toMatchObject({ mode: "off", useCacheKey: false, allowManagedKey: false, useLegacyAnnotations: false })
  })
})
