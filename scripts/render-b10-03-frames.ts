import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** Real app renderer, explicit temporary data, injected daemon replies and no HTTP. */
export async function renderB1003Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-03-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "google", type: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", enabled: false, hasKey: true, source: "config", models: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_048_576, effort: true, images: true }] }
      const report = { ...REPORT, models: [{ id: "google:gemini-2.5-flash", name: "Gemini 2.5 Flash · Google Gemini", provider: "google", efforts: ["low", "medium", "high"], contextWindow: 1_048_576 }], defaults: { model: "google:gemini-2.5-flash" }, effective: { model: "google:gemini-2.5-flash" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { google: [{ id: "api-key", label: "API key", type: "api", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "gemini-2.5-flash", ...(failed ? { error: "[AUTH]: Google Gemini 401 rejected the API key" } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes("never-print")) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < 10; i++) await h.type("\x1b[B")
      save("connect-google-selected")
      await h.type("\r"); save("connect-google-key")
      await h.type("fixture-never-print"); save("connect-google-masked")
      await h.type("\x05"); save("connect-google-environment")
      await h.type("\r"); save("connect-google-connected")
      await h.type("r"); save("connect-google-refreshed")
      await h.type("m"); save("model-google")
      await h.type("\x1b"); await h.run("/providers"); save("providers-google")
      await h.type("\r"); save("providers-google-details")
      await h.type("\x1b"); await h.type("e"); save("providers-google-off")
      await h.type("\x1b"); await h.run("/connect google"); await h.type("fixture-never-print")
      failed = true; await h.type("\r"); save("connect-google-failed")
      await h.type("\x1b"); await h.run("/connect custom"); await h.type("local-gemini"); await h.type("\t")
      for (let i = 0; i < 3; i++) await h.type("\x1b[C")
      save("connect-custom-google")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
