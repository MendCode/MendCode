import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { parseAutomation } from "../src/automation"
import { connectKey, createConnectState, renderConnectPage, validateConnect, CONNECT_CHOICES } from "../src/view/connect-page"
import { CONNECT_PRESETS } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { providersHarness, plain, REPORT } from "./providers-harness"

const KEY = "cohere-ui-fixture-never-print"
const MODEL = "command-a-03-2025"
const PROXY = "http://127.0.0.1:1234/v2"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-cohere-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "cohere", type: "cohere", baseUrl: PROXY, enabled: true, hasKey: true, source: "config", models: [{ id: MODEL, name: "Command A" }] }
const report: ModelsReport = { ...REPORT, models: [{ id: `cohere:${MODEL}`, name: "Command A · Cohere", provider: "cohere", efforts: [] }], defaults: { model: `cohere:${MODEL}` }, effective: { model: `cohere:${MODEL}` } }

describe("B10.10 Cohere terminal", () => {
  test("appends choices without moving existing shortcuts; schema-free UI metadata matches engine", async () => {
    expect(CONNECT_CHOICES.slice(0, 18)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral"])
    expect(CONNECT_CHOICES.filter((id) => id === "cohere")).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf("cohere")).toBeGreaterThan(CONNECT_CHOICES.indexOf("mistral"))
    const { PROVIDER_PRESETS } = await import("../../../packages/engine-native/src/provider-presets")
    const preset = PROVIDER_PRESETS.cohere!
    expect(CONNECT_PRESETS.find((entry) => entry.id === "cohere")).toEqual({ id: "cohere", name: preset.name, type: preset.type, baseUrl: preset.baseUrl, keyEnv: preset.keyEnv })
    expect(createConnectState("Cohere").target).toBe("cohere")
    let state = createConnectState()
    for (let index = 0; index < CONNECT_CHOICES.indexOf("cohere"); index++) state = connectKey(state, "\x1b[B").state
    expect(connectKey(state, "\r").state.target).toBe("cohere")
  })

  test("app masks keys; Tab only moves focus; Enter saves/tests, refreshes and selects namespaced models", async () => {
    const h = providersHarness({ dataDir: temp(), width: 100, height: 30, reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12 } }
      if (command.type === "models.list" || command.type === "session.model.set") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect Cohere")
    await h.type(PROXY)
    await h.type("\t")
    await h.type(KEY)
    expect(h.text()).toContain("chars")
    await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "cohere", baseUrl: PROXY, apiKey: KEY, enabled: true })
    expect(h.commands("providers.test")).toHaveLength(1)
    expect(h.text()).toContain("Cohere connected")
    await h.type("r")
    expect(h.commands("providers.refresh")).toHaveLength(1)
    await h.type("m")
    expect(h.app.page).toBe("model")
    await h.type("/")
    expect(h.text()).toContain("Command A")
    await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: `cohere:${MODEL}` } })
    expect(h.everything()).not.toContain(KEY)
  })

  test("env references refuse plain-HTTP public endpoints; error retries keep public fields and an empty key", async () => {
    const initial = createConnectState("cohere")
    for (const baseUrl of ["http://api.cohere.com/v2", "http://localhost.evil.test/v2", "http://user:key@localhost/v2", "http://127.0.0.1/v2?token=x"]) expect(validateConnect({ ...initial, viaEnv: true, values: { ...initial.values, baseUrl } })).toMatchObject({ ok: false, focus: 0, error: expect.stringContaining("loopback") })
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [provider] } }
      if (command.type === "providers.set") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: false, latencyMs: 1, error: "rejected [redacted:api-key]" } }
      return undefined
    } })
    await h.run("/connect cohere")
    expect(h.text()).toContain(PROXY)
    expect(h.text()).toContain("required")
    await h.type(`\t${KEY}\x05\r`)
    expect(h.commands("providers.set")[0]).toEqual({ type: "providers.set", provider: "cohere", baseUrl: PROXY, apiKeyEnv: "COHERE_API_KEY", enabled: true })
    expect(h.text()).toContain("Cohere saved, test failed")
    await h.type("t")
    expect(h.commands("providers.test")).toHaveLength(2)
    await h.type("e")
    expect(h.text()).toContain("COHERE_API_KEY")
    expect(h.text()).toContain(PROXY)
    await h.type("\x05")
    expect(h.text()).toContain("required")
    expect(h.everything()).not.toContain(KEY)
  })

  test("connect/provider screens fill bordered grids with header hints at contracted sizes", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      const form = createConnectState("cohere")
      for (const frame of [
        renderConnectPage({ state: form, width, height }),
        renderConnectPage({ state: { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("cohere") }, width, height }),
        renderConnectPage({ state: connectKey(form, "\x05").state, width, height }),
        renderProvidersPage({ state: { selected: 0, detail: false }, providers: [provider], width, height }),
        renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width, height }),
      ]) {
        const rows = frame.map(plain), text = rows.join("\n")
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
        expect(rows[0]).toContain("esc")
        expect(text).toContain("Cohere")
        expect(text).toContain("┌")
        expect(text).toContain("└")
      }
    }
  })

  test("provider enablement persists through its existing app factory", async () => {
    const stored = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [stored] } }
      if (command.type === "providers.set") { stored.enabled = command.enabled === true; return { ok: true, result: { provider: stored } } }
      return undefined
    } })
    await h.run("/providers")
    await h.type("\r")
    await h.type("e")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "cohere", enabled: false })
    expect(h.text()).toContain("off")
  })

  test("CLI login resolves Cohere and saves env auth without implicitly testing a provider", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "cohere", name: "Cohere", type: "cohere", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Cohere", "--base-url", PROXY, "--api-key-env", "COHERE_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "cohere", baseUrl: PROXY, apiKeyEnv: "COHERE_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
    expect(parseAutomation(["providers", "login", "--provider", "team", "--provider-type", "cohere", "--base-url", PROXY, "--api-key-env", "COHERE_API_KEY"])).toMatchObject({ ok: true, command: { providerType: "cohere" } })
    const custom = catalogHarness({ send: () => ({ ok: true, result: { providers: [] } }) })
    expect(await custom.run(["providers", "login", "--provider", "team", "--provider-type", "cohere", "--base-url", PROXY, "--api-key-env", "COHERE_API_KEY"])).toBe(0)
    expect(custom.sent.at(-1)).toEqual({ type: "providers.set", provider: "team", providerType: "cohere", baseUrl: PROXY, apiKeyEnv: "COHERE_API_KEY", enabled: true })
  })

  test("CLI startup and lazy Cohere page stay free of runtime schemas and backend imports", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/catalog-args"); const before = Object.keys(require.cache); await (await import("./src/ui/lazy-pages")).preload("connect"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ lazy: before.every((key) => !/view\\/(connect-page|providers-page)\\.ts$/.test(key)), bad: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || key.includes("/packages/engine-native/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key)) }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ lazy: true, bad: [] })
  })
})
