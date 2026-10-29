import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { SAP_KEY, SAP_MODELS, SAP_SECRET, SAP_TOKEN, SAP_URL } from "../../../packages/engine-native/test/sap-ai-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { presetOf } from "../src/view/provider-presets"
import { textWidth } from "../src/view/wrap"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-sap-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "sap-ai-core", type: "openai-compatible", baseUrl: SAP_URL, enabled: true, hasKey: true, source: "config", models: SAP_MODELS, sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" } }
const report = { ...REPORT, models: [...REPORT.models, ...SAP_MODELS.map((model) => ({ id: `sap-ai-core:${model.id}`, name: `${model.name} · SAP AI Core`, provider: "sap-ai-core", efforts: [] }))] }
async function fill(h: ReturnType<typeof providersHarness>) {
  await h.type(SAP_URL); await h.type("\r")
  await h.type(`\x1b[200~${SAP_KEY}\x1b[201~`); await h.type("\r")
  await h.type("deployment-fixture"); await h.type("\r")
  await h.type("test"); await h.type("\r")
}

describe("B10.18 SAP CLI factories", () => {
  test("appends SAP without moving choices/shortcuts and keeps preset copies consistent", () => {
    expect(CONNECT_CHOICES.slice(0, 24)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia"])
    expect(CONNECT_CHOICES[24]).toBe("sap-ai-core")
    const { id: _id, ...preset } = presetOf("sap-ai-core")!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS["sap-ai-core"]!
    expect(preset).toEqual(native)
    expect(models).toEqual([])
    expect(defaultEnabled).toBe(false)
    expect(createConnectState("SAP AI Core").target).toBe("sap-ai-core")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("masked JSON preserves spaces, is sent once, refreshes before testing and selects a SAP model", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "chat-fixture" } }
      if (command.type === "models.list") return { ok: true, result: report }
      if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
      return undefined
    } })
    await h.run("/connect SAP AI Core")
    expect(h.text()).toContain("SAP AI Core · Orchestration")
    await fill(h)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(SAP_SECRET)
    await h.type("\r")
    const submitted = h.commands("providers.set")[0]!
    expect(submitted).toMatchObject({ type: "providers.set", provider: "sap-ai-core", baseUrl: SAP_URL, sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" }, enabled: true })
    expect(JSON.parse(String(submitted.apiKey))).toEqual(JSON.parse(SAP_KEY))
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(SAP_SECRET))).toBe(false)
    expect(h.text()).toContain("SAP AI Core connected")
    await h.type("r"); expect(h.text()).toContain("2 models loaded")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("chat-fixture"); await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "sap-ai-core:chat-fixture" } })
    expect(h.everything()).not.toContain(SAP_SECRET)
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("env references retain explicit URLs and reject invalid deployment, key and capability URLs inline", () => {
    let state = connectKey(createConnectState("sap-ai-core"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "sap-ai-core", apiKeyEnv: "AICORE_SERVICE_KEY", sapAi: {}, enabled: true } })
    state = connectPaste(state, SAP_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "sap-ai-core", baseUrl: SAP_URL, apiKeyEnv: "AICORE_SERVICE_KEY", sapAi: {}, enabled: true } })
    for (const baseUrl of ["http://public.example/v2", "http://localhost.evil/v2", "http://u:p@localhost/v2", "http://localhost/v2?token=x", "http://localhost/v2#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...state, values: { ...state.values, deploymentId: "../escape" } })).toMatchObject({ ok: false, focus: 1 })
    expect(validateConnect({ ...state, viaEnv: false, values: { ...state.values, key: "not JSON" } })).toMatchObject({ ok: false, focus: 1 })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("AICORE_SERVICE_KEY")
  })

  test("save, refresh and test failures keep recovery available without exposing the service key", async () => {
    for (const phase of ["providers.set", "providers.refresh", "providers.test"]) {
      let fail = true
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === phase && fail) return { ok: false, error: { code: "internal", message: `rejected ${String(h.commands("providers.set")[0]?.apiKey ?? "")}` } }
        if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1, model: "chat-fixture" } }
        return undefined
      } })
      await h.run("/connect sap-ai-core"); await fill(h); await h.type("\r")
      expect(h.everything()).not.toContain(SAP_SECRET)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      if (phase === "providers.refresh") {
        expect(h.text()).toContain("saved, model refresh failed")
        fail = false
        await h.type("r"); await h.type("t")
        expect(h.text()).toContain("SAP AI Core connected")
      }
      expect(h.app.editor.text).toBe("")
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("management uses daemon on/off and confirmed removal", async () => {
    let current = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.remove") return { ok: true, result: { providers: [] } }
      return undefined
    } })
    await h.run("/providers"); await h.type("\r"); expect(h.text()).toContain("chat-fixture")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "sap-ai-core", enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: "sap-ai-core" }])
    await h.type("\x1b")
  })

  test("connection states fit small and wide grids with borders and header hints", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("sap-ai-core")
      const states = [form, { ...form, focus: 4 }, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("sap-ai-core") }, { ...form, step: "result" as const, result: { provider: "sap-ai-core", ok: false, note: "Model refresh failed", error: "local service unavailable" } }]
      for (const state of states) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.slice(0, 3).join(" ")).toContain("esc")
        expect(rows.join("\n")).toContain("┌")
        for (const secret of [SAP_SECRET, SAP_TOKEN]) expect(rows.join("\n")).not.toContain(secret)
      }
    }
  })
})
