import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { CF_ID, CF_MODEL, CF_MODELS, CF_TOKEN, CF_URL } from "../packages/engine-native/test/cloudflare-workers-ai-fixtures"

export async function renderB1021Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-21-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let configured = false
      const provider: ProviderInfo = { id: CF_ID, type: "openai-compatible", baseUrl: CF_URL, enabled: false, hasKey: true, source: "config", models: CF_MODELS, cloudflareWorkersAi: { accountId: "local-account" } }
      let choice = REPORT.effective
      const report = () => ({ ...REPORT, models: [...REPORT.models.filter((model) => !model.provider), ...(provider.enabled ? CF_MODELS.map((model) => ({ id: `${CF_ID}:${model.id}`, name: `${model.name} · Cloudflare Workers AI`, provider: CF_ID, efforts: [] })) : [])], effective: choice })
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: configured ? [provider] : [] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { [CF_ID]: [{ id: "api-key", type: "api", label: "Cloudflare Bearer token", available: true }] } } }
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${CF_TOKEN}` } }
        if (command.type === "providers.set") { configured = true; provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: CF_MODEL } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.remove") { configured = false; return { ok: true, result: { providers: [] } } }
        if (command.type === "models.list") return { ok: true, result: report() }
        if (command.type === "session.model.set") { choice = command.choice as typeof choice; return { ok: true, result: report() } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(CF_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      const fill = async () => {
        await h.type("\x15"); await h.type(CF_URL); await h.type("\r")
        await h.type(CF_TOKEN); await h.type("\r")
        await h.type("\x15"); await h.type("local-account"); await h.type("\r")
        await h.type("\x15")
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf(CF_ID); index++) await h.type("\x1b[B")
      save("connect-workers-ai-selected")
      await h.type("\r"); save("connect-workers-ai-proxy")
      await h.type(CF_URL); await h.type("\r"); await h.type(CF_TOKEN); save("connect-workers-ai-masked")
      await h.type("\r"); await h.type("local-account"); save("connect-workers-ai-account")
      await h.type("\r"); save("connect-workers-ai-models")
      await h.type("\x05"); save("connect-workers-ai-environment")
      await h.type("\r"); await h.type("\r"); await h.type("\r")
      save("connect-workers-ai-connected")
      for (const phase of ["Saving", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} Cloudflare Workers AI`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-workers-ai-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-workers-ai-retained")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing Cloudflare Workers AI"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-workers-ai-refreshing", refreshing)
      await h.type("m"); save("model-workers-ai")
      await h.type("/"); await h.type(CF_MODEL); save("model-workers-ai-picker")
      await h.type("\r"); save("model-workers-ai-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-workers-ai")
      await h.type("\r"); save("providers-workers-ai-details")
      await h.type("\x1b"); await h.type("e"); save("providers-workers-ai-off")
      await h.type("d"); save("providers-workers-ai-remove")
      await h.type("y"); save("providers-workers-ai-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.test", "test-failed"]]) {
        await h.run(`/connect ${CF_ID}`); await fill()
        failed = phase; await h.type("\r"); save(`connect-workers-ai-${name}`)
        failed = undefined
        if (phase === "providers.test") {
          await h.type("t"); save("connect-workers-ai-test-retry")
          await h.type("e"); save("connect-workers-ai-edit")
        }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run(`/connect ${CF_ID}`)
      await h.type("\x15"); await h.type("https://api.cloudflare.com/client/v4/accounts/a/ai/v1"); await h.type("\x05")
      await h.type("\r"); await h.type("\r"); await h.type("\r"); save("connect-workers-ai-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
