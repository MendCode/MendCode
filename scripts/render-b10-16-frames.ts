import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { GATEWAY_MODELS, GATEWAY_TOKEN, GATEWAY_URL } from "../packages/engine-native/test/llmgateway-fixtures"

export async function renderB1016Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-16-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let removed = false
      const provider: ProviderInfo = { id: "llmgateway", type: "openai-compatible", baseUrl: GATEWAY_URL, enabled: false, hasKey: true, source: "config", models: GATEWAY_MODELS }
      const report = { ...REPORT, models: GATEWAY_MODELS.map((model) => ({ id: `llmgateway:${model.id}`, name: `${model.name} · LLMGateway`, provider: "llmgateway", efforts: [] })), defaults: { model: "llmgateway:reasoning-fixture" }, effective: { model: "llmgateway:reasoning-fixture" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: removed ? [] : [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { llmgateway: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${GATEWAY_TOKEN}` } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "reasoning-fixture" } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.remove") { removed = true; return { ok: true, result: { providers: [] } } }
        if (command.type === "models.list") return { ok: true, result: report }
        if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(GATEWAY_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("llmgateway"); index++) await h.type("\x1b[B")
      save("connect-llmgateway-selected")
      await h.type("\r"); save("connect-llmgateway-proxy")
      await h.type(GATEWAY_URL); await h.type("\r"); await h.type(GATEWAY_TOKEN); save("connect-llmgateway-masked")
      await h.type("\x05"); save("connect-llmgateway-environment")
      await h.type("\r"); save("connect-llmgateway-connected")
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} LLMGateway`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-llmgateway-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-llmgateway-refreshed")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing LLMGateway"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-llmgateway-refreshing", refreshing)
      await h.type("m"); save("model-llmgateway")
      await h.type("/"); await h.type("fixture"); save("model-llmgateway-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-llmgateway-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-llmgateway")
      await h.type("\r"); save("providers-llmgateway-details")
      await h.type("\x1b"); await h.type("e"); save("providers-llmgateway-off")
      await h.type("d"); save("providers-llmgateway-remove")
      await h.type("y"); save("providers-llmgateway-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.refresh", "refresh-failed"], ["providers.test", "test-failed"]]) {
        await h.run("/connect llmgateway"); await h.type(GATEWAY_URL); await h.type("\r"); await h.type(GATEWAY_TOKEN)
        failed = phase; await h.type("\r"); save(`connect-llmgateway-${name}`)
        failed = undefined
        if (phase === "providers.refresh") {
          await h.type("r"); save("connect-llmgateway-refresh-retry")
          await h.type("t"); save("connect-llmgateway-test-retry")
        }
        if (phase !== "providers.set") { await h.type("e"); save(`connect-llmgateway-edit-${name}`) }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run("/connect llmgateway"); await h.type("https://api.llmgateway.io/v1"); await h.type("\x05"); await h.type("\r"); save("connect-llmgateway-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
