import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderAuthMethod, ProviderAuthStatus, ProviderInfo } from "@mendcode/protocol"
import { providersHarness, plain } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** Real app factories and Line[] renderer, temp state and daemon fakes; no network. */
export async function renderB1014Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-14-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let state: ProviderAuthStatus["state"] = "none", available = true, enabled = false
      const methods: ProviderAuthMethod[] = [{ id: "device", type: "oauth", label: "Login with GitHub Copilot", available: true }, { id: "api-key", type: "api", label: "GitHub token", available: true }]
      const provider = (): ProviderInfo => ({ id: "github-copilot", type: "github-copilot", baseUrl: "https://api.githubcopilot.com", enabled, hasKey: state === "authorized", source: "config", models: [{ id: "gpt-5", name: "GPT fixture", context: 200_000, effort: true, images: true, copilotEndpoint: "/responses" }] })
      const models: ModelsReport = { engine: "native", selectable: true, models: [{ id: "github-copilot:gpt-5", name: "GPT fixture", provider: "github-copilot", efforts: ["low", "medium", "high"], contextWindow: 200_000 }], defaults: { model: "github-copilot:gpt-5" }, roles: {}, effective: { model: "github-copilot:gpt-5" } }
      const status = (): ProviderAuthStatus => ({ provider: "github-copilot", state, source: ["authorized", "expired"].includes(state) ? "v2" : "none", accessTokenPresent: ["authorized", "expired"].includes(state), refreshTokenPresent: false, accountIdPresent: false, ...(state === "failed" ? { error: "GitHub authorization denied, expired or failed; retry login" } : {}) })
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: [provider()] } }
        if (command.type === "models.list") return { ok: true, result: { ...models, models: enabled && state === "authorized" ? models.models : [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna" } } }
        if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "github-copilot": methods.map((method) => ({ ...method, available: method.type === "api" || available, ...(!available && method.type === "oauth" ? { reason: "Set MENDCODE_GITHUB_COPILOT_CLIENT_ID" } : {}) })) } } }
        if (command.type === "providers.auth.status") { if (state === "authorized") enabled = true; return { ok: true, result: { statuses: [status()] } } }
        if (command.type === "providers.auth.authorize") { state = "pending"; return { ok: true, result: { authorization: { provider: "github-copilot", method: "device", url: "https://github.example/login/device", instructions: "Enter code: ABCD-EFGH", expiresAt: 1_800_000_900_000 } } } }
        if (command.type === "providers.auth.action") { state = command.action === "cancel" ? "cancelled" : command.action === "logout" ? "none" : "authorized"; return { ok: true, result: { status: status() } } }
        if (command.type === "providers.set") { enabled = command.enabled !== false; state = "authorized"; return { ok: true, result: { provider: provider() } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "gpt-5" } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider: provider() } }
        return undefined
      } })
      const save = (name: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || /\x1b/.test(row)) || rows.join("\n").includes("private-never-print")) throw new Error(`Invalid frame: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < 12; index++) await h.type("\x1b[B")
      save("connect-copilot-selected")
      await h.type("\r"); save("copilot-methods")
      await h.type("\r"); save("copilot-device-pending")
      await h.type("x"); save("copilot-cancelled")
      await h.type("e"); await h.type("\r"); state = "failed"; await h.type("s"); save("copilot-failed")
      await h.type("e"); await h.type("\r"); state = "authorized"; await h.type("s"); save("copilot-authorized")
      state = "expired"; await h.type("s"); save("copilot-expired")
      await h.type("r"); save("copilot-refreshed")
      await h.type("d"); save("copilot-logout-confirmation")
      await h.type("y"); save("copilot-logged-out")
      await h.type("\x1b"); available = false; await h.run("/connect github-copilot"); await h.type("\r"); save("copilot-unavailable")
      await h.type("\x1b[B"); await h.type("\r"); save("copilot-token-form")
      await h.type("private-never-print"); save("copilot-token-masked")
      await h.type("\x05"); save("copilot-token-environment")
      await h.type("\r"); save("copilot-token-connected")
      await h.type("\x1b"); await h.run("/providers"); save("providers-copilot")
      await h.type("\r"); save("providers-copilot-details")
      await h.type("e"); save("providers-copilot-off")
      await h.type("e")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/model"); save("models-copilot")
      await h.type("/"); await h.type("github-copilot"); save("models-copilot-picker")
      await h.type("\x1b")
      await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
