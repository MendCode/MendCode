import { describe, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import type { ProviderAuthMethod, ProviderAuthStatus } from "@mendcode/protocol"
import { parseAutomation } from "../src/automation"
import { connectKey, createConnectState, renderConnectPage } from "../src/view/connect-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness, CATALOG_PROVIDERS } from "./catalog-harness"
import { providersHarness, plain } from "./providers-harness"

const METHODS: ProviderAuthMethod[] = [{ id: "browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)", available: true }, { id: "headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)", available: true }]
const status = (state: ProviderAuthStatus["state"] = "none"): ProviderAuthStatus => ({ provider: "chatgpt", state, source: state === "authorized" || state === "expired" ? "v2" : "none", accessTokenPresent: state === "authorized", refreshTokenPresent: state === "authorized", accountIdPresent: state === "authorized" })
const AUTHORIZATION = { provider: "chatgpt", method: "headless", url: "https://oauth.example/codex/device", instructions: "Enter code: ABCD-EFGH", expiresAt: 1_800_000_300_000 }
function ui(initial: ProviderAuthStatus["state"] = "none") {
  let state = initial
  const h = providersHarness({ reply: (command) => {
    if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { chatgpt: METHODS, openai: [...METHODS, { id: "api-key", type: "api", label: "API key", available: true }] } } }
    if (command.type === "providers.auth.status") return { ok: true, result: { statuses: [status(state)] } }
    if (command.type === "providers.auth.authorize") { state = "pending"; return { ok: true, result: { authorization: { ...AUTHORIZATION, method: command.method } } } }
    if (command.type === "providers.auth.action") { state = command.action === "cancel" ? "cancelled" : command.action === "logout" ? "none" : "authorized"; return { ok: true, result: { status: status(state) } } }
    return undefined
  } })
  return { ...h, complete: () => { state = "authorized" } }
}

