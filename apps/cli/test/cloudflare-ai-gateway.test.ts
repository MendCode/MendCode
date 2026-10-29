import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { AIG_ID, AIG_MODEL, AIG_MODELS, AIG_TOKEN, AIG_URL } from "../../../packages/engine-native/test/cloudflare-ai-gateway-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-aig-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: AIG_ID, type: "openai-compatible", baseUrl: AIG_URL, enabled: true, hasKey: true, source: "config", models: AIG_MODELS, cloudflareAiGateway: { accountId: "team", gatewayId: "coding", hasMetadata: true, hasCacheKey: true, cacheTtl: 60, skipCache: false, collectLog: false } }
const report = { ...REPORT, models: [...REPORT.models, ...AIG_MODELS.map((model) => ({ id: `${AIG_ID}:${model.id}`, name: `${model.name} · Cloudflare AI Gateway`, provider: AIG_ID, efforts: [] }))] }
async function fill(h: ReturnType<typeof providersHarness>) {
  await h.type(AIG_URL); await h.type("\r"); await h.type(`\x1b[200~${AIG_TOKEN}\x1b[201~`)
  await h.type("\r"); await h.type("team"); await h.type("\r"); await h.type("coding"); await h.type("\r"); await h.type(AIG_MODEL)
}

describe("B10.22 Cloudflare AI Gateway CLI factories", () => {
  test("appends the preset and preserves numeric shortcuts and native preset parity", () => {
    expect(CONNECT_CHOICES.filter((id) => id === AIG_ID)).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf(AIG_ID)).toBeGreaterThan(CONNECT_CHOICES.indexOf("mistral"))
    expect(CONNECT_CHOICES.slice(0, 10)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt"])
    const { id: _id, ...preset } = presetOf(AIG_ID)!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS[AIG_ID]!
    expect(preset).toEqual(native)
    expect(models).toEqual([])
    expect(defaultEnabled).toBe(false)
    for (const target of [AIG_ID, "Cloudflare AI Gateway", "cloudflare gateway"]) expect(createConnectState(target).target).toBe(AIG_ID)
  })

  test("Tab changes focus only; submission saves the token once, tests and selects a namespaced model", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: AIG_MODEL } }
      if (command.type === "models.list") return { ok: true, result: report }
      if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
      return undefined
    } })
    await h.run(`/connect ${AIG_ID}`)
    await h.type("\t"); expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\x1b[Z")
    await fill(h)
    expect(h.commands("providers.set")).toHaveLength(0)
    expect(h.everything()).not.toContain(AIG_TOKEN)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: AIG_ID, baseUrl: AIG_URL, apiKey: AIG_TOKEN, enabled: true, cloudflareAiGateway: { accountId: "team", gatewayId: "coding" }, models: [{ id: AIG_MODEL }] }])
    expect(h.commands("providers.test")).toHaveLength(1)
    expect(h.commands("providers.refresh")).toHaveLength(0)
    expect(h.text()).toContain("Cloudflare AI Gateway connected")
    await h.type("r"); expect(h.text()).toContain("2 gateway models retained")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type(AIG_MODEL); await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: `${AIG_ID}:${AIG_MODEL}` } })
    expect(h.everything()).not.toContain(AIG_TOKEN)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment mode clears typed secrets and validates endpoint, model prefix and routing inline", () => {
    const form = createConnectState(AIG_ID)
    let state = { ...form, values: { ...form.values, baseUrl: AIG_URL, key: AIG_TOKEN, models: AIG_MODEL } }
    state = connectKey(state, "\x05").state
    expect(state.values.key).toBe("")
    expect(validateConnect(state)).toMatchObject({ ok: true, submit: { provider: AIG_ID, apiKeyEnv: "CLOUDFLARE_API_TOKEN", apiKey: "", cloudflareAiGateway: { accountId: null, gatewayId: null }, models: [{ id: AIG_MODEL }] } })
    for (const baseUrl of ["http://gateway.ai.cloudflare.com/v1/a/g/compat", "http://u:p@localhost/compat", "http://localhost/compat?key=x", "http://localhost/compat#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...state, values: { ...state.values, models: "claude-without-provider" } })).toMatchObject({ ok: false, error: expect.stringContaining("provider/model") })
    expect(validateConnect({ ...state, values: { ...state.values, cloudflareGatewayId: "bad id" } })).toMatchObject({ ok: false, error: expect.stringContaining("routing") })
    expect(connectPaste(form, AIG_URL).values.baseUrl).toBe(AIG_URL)
  })

  test("save/test failures redact tokens, retry works and reopening keeps public settings with empty secrets", async () => {
    for (const phase of ["providers.set", "providers.test"]) {
      let fail = true
      let saved = false
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === "providers.list") return { ok: true, result: { providers: saved ? [provider] : [] } }
        if (command.type === phase && fail) return { ok: false, error: { code: "internal", message: `rejected ${AIG_TOKEN}` } }
        if (command.type === "providers.set") { saved = true; return { ok: true, result: { provider } } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1, model: AIG_MODEL } }
        return undefined
      } })
      await h.run(`/connect ${AIG_ID}`); await fill(h); await h.type("\r")
      expect(h.everything()).not.toContain(AIG_TOKEN)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      if (phase === "providers.test") {
        fail = false
        await h.type("t"); expect(h.text()).toContain("Cloudflare AI Gateway connected")
      }
      await h.type("\x1b"); await h.type("\x1b")
      if (saved) {
        await h.run(`/connect ${AIG_ID}`)
        expect(h.text()).toContain("coding")
        expect(h.text()).toContain(AIG_MODEL)
        expect(h.text()).toContain("required")
        expect(h.everything()).not.toContain(AIG_TOKEN)
        await h.type("\x1b"); await h.type("\x1b")
      }
    }
  }, 15_000)

  test("provider details expose option presence, toggling is immediate and removal requires confirmation", async () => {
    let current = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.remove") return { ok: true, result: { providers: [] } }
      return undefined
    } })
    await h.run("/providers"); await h.type("\r")
    expect(h.text()).toContain("coding")
    expect(h.text()).toContain("configured")
    expect(h.text()).toContain("60s")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: AIG_ID, enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: AIG_ID }])
    await h.type("\x1b")
  })

  test("connection states fit all target sizes, with bordered panels, compact layout and header hints", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState(AIG_ID)
      const states = [form, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf(AIG_ID) }, connectKey(form, "\x05").state, { ...form, step: "result" as const, result: { provider: AIG_ID, ok: false, error: "proxy unavailable" } }]
      for (const state of states) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Cloudflare AI Gateway")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login accepts unified model/routing flags and makes no test or refresh request", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: AIG_ID, name: "Cloudflare AI Gateway", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Cloudflare AI Gateway", "--base-url", AIG_URL, "--api-key-env", "CLOUDFLARE_API_TOKEN", "--models", AIG_MODEL, "--cloudflare-account", "team", "--cloudflare-gateway", "coding"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: AIG_ID, baseUrl: AIG_URL, apiKeyEnv: "CLOUDFLARE_API_TOKEN", enabled: true, models: [{ id: AIG_MODEL }], cloudflareAiGateway: { accountId: "team", gatewayId: "coding" } })
    expect(h.sent.some((command) => ["providers.test", "providers.refresh"].includes(command.type))).toBe(false)
  })

  test("new CLI modules keep runtime schemas and daemon imports out of the startup graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
