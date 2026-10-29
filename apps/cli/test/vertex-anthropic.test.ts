import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_PRESETS } from "../src/view/provider-presets"
import { CONNECT_CHOICES, createConnectState, connectFields, renderConnectPage } from "../src/view/connect-page"
import { createModelPageState, renderModelPage } from "../src/view/model-page"
import { parseAutomation } from "../src/automation"
import { textWidth } from "../src/view/wrap"
import { providersHarness, plain, REPORT } from "./providers-harness"
import { catalogHarness } from "./catalog-harness"

const ID = "google-vertex-anthropic", MODEL = "claude-haiku-4-5@20251001"
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-vertex-claude-ui-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const provider: ProviderInfo = { id: ID, type: ID, baseUrl: "https://aiplatform.googleapis.com/v1", enabled: false, hasKey: false, authReady: true, source: "config", vertex: { project: "team-project", location: "global", tokenEnv: "TEAM_TOKEN", quotaProject: "billing-project", allowMetadata: false }, models: [{ id: MODEL, images: true, effort: true }] }
const report = { ...REPORT, models: [{ id: `${ID}:${MODEL}`, name: "Claude Haiku 4.5 · Vertex Anthropic", provider: ID, efforts: ["low", "medium", "high"] }], defaults: { model: `${ID}:${MODEL}` }, effective: { model: `${ID}:${MODEL}` } }
const catalog = { providers: [{ id: ID, name: "Vertex Anthropic", type: ID, configured: true, enabled: true, authReady: true, authMode: "google-adc", models: 1, requiredEnv: [], presentEnv: [], credentialStored: false }], callsProviders: false, secretsPrinted: false }

function harness(width = 100, height = 30) {
  let current = { ...provider }, failed = false
  const h = providersHarness({ dataDir: temp(), width, height, reply: (command) => {
    if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
    if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { [ID]: [{ id: "adc", type: "api", label: "Google Application Default Credentials", available: true }] } } }
    if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
    if (command.type === "providers.test") return { ok: true, result: { ok: !failed, latencyMs: 12, model: MODEL, ...(failed ? { error: "[AUTH]: rejected ADC credentials (check Google IAM and model access)" } : {}) } }
    if (command.type === "providers.refresh") return { ok: true, result: { provider: current } }
    if (command.type === "models.list") return { ok: true, result: report }
    return undefined
  } })
  return { ...h, fail: () => { failed = true }, succeed: () => { failed = false } }
}

describe("B10.05 Vertex Anthropic CLI factories", () => {
  test("choice is appended, names resolve, ADC form has no secret field or API-key toggle", () => {
    expect(CONNECT_CHOICES.slice(0, 9)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom"])
    expect(CONNECT_CHOICES[15]).toBe(ID)
    expect(CONNECT_PRESETS.find((preset) => preset.id === ID)).toMatchObject({ id: ID, type: ID })
    for (const name of [ID, "Vertex Anthropic"]) {
      const state = createConnectState(name)
      expect(state).toMatchObject({ step: "form", target: ID, viaEnv: false })
      expect(connectFields(ID, false).some((field) => field.secret)).toBe(false)
      expect(connectFields(ID, false)[1]!.placeholder).toContain("global")
    }
  })

  test("app connects with public ADC settings, Tab only focuses, refresh retains publisher ids and model selection works", async () => {
    const h = harness()
    await h.run(`/connect ${ID}`)
    expect(h.text()).toContain("team-project")
    expect(h.text()).not.toContain("ctrl+e")
    await h.type("\x05")
    for (let i = 0; i < 6; i++) await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: ID, enabled: true, apiKey: "", vertex: { project: "team-project", location: "global", endpoint: null, tokenEnv: "TEAM_TOKEN", quotaProject: "billing-project", allowMetadata: false }, models: [{ id: MODEL }] }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: ID }])
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    expect(h.text()).toContain("test ok")
    await h.type("r")
    expect(h.text()).toContain("publisher model retained")
    expect(h.text()).not.toContain("loaded from the provider")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("\x1b[D")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: `${ID}:${MODEL}` } })
    await h.type("\x1b"); await h.run("/connect Vertex Anthropic")
    expect(h.text()).toContain("TEAM_TOKEN")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("ADC failure retains editable fields, retry works, invalid model paths refuse, provider details toggle off", async () => {
    const h = harness()
    await h.run(`/connect ${ID}`)
    for (let i = 0; i < 6; i++) await h.type("\t")
    h.fail(); await h.type("\r")
    expect(h.text()).toContain("saved, test failed")
    await h.type("e"); expect(h.text()).toContain("team-project")
    for (let i = 0; i < 6; i++) await h.type("\t")
    await h.type("\x15"); await h.type("../escape"); await h.type("\r")
    expect(h.text()).toContain("invalid Anthropic model id")
    expect(h.commands("providers.set")).toHaveLength(1)
    await h.type("\x15"); await h.type(MODEL)
    h.succeed(); await h.type("\r")
    expect(h.text()).toContain("test ok")
    await h.type("\x1b"); await h.run("/providers"); await h.type("\r")
    expect(h.text()).toContain("Google ADC")
    expect(h.text()).toContain("global")
    await h.type("e")
    expect(h.commands("providers.set").at(-1)).toEqual({ type: "providers.set", provider: ID, enabled: false })
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("shared panel grid, header hints and focused ADC fields fit compact through wide widths", () => {
    const base = createConnectState(ID)
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

  test("long Vertex namespace uses catalog labels and explicit compact truncation in role rows", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const rows = renderModelPage({ state: createModelPageState(), report, width: width!, height: height! }).map(plain)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      const current = rows.find((row) => row.includes("this session"))!
      expect(current).not.toContain(ID)
      if (width! >= 100) { expect(current).toContain("Haiku 4.5"); expect(current).toContain("default effort ›") }
      else expect(current).toContain("…")
    }
  })

  test("CLI ADC flags/name/custom type use daemon commands, never prompt for secrets, and smoke is opt-in", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? catalog : command.type === "providers.list" ? { providers: [provider] } : command.type === "providers.test" ? { ok: true, model: MODEL, latencyMs: 12 } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Vertex Anthropic", "--gcp-project", "team-project", "--models", MODEL, "--google-token-env", "TEAM_TOKEN", "--json"])).toBe(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.set", provider: ID, enabled: true, apiKey: "", vertex: { project: "team-project", tokenEnv: "TEAM_TOKEN" }, models: [{ id: MODEL }] })
    expect(await h.run(["providers", "login", "--provider", "team-claude", "--provider-type", ID, "--base-url", "http://127.0.0.1:9911/v1", "--gcp-project", "team-project", "--models", MODEL, "--json"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.set", provider: "team-claude", providerType: ID, enabled: true, apiKey: "" })
    for (const extra of [["--models", "../escape"], ["--api-key-env", "TEAM_KEY"], ["--vertex-location", "global/escape"], ["--aws-profile", "default"]]) expect(parseAutomation(["providers", "login", "--provider", ID, ...extra]).ok).toBe(false)
    expect(await h.run(["providers", "login", "--provider", ID, "--method", "api-key", "--json"])).toBe(64)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", ID, "--json"])).toBe(0)
    expect(h.sent.filter((command) => command.type === "providers.test")).toHaveLength(0)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", ID, "--execute", "--json"])).toBe(0)
    expect(h.sent.filter((command) => command.type === "providers.test")).toHaveLength(1)
  })

  test("startup and lazy provider pages remain free of schemas/zod/daemon", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(vertex|providers|commands|queries|events)\\.ts$/.test(key))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
