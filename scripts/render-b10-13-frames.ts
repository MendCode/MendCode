import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App factories, temporary data and injected replies; no provider or network. */
export async function renderB1013Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-13-frames-"))
  const key = "alibaba-fixture-never-print-0123456789"
  const endpoint = "http://127.0.0.1:1234/compatible-mode/v1"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "alibaba", type: "openai-compatible", baseUrl: endpoint, enabled: false, hasKey: true, source: "config", models: [{ id: "qwen-plus", images: false, tool_call: true }, { id: "qwen3-coder-plus", images: false, tool_call: true }] }
      const report = { ...REPORT, models: provider.models.map((model) => ({ id: `alibaba:${model.id}`, name: `${model.id} · Alibaba`, provider: "alibaba", efforts: [] })), defaults: { model: "alibaba:qwen-plus" }, effective: { model: "alibaba:qwen-plus" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { alibaba: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "qwen-plus", ...(failed ? { error: `[AUTH]: rejected ${key}` } : {}) } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "models.list") return { ok: true, result: report }
        if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
        return undefined
      } })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(key)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let i = 0; i < CONNECT_CHOICES.indexOf("alibaba"); i++) await h.type("\x1b[B")
      save("connect-alibaba-selected")
      await h.type("\r"); save("connect-alibaba-proxy")
      await h.type(endpoint); await h.type("\r"); await h.type(key); save("connect-alibaba-masked")
      await h.type("\x05"); save("connect-alibaba-environment")
      await h.type("\r"); save("connect-alibaba-connected")
      for (const phase of ["Saving", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} Alibaba…`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-alibaba-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-alibaba-refreshed")
      await h.type("m"); save("model-alibaba")
      await h.type("/"); await h.type("qwen"); save("model-alibaba-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-alibaba-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-alibaba")
      await h.type("\r"); save("providers-alibaba-details")
      await h.type("\x1b"); await h.type("e"); save("providers-alibaba-off")
      await h.type("d"); save("providers-alibaba-remove"); await h.type("n")
      await h.type("\x1b"); await h.run("/connect alibaba"); await h.type(endpoint); await h.type("\r"); await h.type(key)
      failed = true; await h.type("\r"); save("connect-alibaba-failed")
      await h.type("e"); save("connect-alibaba-edit")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect alibaba"); await h.type("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"); await h.type("\x05"); await h.type("\r"); save("connect-alibaba-blocked")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
