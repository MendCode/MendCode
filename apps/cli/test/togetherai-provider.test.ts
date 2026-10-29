import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS, presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const KEY = "togetherai-ui-fixture-never-print-0123456789"
const MODEL = "openai/gpt-oss-120b"
const endpoint = "http://127.0.0.1:1234/v1"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-togetherai-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "togetherai", type: "openai-compatible", baseUrl: endpoint, enabled: true, hasKey: true, source: "config", models: [{ id: MODEL, effort: true, variants: { high: { effort: "high" } } }] }
const report: ModelsReport = { ...REPORT, models: [...REPORT.models, { id: `togetherai:${MODEL}`, name: "GPT-OSS 120B", provider: "togetherai", efforts: ["low", "medium", "high"], variants: { high: { effort: "high" } } }] }

describe("B10.11 TogetherAI CLI factories", () => {
  test("preset tables match and TogetherAI is appended, preserving numeric shortcuts", () => {
    expect(CONNECT_PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(PROVIDER_PRESETS).sort())
    expect(CONNECT_CHOICES.filter((id) => id === "togetherai")).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf("togetherai")).toBeGreaterThan(CONNECT_CHOICES.indexOf("mistral"))
    expect(CONNECT_CHOICES.slice(0, 12)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot"])
    const { id: _id, ...preset } = presetOf("togetherai")!
    const { models: _models, defaultEnabled: _enabled, ...native } = PROVIDER_PRESETS.togetherai!
    expect(preset).toEqual(native)
    expect(createConnectState("TogetherAI").target).toBe("togetherai")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("app saves the masked proxy token once, tests, refreshes and opens the model picker", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { togetherai: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: MODEL } }
      if (command.type === "models.list") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect TogetherAI")
    expect(h.text()).toContain("https://api.together.ai/v1")
    await h.type(endpoint); await h.type("\r"); await h.type(`\x1b[200~${KEY}\x1b[201~`)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "togetherai", baseUrl: endpoint, apiKey: KEY, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "togetherai" }])
    expect(h.text()).toContain("TogetherAI connected")
    expect(h.text()).not.toContain("┃")
    await h.type("r")
    expect(h.commands("providers.refresh")).toEqual([{ type: "providers.refresh", provider: "togetherai" }])
    expect(h.text()).toContain("1 model loaded")
    await h.type("m")
    expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("TogetherAI")
    expect(h.text()).toContain("GPT-OSS 120B")
    expect(h.everything()).not.toContain(KEY)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment references remain opt-in and need no URL (public default); no token remains in state", () => {
    let state = connectKey(createConnectState("togetherai"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "togetherai", apiKeyEnv: "TOGETHER_API_KEY", enabled: true } })
    state = connectPaste(state, endpoint)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "togetherai", baseUrl: endpoint, apiKeyEnv: "TOGETHER_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("TOGETHER_API_KEY")
    for (const baseUrl of ["http://api.together.ai/v1", "http://127.0.0.1.example/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    let typed = createConnectState("togetherai")
    typed = connectKey(connectPaste(typed, endpoint), "\r").state
    typed = connectPaste(typed, KEY)
    const submitted = connectKey(typed, "\r")
    expect(submitted.action).toMatchObject({ type: "submit", submit: { apiKey: KEY } })
    expect(JSON.stringify(submitted.state)).not.toContain(KEY)
  })

  test("save/test failures redact echoed tokens; editing discards the credential", async () => {
    for (const refuse of [true, false]) {
      const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? refuse ? { ok: false, error: { code: "invalid_command", message: `rejected ${KEY}` } } : { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `rejected ${KEY}` } } : undefined })
      await h.run("/connect togetherai"); await h.type(endpoint); await h.type("\r"); await h.type(KEY); await h.type("\r")
      expect(h.everything()).not.toContain(KEY)
      expect(h.text()).toContain(refuse ? "required" : "TogetherAI saved, test failed")
      expect(h.commands("providers.test")).toHaveLength(refuse ? 0 : 1)
      if (!refuse) { await h.type("e"); expect(h.text()).toContain("Endpoint"); expect(h.text()).toContain("required") }
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("form, environment, selected preset and management keep panels/header hints within all viewports", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("togetherai")
      for (const state of [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("togetherai") }]) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("TogetherAI")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("TogetherAI")
      expect(rows.join("\n")).toContain(MODEL)
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login resolves the display name and sends URL/env reference without implicit service calls", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "togetherai", name: "TogetherAI", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "TogetherAI", "--base-url", endpoint, "--api-key-env", "TOGETHER_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "togetherai", baseUrl: endpoint, apiKeyEnv: "TOGETHER_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test" || command.type === "providers.refresh")).toBe(false)
  })

  test("TogetherAI does not load daemon, engine or protocol schemas in the terminal startup graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || key.includes("/packages/engine-native/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