describe("B10 terminal auth", () => {
  test("method selection, pending screen, completion and reopening a saved login", async () => {
    const h = ui()
    await h.run("/connect chatgpt")
    expect(h.text()).toContain("Select auth method")
    expect(h.text()).toContain("ChatGPT Pro/Plus (headless)")
    await h.type("\x1b[B"); await h.type("\r")
    expect(h.commands("providers.auth.authorize")).toEqual([{ type: "providers.auth.authorize", provider: "chatgpt", method: "headless" }])
    expect(h.text()).toContain("Enter code: ABCD-EFGH")
    expect(h.text()).toContain("ChatGPT · pending")
    h.complete(); await h.type("s")
    expect(h.text()).toContain("ChatGPT · authorized")
    expect(h.text()).not.toContain("ABCD-EFGH")
    await h.type("\x1b"); await h.run("/connect chatgpt")
    expect(h.text()).toContain("ChatGPT · authorized")
    expect(h.commands("providers.auth.authorize")).toHaveLength(1)
    await h.type("\x1b")
  }, 15_000)
  test("OAuth cancel and escape tell the daemon; confirmed logout preserves a reconnect path", async () => {
    const h = ui()
    await h.run("/connect chatgpt"); await h.type("\r"); await h.type("x")
    expect(h.commands("providers.auth.action").at(-1)).toMatchObject({ action: "cancel" })
    expect(h.text()).toContain("ChatGPT · cancelled")
    await h.type("e"); await h.type("\r"); await h.type("\x1b")
    expect(h.commands("providers.auth.action").filter((command) => command.action === "cancel")).toHaveLength(2)
    expect(h.app.page).toBe("chat")
    const saved = ui("authorized")
    await saved.run("/connect chatgpt"); await saved.type("r")
    expect(saved.commands("providers.auth.action").at(-1)).toMatchObject({ action: "refresh" })
    await saved.type("d")
    expect(saved.text()).toContain("Remove v2 ChatGPT login?")
    expect(saved.commands("providers.auth.action").filter((command) => command.action === "logout")).toHaveLength(0)
    await saved.type("n"); await saved.type("d"); await saved.type("y")
    expect(saved.commands("providers.auth.action").at(-1)).toMatchObject({ action: "logout" })
    expect(saved.text()).toContain("ChatGPT · none")
    await saved.type("\x1b")
  }, 15_000)
  test("unavailable OAuth explains the missing configuration and keeps API key selection", async () => {
    const h = providersHarness({ reply: (command) => command.type === "providers.auth.methods" ? { ok: true, result: { methods: { openai: [{ ...METHODS[0], available: false, reason: "Set MENDCODE_OPENAI_OAUTH_CLIENT_ID" }, { id: "api-key", type: "api", label: "API key", available: true }] } } } : undefined })
    await h.run("/connect openai"); await h.type("\r")
    expect(h.text()).toContain("Set MENDCODE_OPENAI_OAUTH_CLIENT_ID")
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    await h.type("\x1b[B"); await h.type("\r")
    expect(h.text()).toContain("API key")
    expect(h.text()).toContain("required")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)
  test("auth errors return to the method page without leaving a pending UI", async () => {
    const h = providersHarness({ reply: (command) => command.type === "providers.auth.methods" ? { ok: true, result: { methods: { chatgpt: METHODS } } } : command.type === "providers.auth.authorize" ? { ok: false, error: { code: "invalid_command", message: "Callback port busy" } } : undefined })
    await h.run("/connect chatgpt"); await h.type("\r")
    expect(h.text()).toContain("Callback port busy")
    expect(h.text()).toContain("Select auth method")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)
  test("all auth states fit the grid at every contracted viewport; hints stay in the header", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const base = { ...createConnectState("chatgpt"), methods: { chatgpt: METHODS } }
      for (const state of [base, { ...base, step: "oauth" as const, authStatus: status("pending"), authorization: AUTHORIZATION }, { ...base, step: "oauth" as const, authStatus: status("authorized"), confirmLogout: true }]) {
        const rows = renderConnectPage({ state, width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
        expect(rows[0]).toContain("confirmLogout" in state ? "cancel" : "esc")
        expect(rows.slice(-2).join("")).not.toContain("esc")
      }
    }
    expect(connectKey(createConnectState("chatgpt"), "\t").action.type).toBe("none")
  })
})

describe("B10 CLI auth", () => {
  test("parses status, login-plan, login --execute --open and method labels", () => {
    for (const operation of ["status", "login-plan", "login", "refresh", "logout"]) expect(parseAutomation(["control-plane", "auth", operation, "openai"]).ok).toBe(true)
    expect(parseAutomation(["control-plane", "auth", "login", "openai", "--method", "browser", "--execute", "--open"])).toMatchObject({ ok: true, command: { kind: "catalog.auth", execute: true, open: true } })
    expect(parseAutomation(["providers", "login", "-p", "OpenAI", "-m", "ChatGPT Pro/Plus (browser)"])).toMatchObject({ ok: true, command: { method: "ChatGPT Pro/Plus (browser)" } })
    expect(parseAutomation(["providers", "login", "https://auth.example"])).toMatchObject({ ok: true, command: { url: "https://auth.example" } })
    expect(parseAutomation(["control-plane", "auth", "login-plan"]).ok).toBe(false)
    expect(parseAutomation(["control-plane", "auth", "status", "--execute"]).ok).toBe(false)
    expect(parseAutomation(["providers", "login", "--provider", "openai", "--method", "browser", "--api-key-env", "TEAM_KEY"]).ok).toBe(false)
    expect(parseAutomation(["providers", "login", "http://127.0.0.1:1234", "--execute"])).toMatchObject({ ok: true, command: { execute: true } })
    expect(parseAutomation(["providers", "login", "--execute"]).ok).toBe(false)
  })
  test("control-plane login defaults to a plan without network or credential changes", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.auth.plan" ? { plan: { executesNow: false, writesSecrets: false, callsProvider: false } } : {} }) })
    expect(await h.run(["control-plane", "auth", "login", "openai", "--json"])).toBe(0)
    expect(h.sent).toEqual([{ type: "providers.auth.plan", provider: "openai" }])
    expect(await h.run(["control-plane", "auth", "logout", "chatgpt"])).toBe(64)
    expect(h.sent).toHaveLength(1)
  })
  test("execute prints only authorization capability, observes success and never cancels successful login", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.auth.authorize" ? { authorization: AUTHORIZATION } : { statuses: [status("authorized")] } }) })
    expect(await h.run(["control-plane", "auth", "login", "chatgpt", "--method", "headless", "--execute", "--json"])).toBe(0)
    expect(h.err.join("")).toContain("ABCD-EFGH")
    expect(h.out.join("")).not.toContain("ABCD-EFGH")
    expect(h.sent.map((command) => command.type)).toEqual(["providers.auth.authorize", "providers.auth.status"])
  })
  test("interrupt and timeout cancel only the initiated OAuth flow", async () => {
    for (const timeout of [false, true]) {
      let onTimeout!: () => void
      const h = catalogHarness({ send: (command) => {
        if (command.type === "providers.auth.status") timeout ? onTimeout() : h.interrupt()
        return { ok: true, result: command.type === "providers.auth.authorize" ? { authorization: AUTHORIZATION } : { statuses: [status("pending")] } }
      } })
      h.deps.setTimer = (ms, callback) => { if (ms === 900_000) onTimeout = callback; return { cancel() {} } }
      expect(await h.run(["control-plane", "auth", "login", "chatgpt", "--execute"])).toBe(timeout ? 3 : 2)
      expect(h.sent.at(-1)).toEqual({ type: "providers.auth.action", provider: "chatgpt", action: "cancel" })
    }
  })
  test("providers login selects a method by label; unsupported metadata never makes a request", async () => {
    const sent: CommandInput[] = []
    const h = catalogHarness({ send: (command) => {
      sent.push(command)
      return { ok: true, result: command.type === "providers.catalog" ? CATALOG_PROVIDERS : command.type === "providers.auth.methods" ? { methods: { chatgpt: METHODS } } : command.type === "providers.auth.authorize" ? { authorization: AUTHORIZATION } : { statuses: [status("authorized")] } }
    } })
    expect(await h.run(["providers", "login", "--provider", "ChatGPT", "--method", "ChatGPT Pro/Plus (headless)"])).toBe(0)
    expect(sent).toContainEqual({ type: "providers.auth.authorize", provider: "chatgpt", method: "headless" })
    sent.length = 0
    expect(await h.run(["providers", "login", "http://auth.example"])).toBe(1)
    expect(sent).toHaveLength(0)
  })
  test("loopback metadata login defaults to a plan and only --execute permits mutation", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: { metadata: { executesNow: "execute" in command && command.execute } } }) })
    expect(await h.run(["providers", "login", "http://127.0.0.1:1234", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.auth.metadata", url: "http://127.0.0.1:1234", execute: false })
    expect(await h.run(["providers", "login", "http://127.0.0.1:1234", "--execute"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ execute: true })
    expect(await h.run(["providers", "login", "https://auth.example.com/team", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.auth.metadata", url: "https://auth.example.com/team", execute: false })
  })
})
