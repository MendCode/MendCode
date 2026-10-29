import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB1007Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-07-frames-"))
  const key = "fixture-mistral-never-print"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      let failed = false
      const variants = { high: { effort: "high" as const, parameters: { reasoningEffort: "high" } } }
      const provider: ProviderInfo = { id: "mistral", type: "mistral", baseUrl: "https://api.mistral.ai/v1", enabled: false, hasKey: true, source: "config", models: [{ id: "mistral-small-latest", name: "Mistral Small", context: 131_072, variants }] }
      const report: ModelsReport = { ...REPORT, models: [{ id: "mistral:mistral-small-latest", name: "Mistral Small · Mistral", provider: "mistral", efforts: ["high"], contextWindow: 131_072, variants }], defaults: { model: "mistral:mistral-small-latest" }, effective: { model: "mistral:mistral-small-latest" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { mistral: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") {
          provider.enabled = command.enabled === true
          return { ok: true, result: { provider } }
        }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "mistral-small-latest", ...(failed ? { error: `[AUTH]: mistral HTTP 401; rejected ${key}` } : {}) } }
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
      for (let index = 0; index < CONNECT_CHOICES.indexOf("mistral"); index++) await h.type("\x1b[B")
      save("connect-mistral-selected", "Mistral")
      await h.type("\r")
      save("connect-mistral-form", "API key")
      await h.type(key)
      save("connect-mistral-masked", "chars")
      await h.type("\x05")
      save("connect-mistral-environment", "MISTRAL_API_KEY")
      await h.type("\r")
      save("connect-mistral-connected", "Mistral connected")
      await h.type("r")
      save("connect-mistral-refreshed", "model loaded")
      await h.type("m")
      save("model-mistral", "mistral:mistral-small-latest")
      await h.type("/")
      save("model-mistral-picker", "Mistral Small")
      await h.type("\r")
      save("model-mistral-variants", "high")
      await h.type("\x1b[B")
      await h.type("\r")
      await h.type("\x1b")
      await h.run("/providers")
      save("providers-mistral", "Mistral")
      await h.type("\r")
      save("providers-mistral-details", "api.mistral.ai/v1")
      await h.type("e")
      save("providers-mistral-off", "off")
      await h.type("\x1b")
      await h.type("\x1b")
      await h.run("/connect mistral")
      await h.type(key)
      failed = true
      await h.type("\r")
      save("connect-mistral-failed", "test failed")
      await h.type("e")
      save("connect-mistral-retry", "required")
      await h.type("\x1b")
      await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
