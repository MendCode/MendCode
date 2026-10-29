import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS, presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const KEY = "alibaba-ui-fixture-never-print-0123456789"
const endpoint = "http://127.0.0.1:1234/v1"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-alibaba-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "alibaba", type: "openai-compatible", baseUrl: endpoint, enabled: true, hasKey: true, source: "config", models: [{ id: "qwen-plus" }, { id: "qwen3-coder-plus" }] }
const report = { ...REPORT, models: [...REPORT.models, ...provider.models.map((model) => ({ id: `alibaba:${model.id}`, name: `${model.id} · Alibaba`, provider: "alibaba", efforts: [] }))] }

describe("B10.13 Alibaba CLI factories", () => {
  test("preset tables agree and Alibaba is appended without moving numeric shortcuts", () => {
    expect(CONNECT_CHOICES.slice(0, 20)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity"])
    expect(CONNECT_CHOICES[20]).toBe("alibaba")
    const { id: _id, ...preset } = presetOf("alibaba")!
    const { models: _models, defaultEnabled: _enabled, ...native } = PROVIDER_PRESETS.alibaba!
    expect(preset).toEqual(native)
    expect(CONNECT_PRESETS.find((preset) => preset.id === "alibaba")).toBeDefined()
    expect(createConnectState("Alibaba").target).toBe("alibaba")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("app saves a masked token once, tests, refreshes and opens the Alibaba model picker", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { alibaba: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "qwen-plus" } }
      if (command.type === "models.list") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect Alibaba")
    expect(h.text()).toContain("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
    await h.type(endpoint); await h.type("\r"); await h.type(`\x1b[200~${KEY}\x1b[201~`)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "alibaba", baseUrl: endpoint, apiKey: KEY, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "alibaba" }])
    expect(h.text()).toContain("Alibaba connected")
    await h.type("r")
    expect(h.commands("providers.refresh")).toEqual([{ type: "providers.refresh", provider: "alibaba" }])
    expect(h.text()).toContain("2 models loaded")
    await h.type("m")
    expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("qwen")
    expect(h.text()).toContain("qwen3-coder-plus")
    expect(h.everything()).not.toContain(KEY)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment reference remains opt-in, needs no URL (public default) and refuses plain-HTTP public URLs", () => {
    let state = connectKey(createConnectState("alibaba"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "alibaba", apiKeyEnv: "DASHSCOPE_API_KEY", enabled: true } })
    state = connectPaste(state, endpoint)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "alibaba", baseUrl: endpoint, apiKeyEnv: "DASHSCOPE_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("DASHSCOPE_API_KEY")
    for (const baseUrl of ["http://dashscope.aliyuncs.com/v1", "http://127.0.0.1.example/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) {
      expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    }
  })

  test("failed save and failed test never draw the echoed token; editing clears it", async () => {
    for (const refuse of [true, false]) {
      const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? refuse ? { ok: false, error: { code: "invalid_command", message: `rejected ${KEY}` } } : { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `rejected ${KEY}` } } : undefined })
      await h.run("/connect alibaba"); await h.type(endpoint); await h.type("\r"); await h.type(KEY); await h.type("\r")
      expect(h.everything()).not.toContain(KEY)
      expect(h.text()).toContain(refuse ? "required" : "Alibaba saved, test failed")
      expect(h.commands("providers.test")).toHaveLength(refuse ? 0 : 1)
      if (!refuse) { await h.type("e"); expect(h.text()).toContain("Endpoint") }
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("connection states and management use header hints and closed panels at every requested size", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("alibaba")
      for (const state of [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("alibaba") }]) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Alibaba")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("Alibaba")
      expect(rows.join("\n")).toContain("qwen-plus")
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login by display name sends URL and environment reference without testing implicitly", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "alibaba", name: "Alibaba", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Alibaba", "--base-url", endpoint, "--api-key-env", "DASHSCOPE_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "alibaba", baseUrl: endpoint, apiKeyEnv: "DASHSCOPE_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
  })

  test("Alibaba keeps the terminal startup module graph free of daemon and protocol schemas", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
