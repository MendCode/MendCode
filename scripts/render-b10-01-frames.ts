import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"

/** Isolated app-harness evidence; no network, AWS files or real credentials. */
export async function renderB1001Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-01-frames-"))
  const methods: ProviderAuthMethod[] = [{ id: "aws-chain", type: "api", label: "AWS credential chain", available: true }, { id: "api-key", type: "api", label: "Bedrock bearer token", available: true }]
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "amazon-bedrock", type: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", enabled: false, hasKey: false, authReady: true, source: "config", models: [{ id: "amazon.nova-lite-v1:0", name: "Nova Lite", context: 300_000, images: true }], bedrock: { region: "us-east-1", profile: "team", auth: "chain" } }
      const report = { ...REPORT, models: [{ id: "amazon-bedrock:amazon.nova-lite-v1:0", name: "Nova Lite · Amazon Bedrock", provider: "amazon-bedrock", efforts: [], contextWindow: 300_000 }], defaults: { model: "amazon-bedrock:amazon.nova-lite-v1:0" }, effective: { model: "amazon-bedrock:amazon.nova-lite-v1:0" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "amazon-bedrock": methods } } }
        if (command.type === "providers.set") {
          provider.enabled = command.enabled === true
          if (command.bedrock) provider.bedrock = command.bedrock as ProviderInfo["bedrock"]
          if (command.apiKey !== undefined) provider.hasKey = Boolean(command.apiKey) || Boolean(command.apiKeyEnv)
          return { ok: true, result: { provider } }
        }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "amazon.nova-lite-v1:0", ...(failed ? { error: "[AUTH]: Bedrock HTTP 403; check model access and region" } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      } })
      const save = (name: string, expected?: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain), text = rows.join("\n")
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || text.includes("never-print")) throw new Error(`Invalid frame ${name} ${size}`)
        if (expected && !text.includes(expected)) throw new Error(`Missing ${expected}: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("amazon-bedrock"); i++) await h.type("\x1b[B")
      save("connect-bedrock-selected", "Amazon Bedrock")
      await h.type("\r"); save("connect-bedrock-methods", "AWS credential chain")
      await h.type("\r"); save("connect-bedrock-chain-form", "Profile")
      for (let i = 0; i < 6; i++) await h.type("\t")
      save("connect-bedrock-chain-models", "Models")
      await h.type("\r"); save("connect-bedrock-chain-connected", "test ok")
      await h.type("r"); save("connect-bedrock-refreshed", "model loaded")
      await h.type("m"); save("model-bedrock", "amazon.nova-lite")
      await h.type("/"); save("model-bedrock-picker", "Nova Lite")
      await h.type("\x1b")
      await h.type("\x1b"); await h.run("/providers"); save("providers-bedrock", "Amazon Bedrock")
      await h.type("\r"); save("providers-bedrock-details", "AWS region")
      await h.type("e"); save("providers-bedrock-off", "off")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect bedrock")
      await h.type("\x1b[B"); await h.type("\r"); save("connect-bedrock-bearer-form", "bearer")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("fixture-never-print"); save("connect-bedrock-masked", "chars")
      await h.type("\x05"); save("connect-bedrock-bearer-environment", "AWS_BEARER_TOKEN_BEDROCK")
      await h.type("\r"); save("connect-bedrock-bearer-connected", "test ok")
      await h.type("\x1b"); await h.run("/providers"); await h.type("\r"); save("providers-bedrock-bearer", "bearer")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect bedrock"); await h.type("\x1b[B"); await h.type("\r")
      for (let i = 0; i < 6; i++) await h.type("\t")
      await h.type("fixture-never-print"); await h.type("\t")
      failed = true
      await h.type("\r"); save("connect-bedrock-failed", "test failed")
      await h.type("e"); save("connect-bedrock-retry", "Profile")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
