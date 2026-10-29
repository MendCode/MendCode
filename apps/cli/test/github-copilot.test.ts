import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderAuthStatus } from "@mendcode/protocol"
import { connectKey, createConnectState, renderConnectPage, CONNECT_CHOICES } from "../src/view/connect-page"
import { textWidth } from "../src/view/wrap"
import { createProvidersPageState, renderProvidersPage } from "../src/view/providers-page"
import { providersHarness, plain, info } from "./providers-harness"
import { catalogHarness, CATALOG_PROVIDERS } from "./catalog-harness"

const methods: ProviderAuthMethod[] = [{ id: "device", type: "oauth", label: "Login with GitHub Copilot", available: true }, { id: "api-key", type: "api", label: "GitHub token", available: true }]
export const copilotStatus = (state: ProviderAuthStatus["state"]): ProviderAuthStatus => ({ provider: "github-copilot", state, source: ["authorized", "expired"].includes(state) ? "v2" : "none", accessTokenPresent: ["authorized", "expired"].includes(state), refreshTokenPresent: false, accountIdPresent: false })
const authorization = { provider: "github-copilot", method: "device", url: "https://github.example/login/device", instructions: "Enter code: ABCD-EFGH", expiresAt: 1_800_000_900_000 }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function ui(initial: ProviderAuthStatus["state"] = "none", available = true) {
  let state = initial
  const dataDir = mkdtempSync(path.join(tmpdir(), "mendcode-copilot-ui-")); dirs.push(dataDir)
  const h = providersHarness({ dataDir, reply: (command) => {
    if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "github-copilot": methods.map((method) => ({ ...method, available: method.type === "api" || available, ...(!available && method.type === "oauth" ? { reason: "Set MENDCODE_GITHUB_COPILOT_CLIENT_ID" } : {}) })) } } }
    if (command.type === "providers.auth.status") return { ok: true, result: { statuses: [copilotStatus(state)] } }
    if (command.type === "providers.auth.authorize") { state = "pending"; return { ok: true, result: { authorization } } }
    if (command.type === "providers.auth.action") { state = command.action === "cancel" ? "cancelled" : command.action === "logout" ? "none" : "authorized"; return { ok: true, result: { status: copilotStatus(state) } } }
    return undefined
  } })
  return { ...h, complete() { state = "authorized" } }
}

describe("B10.14 terminal", () => {
  test("device login, poll, reopen, refresh and confirmed logout target Copilot", async () => {
    const h = ui()
    await h.run("/connect GitHub Copilot")
    expect(h.text()).toContain("Select auth method")
    expect(h.text()).toContain("Login with GitHub Copilot")
    await h.type("\t")
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.auth.authorize")).toEqual([{ type: "providers.auth.authorize", provider: "github-copilot", method: "device" }])
    expect(h.text()).toContain("GitHub Copilot · pending")
    expect(h.text()).toContain("ABCD-EFGH")
    h.complete(); await h.type("s")
    expect(h.text()).toContain("GitHub Copilot · authorized")
    expect(h.text()).not.toContain("ABCD-EFGH")
    await h.type("\x1b"); await h.run("/connect github-copilot")
    expect(h.text()).toContain("GitHub Copilot · authorized")
    expect(h.commands("providers.auth.authorize")).toHaveLength(1)
    await h.type("r")
    await h.type("d"); expect(h.text()).toContain("Remove v2 GitHub Copilot login?")
    await h.type("y"); expect(h.text()).toContain("GitHub Copilot · none")
    expect(h.commands("providers.auth.action").map((entry) => [entry.provider, entry.action])).toEqual([["github-copilot", "refresh"], ["github-copilot", "logout"]])
    await h.type("\x1b")
  })
  test("cancel/escape stop only Copilot; missing client id keeps masked-token fallback", async () => {
    const h = ui()
    await h.run("/connect github-copilot"); await h.type("\r"); await h.type("x")
    expect(h.text()).toContain("GitHub Copilot · cancelled")
    await h.type("e"); await h.type("\r"); await h.type("\x1b")
    expect(h.commands("providers.auth.action")).toEqual([{ type: "providers.auth.action", provider: "github-copilot", action: "cancel" }, { type: "providers.auth.action", provider: "github-copilot", action: "cancel" }])
    const off = ui("none", false)
    await off.run("/connect github-copilot"); await off.type("\r")
    expect(off.text()).toContain("Set MENDCODE_GITHUB_COPILOT_CLIENT_ID")
    expect(off.commands("providers.auth.authorize")).toHaveLength(0)
    await off.type("\x1b[B"); await off.type("\r"); await off.type("private-never-print-token")
    expect(off.everything()).not.toContain("private-never-print-token")
    await off.type("\x1b"); await off.type("\x1b")
  })
  test("saved Copilot login is found when entering through the provider list", async () => {
    const h = ui("authorized")
    await h.run("/connect")
    for (let i = 0; i < CONNECT_CHOICES.indexOf("github-copilot"); i++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.text()).toContain("GitHub Copilot · authorized")
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    await h.type("\x1b")
  })
  test("token login refreshes the catalog before testing; credentials stay out of frames", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "mendcode-copilot-token-")); dirs.push(dataDir)
    const h = providersHarness({ dataDir, reply: (command) => command.type === "providers.auth.methods" ? { ok: true, result: { methods: { "github-copilot": methods } } }
      : ["providers.set", "providers.refresh"].includes(String(command.type)) ? { ok: true, result: { provider: info("github-copilot", { type: "github-copilot", models: [{ id: "gpt-5" }] }) } }
      : command.type === "providers.test" ? { ok: true, result: { ok: true, model: "gpt-5", latencyMs: 1 } } : undefined })
    await h.run("/connect github-copilot"); await h.type("\x1b[B"); await h.type("\r")
    await h.type("private-never-print-token"); await h.type("\r")
    expect(h.sent.filter((entry) => ["providers.set", "providers.refresh", "providers.test"].includes(String(entry.type))).map((entry) => entry.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.text()).toContain("GitHub Copilot connected")
    expect(h.everything()).not.toContain("private-never-print-token")
    await h.type("\x1b")
  })
  test("Copilot UI remains lazy and never pulls schemas into the terminal startup graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app");
