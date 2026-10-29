import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App-harness frames, a temporary data directory and local replies only. No credential discovery. */
export async function renderB1004Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-04-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "google-vertex", type: "google-vertex", baseUrl: "https://aiplatform.googleapis.com/v1", enabled: false, hasKey: false, authReady: true, source: "config", models: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", effort: true, images: true }], vertex: { project: "team-project", location: "global", tokenEnv: "TEAM_TOKEN", allowMetadata: false } }
      const report = { ...REPORT, models: [{ id: "google-vertex:gemini-2.5-flash", name: "Gemini 2.5 Flash · Google Vertex AI", provider: "google-vertex", efforts: ["low", "medium", "high"] }], defaults: { model: "google-vertex:gemini-2.5-flash" }, effective: { model: "google-vertex:gemini-2.5-flash" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "google-vertex": [{ id: "adc", type: "api", label: "Google Application Default Credentials", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; if (command.vertex) provider.vertex = command.vertex as ProviderInfo["vertex"]; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "gemini-2.5-flash", ...(failed ? { error: "[AUTH]: Vertex ADC credential file is unreadable or oversized" } : {}) } }
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
      for (let i = 0; i < CONNECT_CHOICES.indexOf("google-vertex"); i++) await h.type("\x1b[B")
      save("connect-vertex-selected", "Google Vertex AI")
      await h.type("\r"); save("connect-vertex-adc-form", "team-project")
      for (let i = 0; i < 5; i++) await h.type("\t")
      await h.type("\x1b[C"); save("connect-vertex-metadata-opt-in", "Metadata")
      await h.type("\x1b[D"); await h.type("\t"); await h.type("\r")
      save("connect-vertex-connected", "test ok")
      await h.type("r"); save("connect-vertex-catalog", "publisher model retained")
      await h.type("m"); save("model-vertex", "gemini-2.5-flash")
      await h.type("\x1b"); await h.run("/providers"); save("providers-vertex", "Google Vertex AI")
      await h.type("\r"); save("providers-vertex-details", "ADC")
      await h.type("e"); save("providers-vertex-off", "off")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect vertex")
      for (let i = 0; i < 6; i++) await h.type("\t")
      failed = true
      await h.type("\r"); save("connect-vertex-failed", "saved, test failed")
      await h.type("e"); save("connect-vertex-retry", "team-project")
      await h.type("\x15"); await h.type("../escape")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("\r"); save("connect-vertex-invalid", "invalid GCP project")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
