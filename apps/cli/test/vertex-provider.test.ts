import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES, connectKey, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { textWidth } from "../src/view/wrap"
import { providersHarness, plain, REPORT } from "./providers-harness"
import { catalogHarness } from "./catalog-harness"
import { parseAutomation } from "../src/automation"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-vertex-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "google-vertex", type: "google-vertex", baseUrl: "https://aiplatform.googleapis.com/v1", enabled: true, hasKey: false, authReady: true, source: "config", models: [{ id: "gemini-2.5-flash" }], vertex: { project: "team-project", location: "global", tokenEnv: "TEAM_TOKEN", allowMetadata: false } }
const catalog = { providers: [{ id: "google-vertex", name: "Google Vertex AI", type: "google-vertex", configured: false, enabled: false, authReady: false, authMode: "google-adc", models: 2, requiredEnv: ["GOOGLE_APPLICATION_CREDENTIALS"], presentEnv: [], credentialStored: false }], callsProviders: false, secretsPrinted: false }

describe("B10.04 Vertex terminal and automation", () => {
  test("appended choice preserves numeric shortcuts; public ADC form validates and Tab only focuses", () => {
    expect(CONNECT_CHOICES.slice(0, 9)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom"])
    expect(CONNECT_CHOICES[14]).toBe("google-vertex")
    for (const name of ["vertex", "google-vertex", "Google Vertex AI"]) expect(createConnectState(name)).toMatchObject({ step: "form", target: "google-vertex" })
    const base = createConnectState("vertex")
    expect(validateConnect(base)).toMatchObject({ ok: true, submit: { enabled: true, apiKey: "", vertex: { project: null, location: null, endpoint: null, allowMetadata: false, tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN" } } })
    const state = { ...base, values: { ...base.values, vertexProject: "team-project", vertexLocation: "global", keyEnv: "TEAM_TOKEN", vertexQuotaProject: "billing-project", models: "gemini-2.5-flash, gemini-2.5-pro", vertexMetadata: "on" } }
    expect(validateConnect(state)).toMatchObject({ ok: true, submit: { provider: "google-vertex", vertex: { project: "team-project", location: "global", quotaProject: "billing-project", tokenEnv: "TEAM_TOKEN", allowMetadata: true }, models: [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-pro" }] } })
    expect(connectKey(state, "\t")).toMatchObject({ state: { focus: 1 }, action: { type: "none" } })
    expect(connectKey(state, "\x05").state.viaEnv).toBe(false)
    for (const changed of [{ vertexProject: "../escape" }, { vertexLocation: "global/escape" }, { keyEnv: "A=B" }, { models: "../escape" }, { baseUrl: "http://public.example" }, { baseUrl: "https://user:secret@example.com" }, { baseUrl: "https://example.com?token=secret" }]) expect(validateConnect({ ...state, values: { ...state.values, ...changed } }).ok).toBe(false)
    expect(validateConnect({ ...state, values: { ...state.values, baseUrl: "http://127.0.0.1:9911/v1" } }).ok).toBe(true)
  })

  test("app saves public ADC settings, tests, retains catalog, selects model, and reopens settings", async () => {
    let saved: ProviderInfo | undefined
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: saved ? [saved] : [] } }
      if (command.type === "providers.set") { saved = { ...provider, enabled: command.enabled === true, vertex: command.vertex ? command.vertex as ProviderInfo["vertex"] : saved?.vertex }; return { ok: true, result: { provider: saved } } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "gemini-2.5-flash" } }
      if (command.type === "providers.refresh") return { ok: true, result: { provider: saved } }
      if (command.type === "models.list") return { ok: true, result: { ...REPORT, models: [...REPORT.models, { id: "google-vertex:gemini-2.5-flash", name: "Gemini 2.5 Flash · Google Vertex AI", provider: "google-vertex", efforts: [] }] } }
      return undefined
    } })
    await h.run("/connect vertex")
    await h.type("team-project"); await h.type("\t"); await h.type("global")
    await h.type("\t"); await h.type("\t"); await h.type("TEAM_TOKEN")
    await h.type("\t"); await h.type("billing-project")
    await h.type("\t"); await h.type("\t"); await h.type("gemini-2.5-flash")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "google-vertex", enabled: true, apiKey: "", vertex: { project: "team-project", location: "global", endpoint: null, tokenEnv: "TEAM_TOKEN", quotaProject: "billing-project", allowMetadata: false }, models: [{ id: "gemini-2.5-flash" }] }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "google-vertex" }])
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    expect(h.text()).toContain("test ok")
    await h.type("r")
    expect(h.text()).toContain("publisher model retained")
    expect(h.text()).not.toContain("loaded from the provider")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("\x1b[D")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "google-vertex:gemini-2.5-flash" } })
    await h.type("\x1b"); await h.run("/connect google-vertex")
    expect(h.text()).toContain("team-project")
    expect(h.text()).toContain("TEAM_TOKEN")
    expect(h.text()).toContain("billing-project")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("ADC failure preserves edit/retry; provider detail reports auth and explicit disable", async () => {
    let current = { ...provider }, failed = true
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: "gemini-2.5-flash", ...(failed ? { error: "[AUTH]: Vertex ADC credential file is unreadable or oversized" } : {}) } }
      return undefined
    } })
    await h.run("/connect google-vertex")
    for (let i = 0; i < 6; i++) await h.type("\t")
    await h.type("\r"); expect(h.text()).toContain("saved, test failed")
    expect(h.text()).toContain("credential file is unreadable")
    await h.type("e"); expect(h.text()).toContain("team-project")
    for (let i = 0; i < 6; i++) await h.type("\t")
    failed = false
    await h.type("\r"); expect(h.text()).toContain("test ok")
    await h.type("t"); expect(h.commands("providers.test")).toHaveLength(3)
    await h.type("\x1b"); await h.run("/providers"); await h.type("\r")
    expect(h.text()).toContain("ADC")
    expect(h.text()).toContain("team-project")
    await h.type("e")
    expect(h.commands("providers.set").at(-1)).toEqual({ type: "providers.set", provider: "google-vertex", enabled: false })
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("ADC panels and focused fields fit compact through wide terminals with header hints", () => {
    const base = createConnectState("vertex")
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const focus of [0, 5, 6]) {
      const rows = renderConnectPage({ state: { ...base, focus }, width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("┌")
      expect(rows.join("\n")).toContain("└")
      if (width! >= 110) expect(rows.join("\n")).toContain("Google ADC")
      expect(rows.slice(-2).join("")).not.toContain("esc")
    }
  })

  test("CLI public routing/ADC flags skip secret prompts, reject wrong scopes and keep smoke opt-in", async () => {
    const ready = { ...catalog, providers: catalog.providers.map((entry) => ({ ...entry, configured: true, enabled: true, authReady: true })) }
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? ready : command.type === "providers.list" ? { providers: [provider] } : command.type === "providers.test" ? { ok: true, model: "gemini-2.5-flash", latencyMs: 12 } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "google-vertex", "--gcp-project", "team-project", "--vertex-location", "global", "--google-token-env", "TEAM_TOKEN", "--vertex-quota-project", "billing-project", "--models", "gemini-2.5-flash", "--google-metadata", "--json"])).toBe(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.set", provider: "google-vertex", apiKey: "", enabled: true, vertex: { project: "team-project", location: "global", tokenEnv: "TEAM_TOKEN", quotaProject: "billing-project", allowMetadata: true }, models: [{ id: "gemini-2.5-flash" }] })
    for (const extra of [["--gcp-project", "../escape"], ["--vertex-location", "global/escape"], ["--google-token-env", "A=B"], ["--models", "../escape"], ["--api-key-env", "TEAM_KEY"], ["--aws-profile", "default"]]) expect(parseAutomation(["providers", "login", "--provider", "google-vertex", ...extra]).ok).toBe(false)
    expect(parseAutomation(["providers", "login", "--provider", "openai", "--gcp-project", "team-project"]).ok).toBe(false)
    expect(await h.run(["providers", "login", "--provider", "google-vertex", "--method", "api-key", "--json"])).toBe(64)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", "google-vertex", "--json"])).toBe(0)
    expect(h.sent.filter((command) => command.type === "providers.test")).toHaveLength(0)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", "google-vertex", "--execute", "--json"])).toBe(0)
    expect(h.sent.filter((command) => command.type === "providers.test")).toHaveLength(1)
  })

  test("CLI startup and lazy Vertex UI do not load protocol schemas or daemon", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(vertex|providers|commands|queries|events)\\.ts$/.test(key))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
