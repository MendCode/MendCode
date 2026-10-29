import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { AIG_ID, AIG_MODEL, AIG_MODELS, AIG_TOKEN, AIG_URL } from "../packages/engine-native/test/cloudflare-ai-gateway-fixtures"

export async function renderB1022Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-22-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let configured = false
      const provider: ProviderInfo = { id: AIG_ID, type: "openai-compatible", baseUrl: AIG_URL, enabled: false, hasKey: true, source: "config", models: AIG_MODELS, cloudflareAiGateway: { accountId: "team", gatewayId: "coding", hasMetadata: true, hasCacheKey: true, cacheTtl: 60, collectLog: false } }
      let choice = REPORT.effective
      const report = () => ({ ...REPORT, models: [...REPORT.models.filter((model) => !model.provider), ...(provider.enabled ? AIG_MODELS.map((model) => ({ id: `${AIG_ID}:${model.id}`, name: `${model.name} · Cloudflare AI Gateway`, provider: AIG_ID, efforts: [] })) : [])], effective: choice })
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: configured ? [provider] : [] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { [AIG_ID]: [{ id: "api-key", type: "api", label: "Cloudflare Gateway token", available: true }] } } }
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${AIG_TOKEN}` } }
        if (command.type === "providers.set") { configured = true; provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: AIG_MODEL } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.remove") { configured = false; return { ok: true, result: { providers: [] } } }
        if (command.type === "models.list") return { ok: true, result: report() }
        if (command.type === "session.model.set") { choice = command.choice as typeof choice; return { ok: true, result: report() } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(AIG_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      const fill = async () => {
        await h.type("\x15"); await h.type(AIG_URL); await h.type("\r")
        await h.type(AIG_TOKEN); await h.type("\r")
        await h.type("\x15"); await h.type("team"); await h.type("\r")
        await h.type("\x15"); await h.type("coding"); await h.type("\r")
        await h.type("\x15"); await h.type(AIG_MODEL)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf(AIG_ID); index++) await h.type("\x1b[B")
      save("connect-gateway-selected")
      await h.type("\r"); save("connect-gateway-proxy")
      await h.type(AIG_URL); await h.type("\r"); await h.type(AIG_TOKEN); save("connect-gateway-masked")
      await h.type("\r"); await h.type("team"); save("connect-gateway-account")
      await h.type("\r"); await h.type("coding"); save("connect-gateway-routing")
      await h.type("\r"); await h.type(AIG_MODEL); save("connect-gateway-models")
      await h.type("\x05"); save("connect-gateway-environment")
      // Ctrl+E moves focus after removing the key field; Tab reaches the final models field.
      for (let index = 0; index < 4; index++) await h.type("\t")
      await h.type("\r"); save("connect-gateway-connected")
      for (const phase of ["Saving", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} Cloudflare AI Gateway`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-gateway-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-gateway-retained")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing Cloudflare AI Gateway"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-gateway-refreshing", refreshing)
      await h.type("m"); save("model-gateway")
      await h.type("/"); await h.type(AIG_MODEL); save("model-gateway-picker")
      await h.type("\r"); save("model-gateway-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-gateway")
      await h.type("\r"); save("providers-gateway-details")
      await h.type("\x1b"); await h.type("e"); save("providers-gateway-off")
      await h.type("d"); save("providers-gateway-remove")
      await h.type("y"); save("providers-gateway-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.test", "test-failed"]]) {
        await h.run(`/connect ${AIG_ID}`); await fill()
        failed = phase; await h.type("\r"); save(`connect-gateway-${name}`)
        failed = undefined
        if (phase === "providers.test") {
          await h.type("t"); save("connect-gateway-test-retry")
          await h.type("e"); save("connect-gateway-edit")
        }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run(`/connect ${AIG_ID}`)
      await h.type("\x15"); await h.type("https://gateway.ai.cloudflare.com/v1/a/g/compat")
      for (let index = 0; index < 4; index++) await h.type("\t")
      await h.type("\r"); save("connect-gateway-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
