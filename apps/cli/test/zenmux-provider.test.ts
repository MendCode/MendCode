import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { ZENMUX_MODELS, ZENMUX_TOKEN, ZENMUX_URL } from "../../../packages/engine-native/test/zenmux-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-zenmux-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "zenmux", type: "openai-compatible", baseUrl: ZENMUX_URL, enabled: true, hasKey: true, source: "config", models: ZENMUX_MODELS }
const report = { ...REPORT, models: [...REPORT.models, ...ZENMUX_MODELS.map((model) => ({ id: `zenmux:${model.id}`, name: `${model.name} · Zenmux`, provider: "zenmux", efforts: [] }))] }

describe("B10.19 Zenmux CLI factories", () => {
  test("appends the provider, preserves numeric shortcuts and aligns both preset tables", () => {
    expect(CONNECT_CHOICES.slice(0, 25)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core"])
    expect(CONNECT_CHOICES[25]).toBe("zenmux")
    const { id: _id, ...preset } = presetOf("zenmux")!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS.zenmux!
    expect(preset).toEqual(native)
    expect(models).toEqual([])
    expect(defaultEnabled).toBe(false)
    expect(createConnectState("Zenmux").target).toBe("zenmux")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("saves the masked token once, refreshes before testing and selects a zenmux model", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "vendor/reasoning-fixture" } }
      if (command.type === "models.list") return { ok: true, result: report }
      if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
      return undefined
    } })
    await h.run("/connect Zenmux")
    expect(h.text()).toContain("https://zenmux.ai/api/v1")
    await h.type(ZENMUX_URL); await h.type("\r"); await h.type(`\x1b[200~${ZENMUX_TOKEN}\x1b[201~`)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(ZENMUX_TOKEN)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "zenmux", baseUrl: ZENMUX_URL, apiKey: ZENMUX_TOKEN, enabled: true }])
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(ZENMUX_TOKEN))).toBe(false)
    expect(h.text()).toContain("Zenmux connected")
    await h.type("r"); expect(h.text()).toContain("2 models loaded")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("vendor/reasoning-fixture"); expect(h.text()).toContain("vendor/reasoning-fixture")
    await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "zenmux:vendor/reasoning-fixture" } })
    expect(h.everything()).not.toContain(ZENMUX_TOKEN)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment references need no URL (public default) and plain-HTTP public or capability-bearing URLs fail inline", () => {
    let state = connectKey(createConnectState("zenmux"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "zenmux", apiKeyEnv: "ZENMUX_API_KEY", enabled: true } })
    state = connectPaste(state, ZENMUX_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "zenmux", baseUrl: ZENMUX_URL, apiKeyEnv: "ZENMUX_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("ZENMUX_API_KEY")
    for (const baseUrl of ["http://zenmux.ai/api/v1", "http://127.0.0.1.evil/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
  })

  test("failed save, refresh and test redact tokens; refresh failure skips testing and supports retry", async () => {
    for (const phase of ["providers.set", "providers.refresh", "providers.test"]) {
      let fail = true
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === phase && fail) return { ok: false, error: { code: "internal", message: `rejected ${ZENMUX_TOKEN}` } }
        if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1, model: "vendor/reasoning-fixture" } }
        return undefined
      } })
      await h.run("/connect zenmux"); await h.type(ZENMUX_URL); await h.type("\r"); await h.type(ZENMUX_TOKEN); await h.type("\r")
      expect(h.everything()).not.toContain(ZENMUX_TOKEN)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      if (phase === "providers.refresh") {
        expect(h.text()).toContain("saved, model refresh failed")
        expect(h.text()).not.toContain("test failed")
        fail = false
        await h.type("r"); expect(h.commands("providers.refresh")).toHaveLength(2)
        expect(h.commands("providers.test")).toHaveLength(1)
        expect(h.text()).toContain("Zenmux connected")
        expect(h.text()).toContain("2 models loaded")
        expect(h.text()).not.toContain("refresh failed")
        await h.type("t"); expect(h.text()).toContain("Zenmux connected")
      }
      if (phase !== "providers.set") { await h.type("e"); expect(h.text()).toContain("Endpoint"); expect(h.text()).toContain("required") }
      expect(h.app.editor.text).toBe("")
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("provider management toggles and removes through daemon commands", async () => {
    let current = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.remove") return { ok: true, result: { providers: [] } }
      return undefined
    } })
    await h.run("/providers"); expect(h.text()).toContain("Zenmux")
    await h.type("\r"); expect(h.text()).toContain("vendor/reasoning-fixture")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "zenmux", enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: "zenmux" }])
    expect(h.text()).toContain("No providers")
    expect(h.text()).toContain("a add · esc back")
    expect(h.text()).toContain("┌")
    await h.type("\x1b")
  })

  test("all connection states fit compact and wide grids with visible focus and header hints", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("zenmux")
      const states = [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("zenmux") }, { ...form, step: "result" as const, result: { provider: "zenmux", ok: false, note: "Model refresh failed", error: "proxy unavailable" } }]
      for (const state of states) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Zenmux")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("vendor/reasoning-fixture")
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login resolves the display name and stays explicit about requests", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "zenmux", name: "Zenmux", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Zenmux", "--base-url", ZENMUX_URL, "--api-key-env", "ZENMUX_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "zenmux", baseUrl: ZENMUX_URL, apiKeyEnv: "ZENMUX_API_KEY", enabled: true })
    expect(h.sent.some((command) => ["providers.test", "providers.refresh"].includes(command.type))).toBe(false)
  })

  test("terminal startup remains free of daemon and protocol schemas", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
