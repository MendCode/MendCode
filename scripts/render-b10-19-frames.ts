import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { ZENMUX_MODELS, ZENMUX_TOKEN, ZENMUX_URL } from "../packages/engine-native/test/zenmux-fixtures"

export async function renderB1019Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-19-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let removed = false
      const provider: ProviderInfo = { id: "zenmux", type: "openai-compatible", baseUrl: ZENMUX_URL, enabled: false, hasKey: true, source: "config", models: ZENMUX_MODELS }
      let choice = REPORT.effective
      const report = () => ({ ...REPORT, models: [...REPORT.models.filter((model) => !model.provider), ...(provider.enabled ? ZENMUX_MODELS.map((model) => ({ id: `zenmux:${model.id}`, name: `${model.name} · Zenmux`, provider: "zenmux", efforts: [] })) : [])], effective: choice })
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: removed ? [] : [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { zenmux: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `[PROVIDER]: rejected ${ZENMUX_TOKEN}` } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "vendor/reasoning-fixture" } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.remove") { removed = true; return { ok: true, result: { providers: [] } } }
        if (command.type === "models.list") return { ok: true, result: report() }
        if (command.type === "session.model.set") { choice = command.choice as typeof choice; return { ok: true, result: report() } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(ZENMUX_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("zenmux"); index++) await h.type("\x1b[B")
      save("connect-zenmux-selected")
      await h.type("\r"); save("connect-zenmux-proxy")
      await h.type(ZENMUX_URL); await h.type("\r"); await h.type(ZENMUX_TOKEN); save("connect-zenmux-masked")
      await h.type("\x05"); save("connect-zenmux-environment")
      await h.type("\r"); save("connect-zenmux-connected")
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} Zenmux`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-zenmux-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-zenmux-refreshed")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing Zenmux"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-zenmux-refreshing", refreshing)
      await h.type("m"); save("model-zenmux")
      await h.type("/"); await h.type("fixture"); save("model-zenmux-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-zenmux-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-zenmux")
      await h.type("\r"); save("providers-zenmux-details")
      await h.type("\x1b"); await h.type("e"); save("providers-zenmux-off")
      await h.type("d"); save("providers-zenmux-remove")
      await h.type("y"); save("providers-zenmux-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.refresh", "refresh-failed"], ["providers.test", "test-failed"]]) {
        await h.run("/connect zenmux"); await h.type(ZENMUX_URL); await h.type("\r"); await h.type(ZENMUX_TOKEN)
        failed = phase; await h.type("\r"); save(`connect-zenmux-${name}`)
        failed = undefined
        if (phase === "providers.refresh") {
          const refreshes = h.commands("providers.refresh").length
          await h.type("r")
          if (h.commands("providers.refresh").length !== refreshes + 1) throw new Error(`Missing refresh retry ${size}`)
          if (!h.text().includes("Zenmux connected") || h.text().includes("refresh failed")) throw new Error(`Stale refresh retry ${size}`)
          save("connect-zenmux-refresh-retry")
          await h.type("t"); save("connect-zenmux-test-retry")
        }
        if (phase !== "providers.set") { await h.type("e"); save(`connect-zenmux-edit-${name}`) }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run("/connect zenmux"); await h.type("https://zenmux.ai/api/v1"); await h.type("\x05"); await h.type("\r"); save("connect-zenmux-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
