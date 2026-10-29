import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export const AZURE_METHODS: ProviderAuthMethod[] = [{ id: "api-key", type: "api", label: "API key", available: true }, { id: "entra", type: "api", label: "Microsoft Entra ID (environment)", available: true }]

/** Native app frames with a temporary data directory and injected replies; no service or credential discovery. */
export async function renderB1002Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-02-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "azure", type: "azure", baseUrl: "https://team-models.openai.azure.com/openai", enabled: false, hasKey: false, source: "config", models: [{ id: "team-coder", name: "Team coder", effort: true, images: true }], azure: { auth: "api-key" } }
      const report = { ...REPORT, models: [{ id: "azure:team-coder", name: "Team coder · Azure OpenAI", provider: "azure", efforts: ["low", "medium", "high"] }], defaults: { model: "azure:team-coder" }, effective: { model: "azure:team-coder" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { azure: AZURE_METHODS } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; if (command.azure) provider.azure = command.azure as ProviderInfo["azure"]; provider.hasKey = provider.azure?.auth !== "entra"; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "team-coder", ...(failed ? { error: "[AUTH]: Azure 401 rejected credentials" } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes("never-print")) throw new Error(`Invalid frame ${name} ${size}`)
        const expected = name.endsWith("connected") ? "test ok" : name.endsWith("failed") ? "saved, test failed" : name === "connect-azure-deployments" ? "deployment configured" : name === "connect-azure-methods" ? "Microsoft Entra" : undefined
        if (expected && !rows.join("\n").includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("azure"); i++) await h.type("\x1b[B")
      save("connect-azure-selected")
      await h.type("\r"); save("connect-azure-methods")
      await h.type("\r"); save("connect-azure-key-form")
      for (let i = 0; i < 5; i++) await h.type("\t")
      await h.type("fixture-never-print"); save("connect-azure-masked")
      await h.type("\x05"); save("connect-azure-key-environment")
      await h.type("\r"); save("connect-azure-connected")
      await h.type("r"); save("connect-azure-deployments")
      await h.type("m"); save("model-azure")
      await h.type("\x1b"); await h.run("/providers"); save("providers-azure")
      await h.type("\r"); save("providers-azure-details")
      await h.type("e"); save("providers-azure-off")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect azure")
      await h.type("\x1b[B"); await h.type("\r"); save("connect-azure-entra-form")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("\r"); save("connect-azure-entra-connected")
      await h.type("\x1b"); await h.run("/providers"); await h.type("\r"); save("providers-azure-entra")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect azure"); await h.type("\r")
      for (let i = 0; i < 5; i++) await h.type("\t")
      await h.type("fixture-never-print"); await h.type("\t")
      failed = true
      await h.type("\r"); save("connect-azure-failed")
      await h.type("e"); save("connect-azure-retry")
      for (let i = 0; i < 2; i++) await h.type("\t")
      await h.type("\x15"); await h.type("2024-10-21"); await h.type("\t"); await h.type("\x1b[C"); await h.type("\t"); await h.type("\x1b[C")
      save("connect-azure-legacy-form")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
