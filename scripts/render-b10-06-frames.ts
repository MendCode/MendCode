import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App-rendered frames with a local daemon fake; no network or real credentials. */
export async function renderB1006Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-06-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "xai", type: "xai", baseUrl: "https://api.x.ai/v1", enabled: false, hasKey: true, source: "config", models: [{ id: "grok-3-mini", name: "Grok 3 Mini", context: 131_072, variants: { low: { effort: "low" }, high: { effort: "high" } } }] }
      const report = { ...REPORT, models: [{ id: "xai:grok-3-mini", name: "Grok 3 Mini · xAI", provider: "xai", efforts: ["low", "high"], contextWindow: 131_072, variants: { low: { effort: "low" as const }, high: { effort: "high" as const } } }], defaults: { model: "xai:grok-3-mini" }, effective: { model: "xai:grok-3-mini" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { xai: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "grok-3-mini", ...(failed ? { error: "[AUTH]: xai HTTP 401; rejected fixture-never-print" } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string, expected: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain), text = rows.join("\n")
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || text.includes("fixture-never-print")) throw new Error(`Invalid frame ${name} ${size}`)
        if (!text.includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("xai"); i++) await h.type("\x1b[B")
      save("connect-xai-selected", "xAI")
      await h.type("\r"); save("connect-xai-form", "API key")
      await h.type("fixture-never-print"); save("connect-xai-masked", "chars")
      await h.type("\x05"); save("connect-xai-environment", "XAI_API_KEY")
      await h.type("\r"); save("connect-xai-connected", "xAI connected")
      await h.type("r"); save("connect-xai-refreshed", "model loaded")
      await h.type("m"); save("model-xai", "xai:grok-3-mini")
      await h.type("/"); save("model-xai-picker", "Grok 3 Mini")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/providers"); save("providers-xai", "xAI")
      await h.type("\r"); save("providers-xai-details", "api.x.ai/v1")
      await h.type("e"); save("providers-xai-off", "off")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect xai")
      await h.type("fixture-never-print"); failed = true
      await h.type("\r"); save("connect-xai-failed", "test failed")
      await h.type("e"); save("connect-xai-retry", "required")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
