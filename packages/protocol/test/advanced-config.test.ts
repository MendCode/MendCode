import { expect, test } from "bun:test"
import { Command, Settings, createIdFactory } from "../src"

test("advanced config accepts donor model maps, flat variants, auxiliary roles and agent options", () => {
  const settings = Settings.parse({
    $schema: "https://example.test/config.json", shell: "/bin/zsh", watcher: { ignore: ["**/generated/**"] },
    disabled_models: ["local/retired"], enabled_providers: ["local"], subagent_variant: "fast",
    default_agent: "reviewer", plan_exit_agent: "reviewer", tool_output: { max_lines: 10, max_bytes: 1024 },
    models: { title: { model: "local:fast" }, summary: { model: "local:large" } },
    agent: { build: { temperature: 0.4, top_p: 0.9, steps: 3, maxSteps: 5, color: "#22cc88", options: { seed: 4 }, hidden: false } },
    provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:9999/v1", timeout: false, chunkTimeout: 400, temperature: 0.2 }, whitelist: ["fast"], models: { fast: { name: "Fast", cost: { input: 1, output: 3 }, limit: { context: 64000, output: 4096 }, modalities: { input: ["text"], output: ["text"] }, status: "beta", headers: { "X-Route": "fast" }, variants: { fast: { temperature: 0.3, effort: "low" }, retired: { disabled: true } } } } } },
  })
  expect(settings.provider?.local?.models?.[0]).toMatchObject({ id: "fast", variants: { fast: { parameters: { temperature: 0.3 } } } })
  expect(settings.models?.summary?.model).toBe("local:large")
})

test("advanced config rejects invalid bounds and parameters that replace transport or conversation", () => {
  for (const value of [{ tool_output: { max_lines: 0 } }, { agent: { build: { steps: 0 } } }, { agent: { build: { color: "blue-ish" } } }, { provider: { local: { timeout: 0 } } }, { provider: { local: { headers: { "X-Bad": "a\r\nb" } } } }, { agent: { build: { options: { messages: [] } } } }, { provider: { local: { models: [{ id: "x", variants: { attack: { headers: {} } } }] } } }]) expect(Settings.safeParse(value).success).toBe(false)
})

test("provider commands retain additive timeouts, filters and generation defaults", () => {
  const ids = createIdFactory()
  expect(Command.parse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "local", providerType: "openai-compatible", baseUrl: "http://localhost:9999", timeout: false, chunkTimeout: 120, parameters: { seed: 3 }, blacklist: ["old"] })).toMatchObject({ timeout: false, parameters: { seed: 3 } })
})

test("variant parameters require a JSON mapping even with flat donor fields", () => {
  for (const parameters of ["oops", [1, 2], null]) expect(Settings.safeParse({ provider: { local: { models: [{ id: "fast", variants: { quick: { parameters, temperature: 0.3 } } }] } } }).success).toBe(false)
})
