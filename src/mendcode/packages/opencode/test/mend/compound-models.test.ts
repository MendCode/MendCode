import { describe, expect, test } from "bun:test"

import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resolveCompoundProfile, resolveCompoundProfiles } from "../../src/mend/config/compound-models"

function model(providerID: string, modelID: string, variants: Record<string, Record<string, unknown>> = {}) {
  return {
    id: modelID,
    providerID,
    api: { id: modelID, url: `https://${providerID}.example.test`, npm: "@ai-sdk/openai-compatible" },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
    limit: { context: 100_000, input: 90_000, output: 10_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants,
  } as Provider.Model
}

function provider(id: string, entries: Record<string, Provider.Model>) {
  return {
    id,
    name: id,
    source: "custom",
    env: [],
    options: {},
    models: entries,
  } as unknown as Provider.Info
}

const inventory = [
  provider("alpha", {
    fast: model("alpha", "fast", { medium: {} }),
    strong: model("alpha", "strong"),
  }),
  provider("beta", { reviewer: model("beta", "reviewer") }),
]

const limits = {
  maxModelRequests: 4,
  maxTotalTokens: 20_000,
  maxRuntimeMs: 120_000,
  unknownCost: "block" as const,
}

describe("compound model resolution", () => {
  test("resolves direct and role references without mixing fields", () => {
    const result = resolveCompoundProfile(
      "cost-conscious",
      {
        strategy: "cascade",
        primary: { providerID: "alpha", modelID: "fast", variant: "medium" },
        escalation: { role: "build" },
        limits,
      },
      inventory,
      { build: { providerID: "alpha", modelID: "strong", authMode: "api-key" } },
    )
    expect(result.issues).toEqual([])
    expect(result.profile?.primary.providerID).toBe(ProviderID.make("alpha"))
    expect(result.profile?.primary.variant).toBe("medium")
    expect(result.profile?.escalation?.modelID).toBe(ModelID.make("strong"))
    expect(result.profile?.snapshot.primary).toMatchObject({ providerID: "alpha", modelID: "fast" })
    expect(result.profile?.configHash).toBeString()
  })

  test("rejects unknown refs, mixed refs, irrelevant legs and same-model critics", () => {
    const result = resolveCompoundProfile(
      "critic",
      {
        strategy: "critic",
        primary: { role: "build", providerID: "alpha", modelID: "fast" } as never,
        escalation: { providerID: "alpha", modelID: "strong" },
        critic: { providerID: "alpha", modelID: "strong" },
        limits,
      },
      inventory,
      { build: { providerID: "alpha", modelID: "fast" } },
    )
    expect(result.profile).toBeUndefined()
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["invalid-model-ref", "irrelevant-escalation"]),
    )

    const same = resolveCompoundProfile(
      "critic",
      {
        strategy: "critic",
        primary: { providerID: "alpha", modelID: "fast" },
        critic: { providerID: "alpha", modelID: "fast" },
        limits,
      },
      inventory,
    )
    expect(same.issues.map((item) => item.code)).toContain("critic-must-differ")
  })

  test("applies a maximum profile count and preserves atomic snapshots", () => {
    const profiles = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `profile-${index}`,
        { strategy: "single" as const, primary: { providerID: "alpha", modelID: "fast" }, limits },
      ]),
    )
    const result = resolveCompoundProfiles(
      { version: 1, orchestration: { enabled: true, profiles } },
      inventory,
    )
    expect(result.issues.map((item) => item.code)).toContain("too-many-profiles")
    expect(Object.keys(result.profiles)).toHaveLength(17)
    expect(result.profiles["profile-0"]?.snapshot.primary.providerID).toBe("alpha")
  })
})
