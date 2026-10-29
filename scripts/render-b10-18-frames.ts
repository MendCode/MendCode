import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { SAP_KEY, SAP_MODELS, SAP_SECRET, SAP_TOKEN, SAP_URL } from "../packages/engine-native/test/sap-ai-fixtures"

export async function renderB1018Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-18-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed: string | undefined
      let removed = false
      let key = ""
      const provider: ProviderInfo = { id: "sap-ai-core", type: "openai-compatible", baseUrl: SAP_URL, enabled: false, hasKey: true, source: "config", models: SAP_MODELS, sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" } }
      const report = { ...REPORT, models: SAP_MODELS.map((model) => ({ id: `sap-ai-core:${model.id}`, name: `${model.name} · SAP AI Core`, provider: "sap-ai-core", efforts: [] })), defaults: { model: "sap-ai-core:chat-fixture" }, effective: { model: "sap-ai-core:chat-fixture" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: removed ? [] : [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "sap-ai-core": [{ id: "api-key", type: "api", label: "Service key (JSON)", available: true }] } } }
        if (command.type === "providers.set" && command.apiKey) key = String(command.apiKey)
        if (command.type === failed) return { ok: false, error: { code: "internal", message: `rejected ${key}` } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "chat-fixture" } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.remove") { removed = true; return { ok: true, result: { providers: [] } } }
        if (command.type === "models.list") return { ok: true, result: report }
        if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || [SAP_SECRET, SAP_TOKEN].some((secret) => rows.join("\n").includes(secret))) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      const fill = async () => {
        await h.type(SAP_URL); await h.type("\r"); await h.type(`\x1b[200~${SAP_KEY}\x1b[201~`)
        await h.type("\r"); await h.type("deployment-fixture"); await h.type("\r"); await h.type("test"); await h.type("\r")
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("sap-ai-core"); index++) await h.type("\x1b[B")
      save("connect-sap-selected")
      await h.type("\r"); save("connect-sap-form")
      await h.type(SAP_URL); await h.type("\r"); await h.type(`\x1b[200~${SAP_KEY}\x1b[201~`); save("connect-sap-masked")
      await h.type("\r"); await h.type("deployment-fixture"); save("connect-sap-deployment")
      await h.type("\r"); await h.type("test"); save("connect-sap-resource-group")
      await h.type("\r"); save("connect-sap-models")
      await h.type("\r"); save("connect-sap-connected")
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} SAP AI Core`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-sap-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-sap-refreshed")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing SAP AI Core"))
      if (!refreshing) throw new Error(`Missing refreshing frame ${size}`)
      save("connect-sap-refreshing", refreshing)
      await h.type("m"); save("model-sap")
      await h.type("/"); await h.type("chat-fixture"); save("model-sap-picker")
      await h.type("\r"); save("model-sap-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-sap")
      await h.type("\r"); save("providers-sap-details")
      await h.type("\x1b"); await h.type("e"); save("providers-sap-off")
      await h.type("d"); save("providers-sap-remove")
      await h.type("y"); save("providers-sap-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.refresh", "refresh-failed"], ["providers.test", "test-failed"]]) {
        await h.run("/connect sap-ai-core"); await fill()
        failed = phase; await h.type("\r"); save(`connect-sap-${name}`)
        failed = undefined
        if (phase === "providers.refresh") {
          await h.type("r"); save("connect-sap-refresh-retry")
          await h.type("t"); save("connect-sap-test-retry")
        }
        if (phase !== "providers.set") { await h.type("e"); save(`connect-sap-edit-${name}`) }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run("/connect sap-ai-core"); await h.type("\x05"); save("connect-sap-environment")
      await h.type("https://public.example/v2")
      for (let index = 0; index < 4; index++) await h.type("\r")
      save("connect-sap-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