const has = () => Object.keys(require.cache).some((key) => key.endsWith("/view/connect-page.ts"));
const before = has();
await (await import("./src/ui/lazy-pages")).preload("connect");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ before, after: has(), schemas: keys.filter((key) => key.includes("/zod/") || /protocol\\/src\\/(commands|providers|provider-auth)\\.ts$/.test(key)).length }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ before: false, after: true, schemas: 0 })
  })
  test("all states fit compact and wide grids; auth hints live in the header", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      const base = { ...createConnectState("github-copilot"), methods: { "github-copilot": methods } }
      for (const state of [base, ...(["pending", "authorized", "expired", "cancelled", "failed", "none"] as const).map((kind) => ({ ...base, step: "oauth" as const, authStatus: copilotStatus(kind), authorization }))]) {
        const rows = renderConnectPage({ state, width, height }).map(plain)
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
        expect(rows[0]).toContain("esc")
        expect(rows.slice(-2).join("")).not.toContain("esc")
      }
      expect(connectKey(base, "\t").action.type).toBe("none")
      const providers = [{ id: "github-copilot", type: "github-copilot" as const, baseUrl: "https://copilot.example", enabled: false, hasKey: false, source: "config" as const, models: [] }]
      const rows = renderProvidersPage({ state: createProvidersPageState(), providers, width, height }).map(plain)
      expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("┌─ Providers")
      expect(rows.slice(-2).join("")).not.toContain("esc")
    }
  })
})

describe("B10.14 CLI", () => {
  const report = { ...CATALOG_PROVIDERS, providers: [...CATALOG_PROVIDERS.providers, { id: "github-copilot", name: "GitHub Copilot", type: "github-copilot", configured: false, enabled: false, authReady: false, credentialStored: false, authMode: "github-copilot-oauth", models: 0, requiredEnv: ["GITHUB_COPILOT_TOKEN"], presentEnv: [] }] }
  test("method-label login polls Copilot through generic factories and reports its name", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? report : command.type === "providers.auth.methods" ? { methods: { "github-copilot": methods } } : command.type === "providers.auth.authorize" ? { authorization } : { statuses: [copilotStatus("authorized")] } }) })
    expect(await h.run(["providers", "login", "--provider", "GitHub Copilot", "--method", "Login with GitHub Copilot"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.auth.status", provider: "github-copilot" })
    expect(h.out.join("")).toContain("GitHub Copilot connected")
  })
  test("offline plan calls no provider; interruption cancels Copilot; env-token login opts in", async () => {
    const plan = catalogHarness({ send: () => ({ ok: true, result: { plan: { callsProvider: false } } }) })
    expect(await plan.run(["control-plane", "auth", "login", "github-copilot"])).toBe(0)
    expect(plan.sent).toEqual([{ type: "providers.auth.plan", provider: "github-copilot" }])
    const interrupted = catalogHarness({ send: (command) => { if (command.type === "providers.auth.status") interrupted.interrupt(); return { ok: true, result: command.type === "providers.auth.authorize" ? { authorization } : { statuses: [copilotStatus("pending")] } } } })
    expect(await interrupted.run(["control-plane", "auth", "login", "github-copilot", "--execute"])).toBe(2)
    expect(interrupted.sent.at(-1)).toEqual({ type: "providers.auth.action", provider: "github-copilot", action: "cancel" })
    const key = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? report : {} }) })
    expect(await key.run(["providers", "login", "--provider", "github-copilot", "--api-key-env", "TEAM_COPILOT"])).toBe(0)
    expect(key.sent.at(-1)).toEqual({ type: "providers.set", provider: "github-copilot", apiKeyEnv: "TEAM_COPILOT", enabled: true })
  })
})
