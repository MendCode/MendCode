import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB1010Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-10-frames-"))
  const key = "fixture-cohere-never-print"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      let failed = false
      let viaEnv = false
      const provider: ProviderInfo = { id: "cohere", type: "cohere", baseUrl: "http://127.0.0.1:1234/v2", enabled: false, hasKey: true, source: "config", models: [{ id: "command-a-03-2025", name: "Command A", context: 256_000 }] }
      const report: ModelsReport = { ...REPORT, models: [{ id: "cohere:command-a-03-2025", name: "Command A · Cohere", provider: "cohere", efforts: [], contextWindow: 256_000 }], defaults: { model: "cohere:command-a-03-2025" }, effective: { model: "cohere:command-a-03-2025" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { cohere: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") {
          provider.enabled = command.enabled === true
          viaEnv = command.apiKeyEnv !== undefined
          return { ok: true, result: { provider } }
        }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "command-a-03-2025", ...(failed ? { error: `[AUTH]: cohere HTTP 401; rejected ${viaEnv ? "[redacted:api-key]" : key}` } : {}) } }
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
      for (let index = 0; index < CONNECT_CHOICES.indexOf("cohere"); index++) await h.type("\x1b[B")
      save("connect-cohere-selected", "Cohere")
      await h.type("\r")
      save("connect-cohere-form", "API key")
      await h.type("\x15https://api.cohere.com/v2\x05\r")
      save("connect-cohere-invalid-endpoint", "enter a loopback Cohere proxy URL")
      await h.type(`\x15${provider.baseUrl}\x05`)
      await h.type(key)
      save("connect-cohere-masked", "chars")
      await h.type("\x05")
      save("connect-cohere-environment", "COHERE_API_KEY")
      await h.type("\r")
      save("connect-cohere-connected", "Cohere connected")
      await h.type("r")
      save("connect-cohere-refreshed", "model loaded")
      await h.type("m")
      save("model-cohere", "cohere:command-a-03-2025")
      await h.type("/")
      save("model-cohere-picker", "Command A")
      await h.type("\r")
      save("model-cohere-selected", "cohere:command-a-03-2025")
      await h.type("\x1b")
      await h.run("/providers")
      save("providers-cohere", "Cohere")
      await h.type("\r")
      save("providers-cohere-details", "127.0.0.1:1234/v2")
      await h.type("e")
      save("providers-cohere-off", "off")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect cohere")
      await h.type("\t")
      await h.type(key)
      failed = true
      await h.type("\r")
      save("connect-cohere-failed", "test failed")
      await h.type("e")
      save("connect-cohere-retry", "required")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect cohere")
      await h.type("\x05\r")
      save("connect-cohere-env-failed", "test failed")
      await h.type("t")
      await h.type("e")
      save("connect-cohere-env-retry", "COHERE_API_KEY")
      await h.type("\x05")
      save("connect-cohere-env-retry-key", "required")
      await h.type("\x1b")
      await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
