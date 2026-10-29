import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderAuthMethod, ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES, connectKey, connectPaste, connectWithMethods, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { textWidth } from "../src/view/wrap"
import { providersHarness, plain, REPORT } from "./providers-harness"
import { catalogHarness } from "./catalog-harness"
import { parseAutomation } from "../src/automation"

const KEY = "azure-ui-fixture-never-print-0123456789"
const methods: ProviderAuthMethod[] = [{ id: "api-key", type: "api", label: "API key", available: true }, { id: "entra", type: "api", label: "Microsoft Entra ID (environment)", available: true }]
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-azure-ui-")); dirs.push(dir); return dir }
const info: ProviderInfo = { id: "azure", type: "azure", baseUrl: "https://team.openai.azure.com/openai", enabled: true, hasKey: true, source: "config", models: [{ id: "team-coder" }], azure: { auth: "api-key" } }

describe("B10.02 Azure terminal", () => {
  test("choice is appended; original shortcuts survive and API key/Entra are reachable", () => {
    expect(CONNECT_CHOICES.slice(0, 12)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot"])
    expect(CONNECT_CHOICES[12]).toBe("azure")
    expect(createConnectState("Azure OpenAI").target).toBe("azure")
    let state = connectWithMethods(createConnectState("azure"), { azure: methods })
    expect(state.step).toBe("methods")
    state = connectKey(state, "\x1b[B").state
    state = connectKey(state, "\r").state
    expect(state.values.azureAuth).toBe("entra")
    expect(state.step).toBe("form")
    expect(connectKey(state, "\x05").state.viaEnv).toBe(false)
  })

  test("form validates resource/URL, deployments, API version and masked secret without executing on Tab", () => {
    const base = createConnectState("azure")
    const filled = { ...base, values: { ...base.values, baseUrl: "team", models: "team-coder", key: KEY } }
    expect(validateConnect(filled)).toMatchObject({ ok: true, submit: { provider: "azure", baseUrl: "https://team.openai.azure.com/openai", enabled: true, models: [{ id: "team-coder" }], azure: { apiVersion: "v1", useCompletionUrls: false, useDeploymentBasedUrls: false, resourceName: "team", auth: "api-key" } } })
    expect(connectKey(filled, "\t").action.type).toBe("none")
    for (const baseUrl of ["", "http://remote.example", "https://user:secret@remote.example", "https://remote.example?api-key=secret"]) expect(validateConnect({ ...filled, values: { ...filled.values, baseUrl } }).ok).toBe(false)
    expect(validateConnect({ ...filled, values: { ...filled.values, models: "" } })).toMatchObject({ ok: false, error: expect.stringContaining("deployment") })
    expect(validateConnect({ ...filled, values: { ...filled.values, apiVersion: "latest-made-up" } }).ok).toBe(false)
    const pasted = connectPaste({ ...base, focus: 5 }, KEY)
    const rows = renderConnectPage({ state: pasted, width: 100, height: 30 }).map(plain).join("\n")
    expect(rows).toContain("chars")
    expect(rows).not.toContain(KEY)
  })

  test("app: key sent once, real commands test/refresh/model selection, reopening retains public config", async () => {
    let saved: ProviderInfo | undefined
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: saved ? [saved] : [] } }
      if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { azure: methods } } }
      if (command.type === "providers.set") { saved = { ...info, azure: command.azure as ProviderInfo["azure"] }; return { ok: true, result: { provider: saved } } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "team-coder" } }
      if (command.type === "providers.refresh") return { ok: true, result: { provider: saved } }
      if (command.type === "models.list") return { ok: true, result: { ...REPORT, models: [...REPORT.models, { id: "azure:team-coder", name: "Team coder · Azure OpenAI", efforts: [], provider: "azure" }] } }
      return undefined
    } })
    await h.run("/connect azure"); await h.type("\r")
    await h.type("team")
    for (let i = 0; i < 5; i++) await h.type("\t")
    await h.type(KEY)
    expect(h.everything()).not.toContain(KEY)
    await h.type("\t"); await h.type("team-coder"); await h.type("\r")
    expect(h.commands("providers.set")).toHaveLength(1)
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "azure", apiKey: KEY, models: [{ id: "team-coder" }], enabled: true })
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "azure" }])
    expect(h.text()).toContain("Azure OpenAI connected")
    await h.type("r")
    expect(h.text()).toContain("deployment configured")
    await h.type("m")
    expect(h.app.page).toBe("model")
    // The last provider can be below the visible catalog: cycling still selects its deployment.
    await h.type("\x1b[D")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "azure:team-coder" } })
    await h.type("\x1b"); await h.run("/connect azure"); await h.type("\r")
    expect(h.text()).toContain("team.openai.azure.com")
    expect(h.text()).toContain("team-coder")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("Entra config contains variable names only; failed authentication preserves edit and retry", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.list" ? { ok: true, result: { providers: [info] } }
      : command.type === "providers.auth.methods" ? { ok: true, result: { methods: { azure: methods } } }
      : command.type === "providers.set" ? { ok: true, result: { provider: { ...info, azure: { auth: "entra" }, hasKey: false } } }
      : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: "[AUTH]: Azure Entra credentials are missing" } } : undefined })
    await h.run("/connect azure"); await h.type("\x1b[B"); await h.type("\r")
    for (let i = 0; i < 6; i++) await h.type("\t")
    await h.type("\r")
    expect(h.commands("providers.set")).toHaveLength(1)
    expect(h.commands("providers.set")[0]).toMatchObject({ azure: { auth: "entra", tokenEnv: "AZURE_OPENAI_AUTH_TOKEN" }, apiKey: "" })
    expect(h.commands("providers.auth.authorize")).toHaveLength(0)
    expect(h.text()).toContain("credentials are missing")
    await h.type("e")
    expect(h.text()).toContain("entra")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("forms, validation and method panels fit compact through wide sizes", () => {
    const base = createConnectState("azure")
    const states = [base, connectWithMethods(base, { azure: methods }), { ...base, focus: 6, values: { ...base.values, azureAuth: "entra", baseUrl: "https://team.openai.azure.com/openai", models: "team-coder", keyEnv: "TEAM_TOKEN" } }, { ...base, error: "Azure Entra credentials are missing" }]
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const state of states) {
      const rows = renderConnectPage({ state, width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows[0]).toContain("esc")
      expect(rows.join("\n")).toContain("┌")
      expect(rows.join("\n")).toContain("└")
      expect(rows.slice(-2).join("")).not.toContain("esc")
    }
  })

  test("CLI: explicit Azure and Entra flags, configure without token prompts, no secrets in JSON", async () => {
    const report = { providers: [{ id: "azure", name: "Azure OpenAI", type: "azure", configured: false, enabled: false, authMode: "api-key", authReady: false, models: 0, requiredEnv: ["AZURE_API_KEY"], presentEnv: [], credentialStored: false }] }
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? report : command.type === "providers.auth.methods" ? { methods: { azure: methods } } : {} }) })
    const args = ["providers", "login", "--provider", "azure", "--azure-resource", "team", "--deployments", "team-coder", "--entra-token-env", "TEAM_TOKEN", "--api-version", "2024-10-21", "--use-completion-urls", "--use-deployment-based-urls", "--json"]
    expect(await h.run(args)).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.set", provider: "azure", apiKey: "", enabled: true, models: [{ id: "team-coder" }], azure: { resourceName: "team", auth: "entra", tokenEnv: "TEAM_TOKEN", apiVersion: "2024-10-21", useCompletionUrls: true, useDeploymentBasedUrls: true } })
    expect(parseAutomation(["providers", "login", "--provider", "openai", "--deployments", "not-azure"]).ok).toBe(false)
    expect(parseAutomation(["providers", "login", "--provider", "azure", "--azure-resource", "team.evil.example"]).ok).toBe(false)
  })

  test("startup and lazy provider modules stay free of runtime schemas, daemon and zod", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(azure|providers|commands|queries|events)\\.ts$/.test(key))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
