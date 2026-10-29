import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelsReport, ProviderInfo } from "@mendcode/protocol"
import { parseAutomation } from "../src/automation"
import { connectKey, createConnectState, renderConnectPage, validateConnect, CONNECT_CHOICES } from "../src/view/connect-page"
import { CONNECT_PRESETS, PROVIDER_TYPE_CHOICES } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { providersHarness, plain, REPORT } from "./providers-harness"

const KEY = "mistral-ui-private-fixture-never-print"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-mistral-ui-"))
  dirs.push(dir)
  return dir
}
const provider: ProviderInfo = { id: "mistral", type: "mistral", baseUrl: "https://api.mistral.ai/v1", enabled: true, hasKey: true, source: "config", models: [{ id: "mistral-small-latest" }] }
const report: ModelsReport = { ...REPORT, models: [{ id: "mistral:mistral-small-latest", name: "Mistral Small · Mistral", provider: "mistral", efforts: ["high"], variants: { high: { effort: "high", parameters: { reasoningEffort: "high" } } } }], defaults: { model: "mistral:mistral-small-latest" }, effective: { model: "mistral:mistral-small-latest" } }

describe("B10.07 Mistral terminal", () => {
  test("Mistral appends to choices and schema-free types without moving earlier shortcuts", () => {
    expect(CONNECT_CHOICES.slice(0, 17)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai"])
    expect(CONNECT_CHOICES[17]).toBe("mistral")
    expect(CONNECT_PRESETS.find((preset) => preset.id === "mistral")).toMatchObject({ type: "mistral", keyEnv: "MISTRAL_API_KEY", baseUrl: "https://api.mistral.ai/v1" })
    expect(PROVIDER_TYPE_CHOICES[6]).toBe("mistral")
    expect(createConnectState("Mistral").target).toBe("mistral")
    let state = createConnectState()
    for (let index = 0; index < CONNECT_CHOICES.indexOf("mistral"); index++) state = connectKey(state, "\x1b[B").state
    expect(connectKey(state, "\r").state.target).toBe("mistral")
  })

  test("app factory masks a key, saves/tests only on submit, refreshes and opens Mistral models", async () => {
    const h = providersHarness({ dataDir: temp(), width: 100, height: 30, reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12 } }
      if (command.type === "models.list" || command.type === "session.model.set") return { ok: true, result: report }
      return undefined
    } })
    await h.run("/connect Mistral")
    await h.type(KEY)
    expect(h.text()).toContain("chars")
    expect(h.commands("providers.set")).toHaveLength(0)
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "mistral", apiKey: KEY, enabled: true })
    expect(h.commands("providers.test")).toHaveLength(1)
    expect(h.text()).toContain("Mistral connected")
    await h.type("r")
    expect(h.commands("providers.refresh")).toHaveLength(1)
    await h.type("m")
    expect(h.app.page).toBe("model")
    expect(h.text()).toContain("mistral:mistral-small-latest")
    expect(h.text()).toContain("high")
    await h.type("/")
    await h.type("\r")
    expect(h.app.page).toBe("variants")
    expect(h.text()).toContain("high")
    await h.type("\x1b[B")
    await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "mistral:mistral-small-latest", variant: "high" } })
    expect(h.everything()).not.toContain(KEY)
    await h.type("\x1b")
  })

  test("environment auth sends only the reference; failures scrub typed secrets and retain edit/retry", async () => {
    const env = connectKey(createConnectState("mistral"), "\x05").state
    expect(validateConnect(env)).toEqual({ ok: true, submit: { provider: "mistral", apiKeyEnv: "MISTRAL_API_KEY", enabled: true } })
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.set" ? { ok: true, result: { provider } } : command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `rejected ${KEY}` } } : undefined })
    await h.run("/connect mistral")
    await h.type(KEY)
    await h.type("\r")
    expect(h.text()).toContain("Mistral saved, test failed")
    expect(h.everything()).not.toContain(KEY)
    await h.type("e")
    expect(h.text()).toContain("required")
    await h.type("\x1b")
    await h.type("\x1b")
  })

  test("connect/provider screens keep the bordered grid and header hints at every breakpoint", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      const form = createConnectState("mistral")
      const frames = [
        renderConnectPage({ state: form, width, height }),
        renderConnectPage({ state: { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("mistral") }, width, height }),
        renderConnectPage({ state: connectKey(form, "\x05").state, width, height }),
        renderProvidersPage({ state: { selected: 0, detail: false }, providers: [provider], width, height }),
        renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width, height }),
      ]
      for (const frame of frames) {
        const rows = frame.map(plain)
        const text = rows.join("\n")
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
        expect(rows[0]).toContain("esc")
        expect(text).toContain("Mistral")
        expect(text).toContain("┌")
        expect(text).toContain("└")
      }
    }
  })

  test("provider management disables Mistral through the daemon without a new UI-specific store", async () => {
    const stored = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [stored] } }
      if (command.type === "providers.set") {
        stored.enabled = command.enabled === true
        return { ok: true, result: { provider: stored } }
      }
      return undefined
    } })
    await h.run("/providers")
    await h.type("\r")
    await h.type("e")
    expect(h.commands("providers.set")[0]).toMatchObject({ provider: "mistral", enabled: false })
    expect(h.text()).toContain("off")
    await h.type("\x1b")
    await h.type("\x1b")
  })

  test("CLI login resolves Mistral labels/custom types and never calls the paid smoke test implicitly", async () => {
    expect(parseAutomation(["providers", "login", "--provider", "team", "--provider-type", "mistral", "--base-url", "http://127.0.0.1:1234/v1", "--api-key-env", "TEAM_MISTRAL_KEY"])).toMatchObject({ ok: true, command: { providerType: "mistral" } })
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "mistral", name: "Mistral", type: "mistral", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Mistral", "--api-key-env", "MISTRAL_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "mistral", apiKeyEnv: "MISTRAL_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
    const custom = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [] } : {} }) })
    expect(await custom.run(["providers", "login", "--provider", "team", "--provider-type", "mistral", "--base-url", "http://127.0.0.1:1234/v1", "--api-key-env", "TEAM_MISTRAL_KEY"])).toBe(0)
    expect(custom.sent.at(-1)).toEqual({ type: "providers.set", provider: "team", providerType: "mistral", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "TEAM_MISTRAL_KEY", enabled: true })
  })

  test("Mistral additions do not load protocol schemas or provider pages at startup", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/catalog-args"); const before = Object.keys(require.cache); await (await import("./src/ui/lazy-pages")).preload("connect"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ lazy: before.every((key) => !/view\\/(connect-page|providers-page)\\.ts$/.test(key)), bad: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key)) }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ lazy: true, bad: [] })
  })
})
