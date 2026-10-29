import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES, connectKey, connectPaste, connectWithMethods, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { providersHarness, plain, REPORT } from "./providers-harness"
import { catalogHarness } from "./catalog-harness"
import { parseAutomation } from "../src/automation"
import { textWidth } from "../src/view/wrap"
import { createProvidersPageState, renderProvidersPage } from "../src/view/providers-page"

const KEY = "bedrock-ui-fixture-never-print"
const methods: ProviderAuthMethod[] = [{ id: "aws-chain", type: "api", label: "AWS credential chain", available: true }, { id: "api-key", type: "api", label: "Bedrock bearer token", available: true }]
const info: ProviderInfo = { id: "amazon-bedrock", type: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", enabled: false, hasKey: false, authReady: true, source: "config", models: [{ id: "amazon.nova-lite-v1:0" }], bedrock: { region: "us-east-1", profile: "team", auth: "chain" } }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-bedrock-ui-")); dirs.push(dir); return dir }

describe("B10.01 Bedrock CLI and terminal", () => {
  test("appended choice preserves shortcuts; AWS chain and bearer methods stay local", () => {
    expect(CONNECT_CHOICES.slice(0, 13)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure"])
    expect(CONNECT_CHOICES[13]).toBe("amazon-bedrock")
    expect(createConnectState("Amazon Bedrock").target).toBe("amazon-bedrock")
    expect(createConnectState("bedrock").target).toBe("amazon-bedrock")
    let state = connectWithMethods(createConnectState("bedrock"), { "amazon-bedrock": methods })
    state = connectKey(state, "\x1b[B").state
    const chosen = connectKey(state, "\r")
    expect(chosen.action.type).toBe("none")
    expect(chosen.state.step).toBe("form")
    expect(chosen.state.values.awsAuth).toBe("bearer")
  })

  test("form validates routing/auth, defaults process and metadata off, Tab never submits", () => {
    const state = createConnectState("bedrock")
    expect(validateConnect(state)).toMatchObject({ ok: true, submit: { provider: "amazon-bedrock", enabled: true, apiKey: "", bedrock: { auth: "chain", region: null, profile: null, endpoint: null, allowMetadata: false, allowCredentialProcess: false } } })
    expect(connectKey(state, "\t").action.type).toBe("none")
    expect(connectKey(state, "\x05").state.viaEnv).toBe(false)
    for (const [field, value] of [["awsRegion", "bad.example"], ["awsProfile", "../secret"], ["baseUrl", "http://remote.example"], ["baseUrl", "https://user:secret@remote.example"], ["baseUrl", "https://remote.example?token=secret"]]) expect(validateConnect({ ...state, values: { ...state.values, [field!]: value! } }).ok).toBe(false)
    const bearer = { ...state, values: { ...state.values, awsAuth: "bearer" } }
    expect(validateConnect(bearer).ok).toBe(false)
    const pasted = connectPaste({ ...bearer, focus: 6 }, KEY)
    const rows = renderConnectPage({ state: pasted, width: 100, height: 30 }).map(plain).join("\n")
    expect(rows).toContain("chars"); expect(rows).not.toContain(KEY)
    expect(validateConnect(connectKey(pasted, "\x05").state)).toMatchObject({ ok: true, submit: { apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK", apiKey: "" } })
  })

  test("app factory saves AWS chain, tests, refreshes, selects model and reopens public config", async () => {
    let saved: ProviderInfo = { ...info }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [saved] } }
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { "amazon-bedrock": methods } } }
      if (command.type === "providers.set") { saved = { ...saved, enabled: command.enabled === true, bedrock: command.bedrock as ProviderInfo["bedrock"] }; return { ok: true, result: { provider: saved } } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "amazon.nova-lite-v1:0" } }
      if (command.type === "providers.refresh") return { ok: true, result: { provider: saved } }
      if (command.type === "models.list") return { ok: true, result: { ...REPORT, models: [...REPORT.models, { id: "amazon-bedrock:amazon.nova-lite-v1:0", name: "Nova Lite · Amazon Bedrock", provider: "amazon-bedrock", efforts: [] }] } }
      return undefined
    } })
    await h.run("/connect bedrock"); await h.type("\r")
    expect(h.text()).toContain("team")
    for (let i = 0; i < 6; i++) await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")).toHaveLength(1)
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "amazon-bedrock", enabled: true, bedrock: { region: "us-east-1", profile: "team", auth: "chain" } })
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "amazon-bedrock" }])
    expect(h.text()).toContain("Amazon Bedrock connected")
    await h.type("r"); expect(h.commands("providers.refresh")).toHaveLength(1)
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("\x1b[D")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "amazon-bedrock:amazon.nova-lite-v1:0" } })
    await h.type("\x1b"); await h.run("/connect bedrock"); await h.type("\r")
    expect(h.text()).toContain("team")
    expect(h.text()).toContain("amazon.nova-lite-v1:0")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("bearer sent once; failed test preserves public fields and edit/retry", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.list" ? { ok: true, result: { providers: [info] } }
      : command.type === "providers.auth.methods" ? { ok: true, result: { methods: { "amazon-bedrock": methods } } }
      : command.type === "providers.set" ? { ok: true, result: { provider: { ...info, enabled: true, hasKey: true } } }
      : command.type === "providers.test" ? { ok: true, result: { ok: false, error: `[AUTH]: Bedrock 403 ${KEY}` } } : undefined })
    await h.run("/connect bedrock"); await h.type("\x1b[B"); await h.type("\r")
    for (let i = 0; i < 6; i++) await h.type("\t")
    await h.type(KEY); expect(h.everything()).not.toContain(KEY)
    await h.type("\t"); await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ apiKey: KEY, bedrock: { auth: "bearer" } })
    expect(h.commands("providers.set")).toHaveLength(1)
    expect(h.text()).toContain("saved, test failed")
    expect(h.everything()).not.toContain(KEY)
    await h.type("e"); expect(h.text()).toContain("team")
    expect(h.text()).not.toContain("chars")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("header hints, padding, visible borders and focus survive compact through wide sizes", () => {
    const base = createConnectState("bedrock")
    const states = [base, connectWithMethods(base, { "amazon-bedrock": methods }), { ...base, focus: 6, values: { ...base.values, awsAuth: "bearer", key: KEY, awsProfile: "team" } }, { ...base, error: "AWS credentials are missing" }]
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const state of states) {
      const rows = renderConnectPage({ state, width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("┌")
      expect(rows.join("\n")).toContain("└")
      expect(rows.join("\n")).not.toContain(KEY)
      expect(rows.slice(-2).join("")).not.toContain("esc")
    }
    for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60]]) {
      const rows = renderProvidersPage({ state: { ...createProvidersPageState(), detail: true }, providers: [info], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("┌")
      expect(rows.join("\n")).toContain("AWS credential chain")
      expect(rows.join("\n")).toContain("us-east-1")
      expect(rows.join("\n")).toContain("amazon.nova-lite-v1:0")
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
    }
  })

  test("CLI chain login requires no key prompt; bearer login, model list and smoke use daemon commands", async () => {
    const catalog = { providers: [{ id: "amazon-bedrock", name: "Amazon Bedrock", type: "amazon-bedrock", configured: true, enabled: true, authReady: true, authMode: "aws-chain", models: 1, requiredEnv: [], presentEnv: [], credentialStored: false }] }
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? catalog : command.type === "providers.auth.methods" ? { methods: { "amazon-bedrock": methods } } : command.type === "providers.list" ? { providers: [{ ...info, enabled: true }] } : command.type === "providers.test" ? { ok: true } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "amazon-bedrock", "--method", "aws-chain", "--aws-region", "eu-west-1", "--aws-profile", "team", "--models", "amazon.nova-lite-v1:0", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.set", provider: "amazon-bedrock", enabled: true, apiKey: "", bedrock: { region: "eu-west-1", profile: "team", auth: "chain" }, models: [{ id: "amazon.nova-lite-v1:0" }] })
    expect(h.prompts).toEqual([])
    expect(await h.run(["providers", "login", "--provider", "amazon-bedrock", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ apiKey: "", bedrock: { auth: "chain" } })
    expect(await h.run(["providers", "login", "--provider", "amazon-bedrock", "--api-key-env", "TEAM_BEDROCK_TOKEN", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ apiKeyEnv: "TEAM_BEDROCK_TOKEN", bedrock: { auth: "bearer" } })
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", "amazon-bedrock", "--execute", "--json"])).toBe(0)
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(true)
    expect(parseAutomation(["providers", "login", "--provider", "openai", "--aws-profile", "team"]).ok).toBe(false)
    expect(parseAutomation(["providers", "login", "--provider", "amazon-bedrock", "--aws-region", "bad.example"]).ok).toBe(false)
  })

  test("startup and lazy provider UI modules do not load zod, protocol schemas or daemon", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(bedrock|providers|commands|queries|events)\\.ts$/.test(key))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
