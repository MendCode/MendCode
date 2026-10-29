import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { parseAutomation } from "../src/automation"
import { connectKey, createConnectState, renderConnectPage, validateConnect, CONNECT_CHOICES } from "../src/view/connect-page"
import { CONNECT_PRESETS, presetOf, PROVIDER_TYPE_CHOICES } from "../src/view/provider-presets"
import { textWidth } from "../src/view/wrap"
import { renderProvidersPage } from "../src/view/providers-page"
import { catalogHarness } from "./catalog-harness"
import { providersHarness, plain, REPORT } from "./providers-harness"

const KEY = "gemini-ui-fixture-never-print"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-google-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "google", type: "google", baseUrl: "http://127.0.0.1:1234/v1beta", enabled: true, hasKey: true, source: "config", models: [{ id: "gemini-2.5-flash" }] }
const report = { ...REPORT, models: [...REPORT.models, { id: "google:gemini-2.5-flash", name: "Gemini 2.5 Flash · Google Gemini", provider: "google", efforts: ["low", "medium", "high"], contextWindow: 1_048_576 }] }

describe("B10.03 Gemini terminal", () => {
  test("Google choice is appended, old numeric shortcuts survive and the native format is available", () => {
    expect(CONNECT_CHOICES.slice(0, 10)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt"])
    expect(CONNECT_CHOICES.slice(10, 12)).toEqual(["google", "github-copilot"])
    expect(CONNECT_PRESETS.slice(8, 10).map(({ id, type }) => ({ id, type }))).toEqual([{ id: "google", type: "google" }, { id: "github-copilot", type: "github-copilot" }])
    expect(PROVIDER_TYPE_CHOICES[3]).toBe("google")
    expect(createConnectState("Google Gemini").target).toBe("google")
    let state = createConnectState()
    for (let i = 0; i < CONNECT_CHOICES.indexOf("google"); i++) state = connectKey(state, "\x1b[B").state
    expect(connectKey(state, "\r").state.target).toBe("google")
  })

  test("app: masked key, one save, native test, refresh and namespaced model catalog", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { google: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
      if (command.type === "providers.set") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "gemini-2.5-flash" } }
      if (command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "models.list") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect google")
    expect(h.text()).toContain("Google Gemini")
    expect(h.text()).toContain("googleapis.com/v1beta")
    await h.type(KEY)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "google", apiKey: KEY, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "google" }])
    expect(h.text()).toContain("Google Gemini connected")
    await h.type("r")
    expect(h.commands("providers.refresh")).toHaveLength(1)
    expect(h.text()).toContain("1 model loaded")
    await h.type("m")
    expect(h.app.page).toBe("model")
    expect(h.everything()).toContain("Google Gemini")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\x1b")
  }, 15_000)

  test("environment opt-in saves the variable name; failed tests scrub the pasted key", async () => {
    let state = connectKey(createConnectState("google"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "google", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("GOOGLE_GENERATIVE_AI_API_KEY")
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `rejected ${KEY}` } } : undefined })
    await h.run("/connect google"); await h.type(KEY); await h.type("\r")
    expect(h.text()).toContain("Google Gemini saved, test failed")
    expect(h.everything()).not.toContain(KEY)
    await h.type("e")
    expect(h.text()).toContain("required")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("forms and selected provider stay bordered and unclipped at compact and wide sizes", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const google = createConnectState("google")
      for (const state of [google, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("google") }, connectKey(google, "\x05").state]) {
        const rows = renderConnectPage({ state, providers: [{ ...provider, enabled: false }], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Google Gemini")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
      }
    }
  })

  test("CLI login by provider name or custom native format uses the existing commands", async () => {
    expect(parseAutomation(["providers", "login", "--provider", "local-gemini", "--provider-type", "google", "--base-url", "http://127.0.0.1:1234/v1beta", "--api-key-env", "TEAM_KEY"])).toMatchObject({ ok: true, command: { providerType: "google" } })
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "google", name: "Google Gemini", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Google Gemini", "--api-key-env", "GOOGLE_GENERATIVE_AI_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "google", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
    const custom = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "local-gemini", name: "Local Gemini", type: "google", authMode: "api-key" }] } : {} }) })
    expect(await custom.run(["providers", "login", "--provider", "local-gemini", "--api-key-env", "TEAM_KEY"])).toBe(0)
    expect(custom.sent.at(-1)).toEqual({ type: "providers.set", provider: "local-gemini", apiKeyEnv: "TEAM_KEY", enabled: true })
    expect(presetOf("google")!.keyEnv).toBe("GOOGLE_GENERATIVE_AI_API_KEY")
  })

  test("Gemini management uses header hints, closed panels and wrapped endpoint details", () => {
    for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) {
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("Google Gemini")
      expect(rows.join("\n")).toContain("┌")
      expect(rows.join("\n")).toContain("└")
      expect(rows.join("\n")).toContain(provider.baseUrl)
    }
  })

  test("native preset never pulls schemas, zod or daemon into the terminal module graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ bad: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key)) }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ bad: [] })
  })
})
