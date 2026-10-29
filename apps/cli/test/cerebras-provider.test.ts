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

const KEY = "cerebras-ui-fixture-never-print"
const MODEL = "gpt-oss-120b"
const PROXY = "http://127.0.0.1:1234/v1"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-cerebras-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "cerebras", type: "openai-compatible", baseUrl: PROXY, enabled: true, hasKey: true, source: "config", models: [{ id: MODEL }] }
const report: ModelsReport = { ...REPORT, models: [{ id: `cerebras:${MODEL}`, name: "GPT OSS 120B · Cerebras", provider: "cerebras", efforts: ["low", "medium", "high"], variants: { high: { parameters: { reasoning_effort: "high" } } } }], defaults: { model: `cerebras:${MODEL}` }, effective: { model: `cerebras:${MODEL}` } }

describe("B10.09 Cerebras terminal", () => {
  test("appends the preset without moving existing shortcuts; engine and schema-free UI metadata agree", async () => {
    expect(CONNECT_CHOICES.slice(0, 18)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral"])
    expect(CONNECT_CHOICES.filter((id) => id === "cerebras")).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf("cerebras")).toBeGreaterThan(CONNECT_CHOICES.indexOf("mistral"))
    const { PROVIDER_PRESETS } = await import("../../../packages/engine-native/src/provider-presets")
    expect(CONNECT_PRESETS.find((preset) => preset.id === "cerebras")).toEqual({ id: "cerebras", name: PROVIDER_PRESETS.cerebras!.name, type: PROVIDER_PRESETS.cerebras!.type, baseUrl: PROVIDER_PRESETS.cerebras!.baseUrl, keyEnv: PROVIDER_PRESETS.cerebras!.keyEnv })
    expect(createConnectState("Cerebras").target).toBe("cerebras")
    let state = createConnectState()
    for (let index = 0; index < CONNECT_CHOICES.indexOf("cerebras"); index++) state = connectKey(state, "\x1b[B").state
    expect(connectKey(state, "\r").state.target).toBe("cerebras")
  })

  test("app factory masks keys, saves/tests only on Enter, refreshes and opens namespaced models/variants", async () => {
    const h = providersHarness({ dataDir: temp(), width: 100, height: 30, reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12 } }
      if (command.type === "models.list" || command.type === "session.model.set") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect Cerebras")
    await h.type(PROXY)
    await h.type("\t")
    await h.type(KEY)
    expect(h.text()).toContain("chars")
    expect(h.commands("providers.set")).toHaveLength(0)
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "cerebras", baseUrl: PROXY, apiKey: KEY, enabled: true })
    expect(h.commands("providers.test")).toHaveLength(1)
    expect(h.text()).toContain("Cerebras connected")
    await h.type("r")
    expect(h.commands("providers.refresh")).toHaveLength(1)
    await h.type("m")
    expect(h.app.page).toBe("model")
    await h.type("/")
    expect(h.text()).toContain("GPT OSS 120B")
    await h.type("\r")
    expect(h.text()).toContain("high")
    expect(h.everything()).not.toContain(KEY)
  })

  test("environment reference is explicit and failed tests keep safe retry/edit controls", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: "rejected [redacted:api-key]" } } : undefined })
    await h.run("/connect cerebras")
    await h.type(PROXY)
    await h.type("\t")
    await h.type(KEY)
    await h.type("\x05")
    expect(h.text()).toContain("CEREBRAS_API_KEY")
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toEqual({ type: "providers.set", provider: "cerebras", baseUrl: PROXY, apiKeyEnv: "CEREBRAS_API_KEY", enabled: true })
    expect(h.text()).toContain("Cerebras saved, test failed")
    expect(h.everything()).not.toContain(KEY)
    await h.type("t")
    expect(h.commands("providers.test")).toHaveLength(2)
    await h.type("e")
    expect(h.text()).toContain("CEREBRAS_API_KEY")
    expect(h.text()).toContain(PROXY)
    await h.type("\x05")
    expect(h.text()).toContain("required")
  })

  test("refuses plain-HTTP public endpoints even with an env reference; a blank endpoint uses the public default", async () => {
    const initial = createConnectState("cerebras")
    for (const baseUrl of ["http://api.cerebras.ai/v1", "http://localhost.evil.test/v1", "http://user:key@localhost/v1", "http://127.0.0.1/v1?token=x"]) expect(validateConnect({ ...initial, viaEnv: true, values: { ...initial.values, baseUrl } })).toMatchObject({ ok: false, focus: 0, error: expect.stringContaining("loopback") })
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.list" ? { ok: true, result: { providers: [provider] } } : undefined })
    await h.run("/connect cerebras")
    expect(h.text()).toContain(PROXY)
    expect(h.text()).toContain("required")
    await h.type("\x15http://api.cerebras.ai/v1\x05\r")
    expect(h.text()).toContain("Cerebras endpoint requires HTTPS or loopback HTTP")
    expect(h.commands("providers.set")).toHaveLength(0)
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type(`\x15${PROXY}\t`)
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ baseUrl: PROXY, apiKeyEnv: "CEREBRAS_API_KEY", enabled: true })
    expect(h.everything()).not.toContain(KEY)
  })

  test("connect/provider screens use bordered grids and header hints at all contracted sizes", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      const form = createConnectState("cerebras")
      for (const frame of [
        renderConnectPage({ state: form, width, height }),
        renderConnectPage({ state: { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("cerebras") }, width, height }),
        renderConnectPage({ state: connectKey(form, "\x05").state, width, height }),
        renderProvidersPage({ state: { selected: 0, detail: false }, providers: [provider], width, height }),
        renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width, height }),
      ]) {
        const rows = frame.map(plain), text = rows.join("\n")
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
        expect(rows[0]).toContain("esc")
        expect(text).toContain("Cerebras")
        expect(text).toContain("┌")
        expect(text).toContain("└")
      }
    }
  })

  test("provider management toggles persisted enablement through the daemon", async () => {
    const stored = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [stored] } }
      if (command.type === "providers.set") { stored.enabled = command.enabled === true; return { ok: true, result: { provider: stored } } }
      return undefined
    } })
    await h.run("/providers")
    await h.type("\r")
    await h.type("e")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "cerebras", enabled: false })
    expect(h.text()).toContain("off")
  })

  test("CLI login resolves the label/key reference without an implicit paid test", async () => {
    expect(parseAutomation(["providers", "login", "--provider", "Cerebras", "--api-key-env", "CEREBRAS_API_KEY"])).toMatchObject({ ok: true })
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "cerebras", name: "Cerebras", type: "openai-compatible", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Cerebras", "--base-url", PROXY, "--api-key-env", "CEREBRAS_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "cerebras", baseUrl: PROXY, apiKeyEnv: "CEREBRAS_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
  })

  test("Cerebras UI metadata stays lazy and free of protocol schemas/engine imports", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/catalog-args"); const before = Object.keys(require.cache); await (await import("./src/ui/lazy-pages")).preload("connect"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ lazy: before.every((key) => !/view\\/(connect-page|providers-page)\\.ts$/.test(key)), bad: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || key.includes("/packages/engine-native/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key)) }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ lazy: true, bad: [] })
  })
})
