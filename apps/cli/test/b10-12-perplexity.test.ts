import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { providersHarness, plain, REPORT } from "./providers-harness"
import { catalogHarness } from "./catalog-harness"
import { appHarness, conversation } from "./session-ui-harness"

const KEY = "perplexity-private-ui-fixture-0123456789"
const URL = "http://127.0.0.1:1234"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-12-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "perplexity", type: "openai-compatible", baseUrl: URL, enabled: true, hasKey: true, source: "config", models: [{ id: "sonar", images: false, tool_call: false }] }
const report = { ...REPORT, models: [...REPORT.models, { id: "perplexity:sonar", name: "sonar · Perplexity", provider: "perplexity", efforts: [] }] }
const reply = (command: Record<string, unknown>) => {
  if (command.type === "providers.auth.methods") return { ok: true, result: { methods: { perplexity: [{ id: "api-key", type: "api", label: "API key", available: true }] } } }
  if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
  if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "sonar" } }
  if (command.type === "models.list") return { ok: true, result: report }
  return undefined
}

describe("B10.12 Perplexity terminal", () => {
  test("preset is appended without moving shortcuts and name opens local proxy form", () => {
    expect(CONNECT_CHOICES.slice(0, 12)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom", "chatgpt", "google", "github-copilot"])
    expect(CONNECT_CHOICES[19]).toBe("perplexity")
    expect(CONNECT_PRESETS.find((preset) => preset.id === "perplexity")).toMatchObject({ name: "Perplexity", keyEnv: "PERPLEXITY_API_KEY", type: "openai-compatible" })
    expect(createConnectState("Perplexity")).toMatchObject({ target: "perplexity", step: "form" })
  })

  test("local URL and masked key save once, test, refresh and expose the namespaced model", async () => {
    const h = providersHarness({ dataDir: temp(), reply })
    await h.run("/connect Perplexity")
    expect(h.text()).toContain("https://api.perplexity.ai")
    await h.type(URL); await h.type("\r"); await h.type(KEY)
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(KEY)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "perplexity", baseUrl: URL, apiKey: KEY, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "perplexity" }])
    expect(h.text()).toContain("Perplexity connected")
    await h.type("r")
    expect(h.text()).toContain("1 model loaded")
    await h.type("m")
    expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("sonar")
    expect(h.text()).toContain("sonar · Perplexity")
    await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "perplexity:sonar" } })
    expect(h.everything()).not.toContain(KEY)
    await h.type("\x1b")
  }, 15_000)

  test("environment opt-in refuses plain-HTTP public endpoints, which never submit", async () => {
    let state = createConnectState("perplexity")
    state = connectPaste(state, "http://api.perplexity.ai")
    state = connectKey(state, "\x05").state
    expect(validateConnect(state)).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    state = connectKey(state, "\x15").state
    state = connectPaste(state, URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "perplexity", baseUrl: URL, apiKeyEnv: "PERPLEXITY_API_KEY", enabled: true } })
    const h = providersHarness({ dataDir: temp(), reply })
    await h.run("/connect perplexity"); await h.type("http://api.perplexity.ai"); await h.type("\x05"); await h.type("\r")
    expect(h.commands("providers.set")).toEqual([])
    expect(h.text()).toContain("loopback")
    await h.type("\x15"); await h.type(URL); await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ apiKeyEnv: "PERPLEXITY_API_KEY", baseUrl: URL })
    await h.type("\x1b")
  })

  test("failed smoke scrubs provider-echoed keys; edit and Escape discard credentials", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 1, error: `Rejected ${KEY}` } } : reply(command) })
    await h.run("/connect perplexity"); await h.type(URL); await h.type("\r"); await h.type(KEY); await h.type("\r")
    expect(h.text()).toContain("Perplexity saved, test failed")
    expect(h.everything()).not.toContain(KEY)
    await h.type("e")
    expect(h.text()).toContain("Endpoint")
    await h.type("\x1b"); await h.type("\x1b")
    await h.run("/connect perplexity")
    expect(h.text()).not.toContain("chars")
    await h.type("\x1b"); await h.type("\x1b")
  })

  test("selected provider, local key and environment forms have bounded panels at all breakpoints", () => {
    let form = connectPaste(createConnectState("perplexity"), URL)
    form = connectKey(form, "\r").state
    const masked = connectPaste(form, KEY)
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      for (const state of [createConnectState("perplexity"), masked, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("perplexity") }]) {
        const rows = renderConnectPage({ state, providers: [{ ...provider, enabled: false }], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Perplexity")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows.join("\n")).not.toContain(KEY)
      }
    }
  })

  test("CLI login uses existing provider commands and never tests implicitly", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "perplexity", name: "Perplexity", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Perplexity", "--base-url", URL, "--api-key-env", "PERPLEXITY_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "perplexity", baseUrl: URL, apiKeyEnv: "PERPLEXITY_API_KEY", enabled: true })
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
  })

  test("management and removal use header hints, padded borders and wrapped capabilities", () => {
    for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) {
      for (const state of [{ selected: 0, detail: true }, { selected: 0, detail: false, confirm: "perplexity" }]) {
        const rows = renderProvidersPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
        expect(rows[0]).toContain(state.confirm ? "y remove" : "esc")
        expect(rows.slice(-2).join("")).not.toContain("esc")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows.join("\n")).toContain("no tools")
        expect(rows.join("\n")).toContain(URL)
      }
    }
  })

  test("persisted citation text uses the ordinary transcript renderer", () => {
    const h = appHarness({ dataDir: temp(), width: 100, height: 30 })
    conversation(h.sessionId, h.app.onEvent).exchange("What is TCP?", "Reliable transport. [1]\n\n[1]: https://example.com/tcp")
    h.app.render()
    expect(h.text().join("\n")).toContain("Reliable transport. [1]")
    expect(h.text().join("\n")).toContain("https://example.com/tcp")
  })
})
