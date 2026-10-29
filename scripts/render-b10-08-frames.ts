import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB1008Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-08-frames-"))
  const key = "fixture-deepinfra-never-print"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      let failed = false
      let viaEnv = false
      const variants = { max: { parameters: { reasoning_effort: "max" } } }
      const provider: ProviderInfo = { id: "deepinfra", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1/openai", enabled: false, hasKey: true, source: "config", models: [{ id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash", context: 131_072, variants }] }
      const report: ModelsReport = { ...REPORT, models: [{ id: "deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash · DeepInfra", provider: "deepinfra", efforts: ["low", "medium", "high"], contextWindow: 131_072, variants }], defaults: { model: "deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731" }, effective: { model: "deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { deepinfra: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") {
          provider.enabled = command.enabled === true
          viaEnv = command.apiKeyEnv !== undefined
          return { ok: true, result: { provider } }
        }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "deepseek-ai/DeepSeek-V4-Flash-0731", ...(failed ? { error: `[AUTH]: deepinfra HTTP 401; rejected ${viaEnv ? "[redacted:api-key]" : key}` } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list" || command.type === "session.model.set") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string, expected: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        const text = rows.join("\n")
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || text.includes(key)) throw new Error(`Invalid frame ${name} ${size}`)
        if (!text.includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("deepinfra"); index++) await h.type("\x1b[B")
      save("connect-deepinfra-selected", "DeepInfra")
      await h.type("\r")
      save("connect-deepinfra-form", "API key")
      await h.type("\x15https://api.deepinfra.com/v1/openai\x05\r")
      save("connect-deepinfra-invalid-endpoint", "enter a loopback DeepInfra proxy URL")
      await h.type(`\x15${provider.baseUrl}\x05`)
      await h.type(key)
      save("connect-deepinfra-masked", "chars")
      await h.type("\x05")
      save("connect-deepinfra-environment", "DEEPINFRA_API_KEY")
      await h.type("\r")
      save("connect-deepinfra-connected", "DeepInfra connected")
      await h.type("r")
      save("connect-deepinfra-refreshed", "model loaded")
      await h.type("m")
      save("model-deepinfra", "deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731")
      await h.type("/")
      save("model-deepinfra-picker", "DeepSeek V4 Flash")
      await h.type("\r")
      save("model-deepinfra-variants", "max")
      await h.type("\x1b[B")
      await h.type("\r")
      await h.type("\x1b")
      await h.run("/providers")
      save("providers-deepinfra", "DeepInfra")
      await h.type("\r")
      save("providers-deepinfra-details", "127.0.0.1:1234/v1/openai")
      await h.type("e")
      save("providers-deepinfra-off", "off")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect deepinfra")
      await h.type("\t")
      await h.type(key)
      failed = true
      await h.type("\r")
      save("connect-deepinfra-failed", "test failed")
      await h.type("e")
      save("connect-deepinfra-retry", "required")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect deepinfra")
      await h.type("\x05\r")
      save("connect-deepinfra-env-failed", "test failed")
      await h.type("t")
      await h.type("e")
      save("connect-deepinfra-env-retry", "DEEPINFRA_API_KEY")
      await h.type("\x05")
      save("connect-deepinfra-env-retry-key", "required")
      await h.type("\x1b")
      await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
