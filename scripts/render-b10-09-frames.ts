import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB1009Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-09-frames-"))
  const key = "fixture-cerebras-never-print"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      let failed = false
      let viaEnv = false
      const variants = { high: { parameters: { reasoning_effort: "high" } } }
      const provider: ProviderInfo = { id: "cerebras", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", enabled: false, hasKey: true, source: "config", models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B", context: 131_072, variants }] }
      const report: ModelsReport = { ...REPORT, models: [{ id: "cerebras:gpt-oss-120b", name: "GPT OSS 120B · Cerebras", provider: "cerebras", efforts: ["low", "medium", "high"], contextWindow: 131_072, variants }], defaults: { model: "cerebras:gpt-oss-120b" }, effective: { model: "cerebras:gpt-oss-120b" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { cerebras: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") {
          provider.enabled = command.enabled === true
          viaEnv = command.apiKeyEnv !== undefined
          return { ok: true, result: { provider } }
        }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "gpt-oss-120b", ...(failed ? { error: `[AUTH]: cerebras HTTP 401; rejected ${viaEnv ? "[redacted:api-key]" : key}` } : {}) } }
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
      for (let index = 0; index < CONNECT_CHOICES.indexOf("cerebras"); index++) await h.type("\x1b[B")
      save("connect-cerebras-selected", "Cerebras")
      await h.type("\r")
      save("connect-cerebras-form", "API key")
      await h.type("\x15https://api.cerebras.ai/v1\x05\r")
      save("connect-cerebras-invalid-endpoint", "enter a loopback Cerebras proxy URL")
      await h.type(`\x15${provider.baseUrl}\x05`)
      await h.type(key)
      save("connect-cerebras-masked", "chars")
      await h.type("\x05")
      save("connect-cerebras-environment", "CEREBRAS_API_KEY")
      await h.type("\r")
      save("connect-cerebras-connected", "Cerebras connected")
      await h.type("r")
      save("connect-cerebras-refreshed", "model loaded")
      await h.type("m")
      save("model-cerebras", "cerebras:gpt-oss-120b")
      await h.type("/")
      save("model-cerebras-picker", "GPT OSS 120B")
      await h.type("\r")
      save("model-cerebras-variants", "high")
      await h.type("\x1b[B")
      await h.type("\r")
      await h.type("\x1b")
      await h.run("/providers")
      save("providers-cerebras", "Cerebras")
      await h.type("\r")
      save("providers-cerebras-details", "127.0.0.1:1234/v1")
      await h.type("e")
      save("providers-cerebras-off", "off")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect cerebras")
      await h.type("\t")
      await h.type(key)
      failed = true
      await h.type("\r")
      save("connect-cerebras-failed", "test failed")
      await h.type("e")
      save("connect-cerebras-retry", "required")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect cerebras")
      await h.type("\x05\r")
      save("connect-cerebras-env-failed", "test failed")
      await h.type("t")
      await h.type("e")
      save("connect-cerebras-env-retry", "CEREBRAS_API_KEY")
      await h.type("\x05")
      save("connect-cerebras-env-retry-key", "required")
      await h.type("\x1b")
      await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
