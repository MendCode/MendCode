import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App factories, temporary data and injected replies; no provider or network. */
export async function renderB1011Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-11-frames-"))
  const key = "togetherai-fixture-never-print-0123456789"
  const endpoint = "http://127.0.0.1:1234/v1"
  const model = "openai/gpt-oss-120b"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "togetherai", type: "openai-compatible", baseUrl: endpoint, enabled: false, hasKey: true, source: "config", models: [{ id: model, images: false, tool_call: true, effort: true, variants: { high: { effort: "high" } } }] }
      const report: ModelsReport = { ...REPORT, models: [{ id: `togetherai:${model}`, name: "GPT-OSS 120B", provider: "togetherai", efforts: ["low", "medium", "high"], variants: { high: { effort: "high" } } }], defaults: { model: `togetherai:${model}` }, effective: { model: `togetherai:${model}` } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { togetherai: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model, ...(failed ? { error: `[AUTH]: rejected ${key}` } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: { ...report, models: provider.enabled ? report.models : [] } }
        if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
        return undefined
      } })
      const save = (name: string, expected: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain), text = rows.join("\n")
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || text.includes(key)) throw new Error(`Invalid frame ${name} ${size}`)
        if (!text.includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("togetherai"); i++) await h.type("\x1b[B")
      save("connect-togetherai-selected", "TogetherAI")
      await h.type("\r"); save("connect-togetherai-proxy", "Proxy URL")
      await h.type(endpoint); await h.type("\r"); await h.type(key); save("connect-togetherai-masked", "chars")
      await h.type("\x05"); save("connect-togetherai-environment", "TOGETHER_API_KEY")
      await h.type("\r"); save("connect-togetherai-connected", "TogetherAI connected")
      for (const phase of ["Saving", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} TogetherAI…`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-togetherai-${phase.toLowerCase()}`, phase, frame)
      }
      await h.type("r"); save("connect-togetherai-refreshed", "model loaded")
      await h.type("m"); save("model-togetherai", "togetherai:")
      await h.type("/"); save("model-togetherai-picker", "GPT-OSS 120B")
      await h.type("\r"); save("model-togetherai-variants", "high")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/providers"); save("providers-togetherai", "TogetherAI")
      await h.type("\r"); save("providers-togetherai-details", "TogetherAI")
      await h.type("e"); save("providers-togetherai-off", "off")
      await h.type("d"); save("providers-togetherai-remove", "remove"); await h.type("n")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect togetherai"); await h.type(endpoint); await h.type("\r"); await h.type(key)
      failed = true; await h.type("\r"); save("connect-togetherai-failed", "test failed")
      await h.type("e"); save("connect-togetherai-edit", "required")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect togetherai"); await h.type("https://api.together.ai/v1"); await h.type("\x05"); await h.type("\r"); save("connect-togetherai-blocked", "loopback")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
