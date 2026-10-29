import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { parseAutomation } from "../src/automation"
import { connectKey, createConnectState, renderConnectPage, validateConnect, CONNECT_CHOICES } from "../src/view/connect-page"
import { CONNECT_PRESETS, PROVIDER_TYPE_CHOICES } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { providersHarness, plain, REPORT } from "./providers-harness"

const KEY = "xai-ui-private-fixture-never-print"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-xai-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "xai", type: "xai", baseUrl: "https://api.x.ai/v1", enabled: true, hasKey: true, source: "config", models: [{ id: "grok-3-mini" }] }
const report = { ...REPORT, models: [{ id: "xai:grok-3-mini", name: "Grok 3 Mini · xAI", provider: "xai", efforts: ["low", "high"] }] }

describe("B10.06 xAI terminal", () => {
  test("choice and wire format append without moving old shortcuts; /connect xAI resolves the preset", () => {
    expect(CONNECT_CHOICES.slice(0, 10)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt"])
    expect(CONNECT_CHOICES[16]).toBe("xai")
    expect(CONNECT_PRESETS[14]).toMatchObject({ id: "xai", type: "xai", keyEnv: "XAI_API_KEY" })
    expect(PROVIDER_TYPE_CHOICES[5]).toBe("xai")
    expect(createConnectState("xAI").target).toBe("xai")
    let state = createConnectState()
    for (let i = 0; i < CONNECT_CHOICES.indexOf("xai"); i++) state = connectKey(state, "\x1b[B").state
    expect(connectKey(state, "\r").state.target).toBe("xai")
  })

  test("app: masked key, explicit save/test, refresh and namespaced model selection", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { xai: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "grok-3-mini" } }
      if (command.type === "models.list") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect xai")
    expect(h.text()).toContain("xAI"); expect(h.text()).toContain("api.x.ai/v1")
    await h.type(KEY)
    expect(h.text()).toContain("chars"); expect(h.everything()).not.toContain(KEY)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "xai", apiKey: KEY, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "xai" }])
    expect(h.text()).toContain("xAI connected")
    await h.type("r"); expect(h.commands("providers.refresh")).toHaveLength(1)
    await h.type("m"); expect(h.app.page).toBe("model")
    expect(h.text()).toContain("xai:grok-3-mini")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\x1b")
  })

  test("environment auth sends only its reference; failed testing scrubs the pasted key and allows retry", async () => {
    const env = connectKey(createConnectState("xai"), "\x05").state
    expect(validateConnect(env)).toEqual({ ok: true, submit: { provider: "xai", apiKeyEnv: "XAI_API_KEY", enabled: true } })
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `rejected ${KEY}` } } : undefined })
    await h.run("/connect xai"); await h.type(KEY); await h.type("\r")
    expect(h.text()).toContain("xAI saved, test failed"); expect(h.everything()).not.toContain(KEY)
    await h.type("e"); expect(h.text()).toContain("required")
    await h.type("\x1b"); await h.type("\x1b")
  })

  test("connect and provider management use closed panels, header hints and compact layouts", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      const state = createConnectState("xai")
      const renders = [
        renderConnectPage({ state, width, height }),
        renderConnectPage({ state: { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("xai") }, width, height }),
        renderConnectPage({ state: connectKey(state, "\x05").state, width, height }),
        renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width, height }),
      ]
      for (const frame of renders) {
        const rows = frame.map(plain), text = rows.join("\n")
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
        expect(rows[0]).toContain("esc")
        expect(text).toContain("xAI"); expect(text).toContain("┌"); expect(text).toContain("└")
      }
    }
  })

  test("CLI login by label/custom xAI type uses the catalog and does not run a paid test", async () => {
    expect(parseAutomation(["providers", "login", "--provider", "proxy", "--provider-type", "xai", "--base-url", "http://127.0.0.1:1234/v1", "--api-key-env", "TEAM_XAI_KEY"])).toMatchObject({ ok: true, command: { providerType: "xai" } })
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "xai", name: "xAI", type: "xai", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "xAI", "--api-key-env", "XAI_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "xai", apiKeyEnv: "XAI_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
    const custom = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [] } : {} }) })
    expect(await custom.run(["providers", "login", "--provider", "proxy", "--provider-type", "xai", "--base-url", "http://127.0.0.1:1234/v1", "--api-key-env", "TEAM_XAI_KEY"])).toBe(0)
    expect(custom.sent.at(-1)).toEqual({ type: "providers.set", provider: "proxy", providerType: "xai", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "TEAM_XAI_KEY", enabled: true })
  })

  test("xAI preset remains schema-free and its connect/provider pages remain lazy", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/catalog-args"); const before = Object.keys(require.cache); await (await import("./src/ui/lazy-pages")).preload("connect"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ lazy: before.every((key) => !/view\\/(connect-page|providers-page)\\.ts$/.test(key)), bad: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key)) }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0); expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ lazy: true, bad: [] })
  })
})
