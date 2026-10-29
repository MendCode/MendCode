import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { ZEN_MODELS, ZEN_TOKEN, ZEN_URL } from "../packages/engine-native/test/zen-fixtures"

export async function renderB1015Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-15-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      let refreshFailed = false
      const provider: ProviderInfo = { id: "opencode", type: "openai-compatible", baseUrl: ZEN_URL, enabled: false, hasKey: true, source: "config", models: ZEN_MODELS }
      const report = { ...REPORT, models: ZEN_MODELS.map((model) => ({ id: `opencode:${model.id}`, name: `${model.id} · OpenCode Zen`, provider: "opencode", efforts: [] })), defaults: { model: "opencode:gpt-fixture" }, effective: { model: "opencode:gpt-fixture" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { opencode: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "gpt-fixture", ...(failed ? { error: `[AUTH]: rejected ${ZEN_TOKEN}` } : {}) } }
        if (command.type === "providers.refresh") return refreshFailed ? { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${ZEN_TOKEN}` } } : { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(ZEN_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("opencode"); index++) await h.type("\x1b[B")
      save("connect-zen-selected")
      await h.type("\r"); save("connect-zen-proxy")
      await h.type(ZEN_URL); await h.type("\r"); await h.type(ZEN_TOKEN); save("connect-zen-masked")
      await h.type("\x05"); save("connect-zen-environment")
      await h.type("\r"); save("connect-zen-connected")
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} OpenCode Zen`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-zen-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-zen-refreshed")
      await h.type("m"); save("model-zen")
      await h.type("/"); await h.type("fixture"); save("model-zen-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-zen-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-zen")
      await h.type("\r"); save("providers-zen-details")
      await h.type("\x1b"); await h.type("e"); save("providers-zen-off")
      await h.type("d"); save("providers-zen-remove"); await h.type("n")
      await h.type("\x1b"); await h.run("/connect opencode"); await h.type(ZEN_URL); await h.type("\r"); await h.type(ZEN_TOKEN)
      failed = true; await h.type("\r"); save("connect-zen-failed")
      await h.type("e"); save("connect-zen-edit")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect opencode"); await h.type(ZEN_URL); await h.type("\r"); await h.type(ZEN_TOKEN)
      refreshFailed = true; await h.type("\r"); save("connect-zen-refresh-failed")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect opencode"); await h.type("https://opencode.ai/zen/v1"); await h.type("\x05"); await h.type("\r"); save("connect-zen-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
