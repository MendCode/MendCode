import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App-harness frames, a temporary data directory and local replies only. No credential discovery. */
export async function renderB1005Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-05-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "google-vertex-anthropic", type: "google-vertex-anthropic", baseUrl: "https://aiplatform.googleapis.com/v1", enabled: false, hasKey: false, authReady: true, source: "config", models: [{ id: "claude-haiku-4-5@20251001", name: "Claude Haiku 4.5", effort: true, images: true }], vertex: { project: "team-project", location: "global", tokenEnv: "TEAM_TOKEN", allowMetadata: false } }
      const report = { ...REPORT, models: [{ id: "google-vertex-anthropic:claude-haiku-4-5@20251001", name: "Claude Haiku 4.5 · Vertex Anthropic", provider: "google-vertex-anthropic", efforts: ["low", "medium", "high"] }], defaults: { model: "google-vertex-anthropic:claude-haiku-4-5@20251001" }, effective: { model: "google-vertex-anthropic:claude-haiku-4-5@20251001" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "google-vertex-anthropic": [{ id: "adc", type: "api", label: "Google Application Default Credentials", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; if (command.vertex) provider.vertex = command.vertex as ProviderInfo["vertex"]; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "claude-haiku-4-5@20251001", ...(failed ? { error: "[AUTH]: Vertex ADC credential file is unreadable or oversized" } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string, expected?: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`Invalid frame ${name} ${size}`)
        if (expected && !rows.join("\n").includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("google-vertex-anthropic"); i++) await h.type("\x1b[B")
      save("connect-vertex-anthropic-selected", "Vertex Anthropic")
      await h.type("\r"); save("connect-vertex-anthropic-adc-form", "team-project")
      for (let i = 0; i < 5; i++) await h.type("\t")
      await h.type("\x1b[C"); save("connect-vertex-anthropic-metadata-opt-in", "Metadata")
      await h.type("\x1b[D"); await h.type("\t"); await h.type("\r")
      save("connect-vertex-anthropic-connected", "test ok")
      await h.type("r"); save("connect-vertex-anthropic-catalog", "publisher model retained")
      await h.type("m"); save("model-vertex-anthropic", "claude-haiku-4-5@20251001")
      await h.type("\x1b"); await h.run("/providers"); save("providers-vertex-anthropic", "Vertex Anthropic")
      await h.type("\r"); save("providers-vertex-anthropic-details", "ADC")
      await h.type("e"); save("providers-vertex-anthropic-off", "off")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect Vertex Anthropic")
      for (let i = 0; i < 6; i++) await h.type("\t")
      failed = true
      await h.type("\r"); save("connect-vertex-anthropic-failed", "saved, test failed")
      await h.type("e"); save("connect-vertex-anthropic-retry", "team-project")
      await h.type("\x15"); await h.type("../escape")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("\r"); save("connect-vertex-anthropic-invalid", "invalid GCP project")
      await h.type("\x15"); await h.type("team-project")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("\x15"); await h.type("../escape"); await h.type("\r")
      save("connect-vertex-anthropic-invalid-model", "invalid Anthropic model id")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
