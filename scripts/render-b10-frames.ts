import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderAuthStatus } from "@mendcode/protocol"
import { providersHarness, plain, info } from "../apps/cli/test/providers-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** App harness frames: temporary data directory, daemon fakes, no provider HTTP. */
export async function renderB10Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-frames-"))
  const methods: ProviderAuthMethod[] = [{ id: "browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)", available: true }, { id: "headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)", available: true }]
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      let state: ProviderAuthStatus["state"] = "none"
      let available = true
      let failed = false
      let method = "browser"
      const h = providersHarness({ dataDir: dir, width, height, reply: (command) => {
        const status: ProviderAuthStatus = { provider: "chatgpt", state, source: state === "authorized" ? "v2" : "none", accessTokenPresent: state === "authorized", refreshTokenPresent: state === "authorized", accountIdPresent: state === "authorized", ...(state === "failed" ? { error: "Authorization denied; retry login" } : {}) }
        if (command.type === "providers.auth.methods") {
          const oauth = methods.map((entry) => ({ ...entry, available, ...(!available ? { reason: "Set MENDCODE_OPENAI_OAUTH_CLIENT_ID" } : {}) }))
          return { ok: true, result: { methods: { chatgpt: oauth, openai: [...oauth, { id: "api-key", type: "api", label: "API key", available: true }] } } }
        }
        if (command.type === "providers.auth.status") return { ok: true, result: { statuses: [status] } }
        if (command.type === "providers.auth.authorize") {
          state = "pending"; method = String(command.method)
          return { ok: true, result: { authorization: { provider: "chatgpt", method, url: method === "browser" ? "https://oauth.example/oauth/authorize?client_id=fixture&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=fixture&code_challenge_method=S256&state=fixture" : "https://oauth.example/codex/device", instructions: method === "browser" ? "Complete authorization in your browser" : "Enter code: ABCD-EFGH", expiresAt: 1_800_000_300_000 } } }
        }
        if (command.type === "providers.auth.action") { state = command.action === "cancel" ? "cancelled" : command.action === "logout" ? "none" : "authorized"; return { ok: true, result: { status } } }
        if (command.type === "providers.set") return { ok: true, result: { provider: info(String(command.provider)) } }
        if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "fixture-model", ...(failed ? { error: "Provider rejected the API key" } : {}) } }
        return undefined
      } })
      const save = (name: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || /\x1b/.test(row)) || rows.join("\n").includes("never-print")) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect"); save("providers")
      await h.type("\x1b"); await h.run("/connect openai"); save("openai-methods")
      await h.type("\x1b[B"); await h.type("\x1b[B"); await h.type("\r"); save("api-key-form")
      await h.type("\x05"); save("api-key-environment")
      await h.type("\r"); save("api-key-connected")
      await h.type("\x1b"); await h.run("/connect anthropic")
      await h.type("fixture-never-print"); failed = true; await h.type("\r"); save("api-key-failed"); failed = false
      await h.type("\x1b"); await h.run("/connect custom"); save("custom-form")
      await h.type("\x1b"); await h.type("\x1b"); await h.run("/connect chatgpt"); save("chatgpt-methods")
      await h.type("\r"); save("browser-pending")
      await h.type("x"); save("oauth-cancelled")
      await h.type("e"); await h.type("\x1b[B"); await h.type("\r"); save("device-pending")
      state = "failed"; await h.type("s"); save("oauth-failed")
      await h.type("e"); await h.type("\r"); state = "authorized"; await h.type("s"); save("oauth-connected")
      await h.type("d"); save("oauth-logout-confirmation"); await h.type("y"); save("oauth-logged-out")
      await h.type("\x1b"); available = false; await h.run("/connect chatgpt"); await h.type("\r"); save("oauth-unavailable")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
