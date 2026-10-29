import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { KILO_MODELS, KILO_TOKEN, KILO_URL } from "../packages/engine-native/test/kilo-fixtures"

export async function renderB1023Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-23-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let removed = false
      const provider: ProviderInfo = { id: "kilo", type: "openai-compatible", baseUrl: KILO_URL, enabled: false, hasKey: true, source: "config", models: KILO_MODELS }
      const report = { ...REPORT, models: KILO_MODELS.map((model) => ({ id: `kilo:${model.id}`, name: model.name ?? model.id, provider: "kilo", efforts: [] })), defaults: { model: "kilo:reasoning-fixture" }, effective: { model: "kilo:reasoning-fixture" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: removed ? [] : [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { kilo: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${KILO_TOKEN}` } }
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
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(KILO_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("kilo"); index++) await h.type("\x1b[B")
      save("connect-kilo-selected")
      await h.type("\r"); save("connect-kilo-proxy")
      await h.type(KILO_URL); await h.type("\r"); await h.type(KILO_TOKEN); save("connect-kilo-masked")
      await h.type("\x05"); save("connect-kilo-environment")
      await h.type("\r"); save("connect-kilo-connected")
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} Kilo`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-kilo-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-kilo-refreshed")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing Kilo"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-kilo-refreshing", refreshing)
      await h.type("m"); save("model-kilo")
      await h.type("/"); await h.type("fixture"); save("model-kilo-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-kilo-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-kilo")
      await h.type("\r"); save("providers-kilo-details")
      await h.type("\x1b"); await h.type("e"); save("providers-kilo-off")
      await h.type("d"); save("providers-kilo-remove")
      await h.type("y"); save("providers-kilo-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.refresh", "refresh-failed"], ["providers.test", "test-failed"]]) {
        await h.run("/connect kilo"); await h.type(KILO_URL); await h.type("\r"); await h.type(KILO_TOKEN)
        failed = phase; await h.type("\r"); save(`connect-kilo-${name}`)
        failed = undefined
        if (phase === "providers.refresh") {
          await h.type("r"); save("connect-kilo-refresh-retry")
          await h.type("t"); save("connect-kilo-test-retry")
        }
        if (phase !== "providers.set") { await h.type("e"); save(`connect-kilo-edit-${name}`) }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run("/connect kilo"); await h.type("https://api.kilo.ai/api/gateway"); await h.type("\x05"); await h.type("\r"); save("connect-kilo-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
