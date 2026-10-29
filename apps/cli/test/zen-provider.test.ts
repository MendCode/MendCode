import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { ZEN_MODELS, ZEN_TOKEN, ZEN_URL } from "../../../packages/engine-native/test/zen-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS, presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-zen-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "opencode", type: "openai-compatible", baseUrl: ZEN_URL, enabled: true, hasKey: true, source: "config", models: ZEN_MODELS }
const report = { ...REPORT, models: [...REPORT.models, ...ZEN_MODELS.map((model) => ({ id: `opencode:${model.id}`, name: `${model.id} · OpenCode Zen`, provider: "opencode", efforts: [] }))] }

describe("B10.15 OpenCode Zen connection", () => {
  test("appends Zen without moving existing shortcuts and keeps native and CLI presets aligned", () => {
    expect(CONNECT_CHOICES.slice(0, 21)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba"])
    expect(CONNECT_CHOICES[21]).toBe("opencode")
    const { id: _id, ...preset } = presetOf("opencode")!
    const { models: _models, defaultEnabled, ...native } = PROVIDER_PRESETS.opencode!
    expect(preset).toEqual(native)
    expect(defaultEnabled).toBe(false)
    expect(CONNECT_PRESETS[19]!.id).toBe("opencode")
    for (const alias of ["opencode", "OpenCode Zen", "zen", "OpenCode/Zen"]) expect(createConnectState(alias).target).toBe("opencode")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("app saves a masked token once, loads the catalog before testing and exposes models", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { opencode: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "gpt-fixture" } }
      if (command.type === "models.list") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect zen")
    await h.type(ZEN_URL); await h.type("\r"); await h.type(ZEN_TOKEN)
    expect(h.text()).toContain("•••")
    expect(h.everything()).not.toContain(ZEN_TOKEN)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "opencode", baseUrl: ZEN_URL, apiKey: ZEN_TOKEN, enabled: true }])
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.text()).toContain("OpenCode Zen connected")
    await h.type("r"); expect(h.text()).toContain("4 models loaded")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("gpt-fixture"); expect(h.text()).toContain("gpt-fixture")
    expect(h.everything()).not.toContain(ZEN_TOKEN)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment reference needs no URL (public default) and rejects anonymous tokens and unsafe URLs", () => {
    let state = connectKey(createConnectState("opencode"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "opencode", apiKeyEnv: "OPENCODE_API_KEY", enabled: true } })
    state = connectPaste(state, ZEN_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "opencode", baseUrl: ZEN_URL, apiKeyEnv: "OPENCODE_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("OPENCODE_API_KEY")
    for (const baseUrl of ["http://opencode.ai/zen/v1", "http://127.0.0.1.evil/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...state, viaEnv: false, values: { ...state.values, key: "public" } })).toMatchObject({ ok: false, error: expect.stringContaining("anonymous") })
  })

  test("save, refresh and test failures scrub tokens and refresh failure does not test", async () => {
    for (const phase of ["providers.set", "providers.refresh", "providers.test"]) {
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === phase) return { ok: false, error: { code: "internal", message: `rejected ${ZEN_TOKEN}` } }
        if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1 } }
        return undefined
      } })
      await h.run("/connect opencode"); await h.type(ZEN_URL); await h.type("\r"); await h.type(ZEN_TOKEN); await h.type("\r")
      expect(h.everything()).not.toContain(ZEN_TOKEN)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      if (phase === "providers.refresh") { expect(h.text()).toContain("saved, model refresh failed"); expect(h.text()).not.toContain("test failed") }
      expect(h.app.editor.text).toBe("")
      if (phase !== "providers.set") { await h.type("e"); expect(h.text()).toContain("Endpoint") }
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("connection and provider panels fit compact and large terminals with header hints", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("opencode")
      for (const state of [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("opencode") }]) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("OpenCode Zen")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("OpenCode Zen")
      expect(rows.join("\n")).toContain("gpt-fixture")
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login by display name sends the environment reference with no implicit requests", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "opencode", name: "OpenCode Zen", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "OpenCode Zen", "--base-url", ZEN_URL, "--api-key-env", "OPENCODE_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "opencode", baseUrl: ZEN_URL, apiKeyEnv: "OPENCODE_API_KEY", enabled: true })
    expect(h.sent.some((command) => ["providers.test", "providers.refresh"].includes(command.type))).toBe(false)
  })

  test("Zen keeps daemon and protocol schemas out of the terminal startup graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
