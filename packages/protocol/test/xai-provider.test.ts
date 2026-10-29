import { expect, test } from "bun:test"
import { Command, ProviderConfig, ProviderInfo, ProviderType, createIdFactory, isReadOnlyCommand } from "../src"

test("B10.06 xAI is additive in commands, saved config and reports; credentials remain mutations", () => {
  const ids = createIdFactory()
  expect(ProviderType.parse("xai")).toBe("xai")
  for (const type of ["openai", "anthropic", "openai-compatible"]) expect(ProviderType.safeParse(type).success).toBe(true)
  expect(Command.safeParse({ type: "providers.set", id: ids("command"), clientId: ids("client"), provider: "xai-proxy", providerType: "xai", apiKeyEnv: "TEAM_XAI_KEY", enabled: true }).success).toBe(true)
  expect(ProviderConfig.parse({ type: "xai", parameters: { reasoningEffort: "low", topLogprobs: 2 }, models: [{ id: "grok-3-mini", variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } } }] })).toMatchObject({ type: "xai", models: [{ variants: { high: { parameters: { reasoningEffort: "high" } } } }] })
  expect(ProviderInfo.safeParse({ id: "xai", type: "xai", baseUrl: "https://api.x.ai/v1", enabled: false, hasKey: false, source: "config", models: [] }).success).toBe(true)
  for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
