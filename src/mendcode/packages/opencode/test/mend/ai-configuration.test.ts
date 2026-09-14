import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { tmpdir } from "../fixture/fixture"
import { inspectConfiguration, planConfiguration, validateConfiguration } from "@/mend/runtime/ai-configuration"
import type { Provider } from "@/provider/provider"
import { Auth } from "@/auth"

function model(providerID: string, modelID: string, input: number, output: number, npm = "@ai-sdk/openai-compatible") {
  return {
    id: modelID,
    providerID,
    api: { id: modelID, url: "https://models.example.test/v1", npm },
    name: `${providerID} ${modelID}`,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input, output, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, input: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: {},
  } as unknown as Provider.Model
}

function provider(id: string, item: Provider.Model, source: Provider.Info["source"] = "api", key?: string) {
  return {
    id,
    name: id,
    source,
    env: [],
    ...(key ? { key } : {}),
    options: {},
    models: { [item.id]: item },
  } as unknown as Provider.Info
}

function snapshot(root: string) {
  const primary = model("alpha", "fast", 1, 2)
  const unknown = model("beta", "unknown", 0, 0)
  return {
    root,
    config: {} as never,
    providers: {
      alpha: provider("alpha", primary, "api", "secret-alpha"),
      beta: provider("beta", unknown, "custom"),
    },
    auth: { alpha: new Auth.Api({ type: "api", key: "secret-alpha" }) },
    roles: {
      build: { providerID: "alpha", modelID: "fast", variant: null, authMode: "api", configured: true },
    },
    observedAt: "2026-09-07T00:00:00.000Z",
  }
}

describe("AI configuration advisor", () => {
  test("exposes redacted actual inventory and preserves unknown pricing", async () => {
    await using tmp = await tmpdir()
    const result = await inspectConfiguration(snapshot(tmp.path))
    expect(result.models.map((item) => `${item.providerID}/${item.modelID}`)).toEqual(["alpha/fast", "beta/unknown"])
    const unknown = result.models.find((item) => item.providerID === "beta")!
    expect(unknown.pricing.inputUsdPer1M).toBeNull()
    expect(unknown.pricing.outputUsdPer1M).toBeNull()
    expect(JSON.stringify(result)).not.toContain("secret-alpha")
    expect(result.missingInformation.join(" ")).toContain("quality")
  })

  test("plans only from the caller allowlist and validates the generated patch", async () => {
    await using tmp = await tmpdir()
    const input = snapshot(tmp.path)
    const candidates = [
      { providerID: "alpha", modelID: "fast" },
      { providerID: "beta", modelID: "unknown" },
    ]
    const planned = await planConfiguration(input, {
      candidates,
      intent: "balanced",
      taskKind: "repair",
      profileName: "repair-balanced",
    })
    const allowed = new Set(candidates.map((item) => `${item.providerID}/${item.modelID}`))
    for (const item of planned.alternatives) {
      expect(allowed.has(`${"role" in item.primary ? item.primary.role : item.primary.providerID}/${"role" in item.primary ? "" : item.primary.modelID}`)).toBe(true)
    }
    expect(planned.evidence.quality).toBe("unknown")
    const validation = await validateConfiguration(input, { patch: planned.patch })
    expect(validation.valid).toBe(true)
    expect(validation.warnings.length).toBeGreaterThan(0)
  })

  test("returns a digest for a no-write preview target", async () => {
    await using tmp = await tmpdir()
    const planned = await planConfiguration(snapshot(tmp.path), {
      candidates: [{ providerID: "alpha", modelID: "fast" }],
      intent: "economical",
      taskKind: "general",
    })
    expect(planned.target?.path).toBe(`${tmp.path}/mendcode.jsonc`)
    expect(planned.expectedHash).toBe(createHash("sha256").update("").digest("hex"))
  })
})
