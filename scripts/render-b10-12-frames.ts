import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { providersHarness, plain, REPORT } from "../apps/cli/test/providers-harness"
import { appHarness, conversation } from "../apps/cli/test/session-ui-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App factories and ordinary transcript rendering, with isolated data and no network. */
export async function renderB1012Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-12-frames-"))
  const key = "perplexity-fixture-never-print-0123456789"
  const endpoint = "http://127.0.0.1:1234"
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let failed = false
      const provider: ProviderInfo = { id: "perplexity", type: "openai-compatible", baseUrl: endpoint, enabled: false, hasKey: true, source: "config", models: [{ id: "sonar", images: false, tool_call: false }, { id: "sonar-pro", images: false, tool_call: false }] }
      const report = { ...REPORT, models: provider.models.map((model) => ({ id: `perplexity:${model.id}`, name: `${model.id} · Perplexity`, provider: "perplexity", efforts: [] })), defaults: { model: "perplexity:sonar" }, effective: { model: "perplexity:sonar" } }
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { perplexity: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
        if (command.type === "providers.set") { provider.enabled = command.enabled === true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "sonar", ...(failed ? { error: `[AUTH]: rejected ${key}` } : {}) } }
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
      for (let i = 0; i < CONNECT_CHOICES.indexOf("perplexity"); i++) await h.type("\x1b[B")
      save("connect-perplexity-selected")
      await h.type("\r"); save("connect-perplexity-proxy")
      await h.type(endpoint); await h.type("\r"); await h.type(key); save("connect-perplexity-masked")
      await h.type("\x05"); save("connect-perplexity-environment")
      await h.type("\r"); save("connect-perplexity-connected")
      await h.type("r"); save("connect-perplexity-refreshed")
      await h.type("m"); save("model-perplexity")
      await h.type("/"); await h.type("sonar"); save("model-perplexity-picker")
      await h.type("\x1b[B"); await h.type("\r"); save("model-perplexity-selected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-perplexity")
      await h.type("\r"); save("providers-perplexity-details")
      await h.type("\x1b"); await h.type("e"); save("providers-perplexity-off")
      await h.type("d"); save("providers-perplexity-remove"); await h.type("n")
      await h.type("\x1b"); await h.run("/connect perplexity"); await h.type(endpoint); await h.type("\r"); await h.type(key)
      failed = true; await h.type("\r"); save("connect-perplexity-failed")
      await h.type("e"); save("connect-perplexity-edit")
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect perplexity"); await h.type("https://api.perplexity.ai"); await h.type("\x05"); await h.type("\r"); save("connect-perplexity-blocked")
      await h.type("\x1b"); await h.type("\x1b")
      const chat = appHarness({ dataDir: dir, width, height })
      conversation(chat.sessionId, chat.app.onEvent).exchange("What is TCP?", "TCP provides reliable, ordered transport. [1]\n\n[1]: https://example.com/tcp")
      chat.app.render()
      save("chat-perplexity-citations", chat.frames.at(-1)!)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
