import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { CF_ID, CF_MODEL, CF_MODELS, CF_TOKEN, CF_URL } from "../../../packages/engine-native/test/cloudflare-workers-ai-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-cf-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: CF_ID, type: "openai-compatible", baseUrl: CF_URL, enabled: true, hasKey: true, source: "config", models: CF_MODELS, cloudflareWorkersAi: { accountId: "local-account" } }
const report = { ...REPORT, models: [...REPORT.models, ...CF_MODELS.map((model) => ({ id: `${CF_ID}:${model.id}`, name: `${model.name} · Cloudflare Workers AI`, provider: CF_ID, efforts: [] }))] }
const fill = async (h: ReturnType<typeof providersHarness>) => {
  await h.type(CF_URL); await h.type("\r")
  await h.type(`\x1b[200~${CF_TOKEN}\x1b[201~`); await h.type("\r")
  await h.type("local-account"); await h.type("\r")
}

describe("B10.21 Workers AI CLI factories", () => {
  test("appends the preset without moving numeric shortcuts and aligns native and UI metadata", () => {
    expect(CONNECT_CHOICES.slice(0, 9)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom"])
    expect(CONNECT_CHOICES.filter((id) => id === CF_ID)).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf(CF_ID)).toBeGreaterThan(CONNECT_CHOICES.indexOf("mistral"))
    const { id: _id, ...preset } = presetOf(CF_ID)!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS[CF_ID]!
    expect(preset).toEqual(native)
    expect(models).toEqual(CF_MODELS)
    expect(defaultEnabled).toBe(false)
    for (const name of [CF_ID, "Cloudflare Workers AI", "cloudflare"]) expect(createConnectState(name).target).toBe(CF_ID)
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("saves a masked token once, tab never submits, retains the catalog and selects a Workers AI model", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: CF_MODEL } }
      if (command.type === "models.list") return { ok: true, result: report }
      if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
      return undefined
    } })
    await h.run("/connect Cloudflare Workers AI")
    await fill(h)
    expect(h.everything()).not.toContain(CF_TOKEN)
    await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: CF_ID, baseUrl: CF_URL, apiKey: CF_TOKEN, enabled: true, cloudflareWorkersAi: { accountId: "local-account" } }])
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.test"])
    expect(h.text()).toContain("Cloudflare Workers AI connected")
    await h.type("r"); expect(h.text()).toContain("1 Workers AI model retained")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type(CF_MODEL); await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: `${CF_ID}:${CF_MODEL}` } })
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(CF_TOKEN))).toBe(false)
    expect(h.everything()).not.toContain(CF_TOKEN)
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment mode clears typed credentials, full endpoint needs no account and invalid routing fails inline", () => {
    let state = connectKey(createConnectState(CF_ID), "\x05").state
    expect(validateConnect(state)).toMatchObject({ ok: false, focus: 1, error: expect.stringContaining("account ID") })
    state = connectPaste(state, CF_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: CF_ID, baseUrl: CF_URL, apiKeyEnv: "CLOUDFLARE_API_KEY", apiKey: "", cloudflareWorkersAi: { accountId: null }, enabled: true } })
    for (const baseUrl of ["http://api.cloudflare.com/v1","http://127.0.0.1.evil/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...state, values: { ...state.values, cloudflareAccountId: "../account" } })).toMatchObject({ ok: false, error: "invalid Cloudflare account id" })
  })

  test("failed save/test redact token echoes, preserve public fields and support retry/edit", async () => {
    for (const phase of ["providers.set", "providers.test"]) {
      let fail = true
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === phase && fail) return { ok: false, error: { code: "internal", message: `rejected ${CF_TOKEN}` } }
        if (command.type === "providers.set") return { ok: true, result: { provider } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1, model: CF_MODEL } }
        return undefined
      } })
      await h.run(`/connect ${CF_ID}`); await fill(h); await h.type("\r")
      expect(h.everything()).not.toContain(CF_TOKEN)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      fail = false
      if (phase === "providers.test") {
        expect(h.text()).toContain("saved, test failed")
        await h.type("t"); expect(h.text()).toContain("Cloudflare Workers AI connected")
        await h.type("e")
      }
      expect(h.text()).toContain("Endpoint")
      expect(h.text()).toContain("local-account")
      expect(h.text()).toContain("required")
      expect(h.app.editor.text).toBe("")
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("reopening seeds public routing only; provider management toggles and confirms removal", async () => {
    let current = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.remove") return { ok: true, result: { providers: [] } }
      return undefined
    } })
    await h.run(`/connect ${CF_ID}`)
    expect(h.text()).toContain("local-account")
    expect(h.text()).toContain(CF_MODEL)
    expect(h.text()).toContain("required")
    await h.type("\x1b"); await h.type("\x1b")
    await h.run("/providers"); await h.type("\r")
    expect(h.text()).toContain("Account")
    expect(h.text()).toContain("local-account")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: CF_ID, enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: CF_ID }])
    expect(h.text()).toContain("No providers")
    await h.type("\x1b")
  })

  test("compact and wide states fill the shared panel grid with header hints and no clipped cells", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState(CF_ID)
      const states = [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf(CF_ID) }, { ...form, step: "result" as const, result: { provider: CF_ID, ok: false, error: "proxy unavailable" } }]
      for (const state of states) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Cloudflare Workers AI")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("local-account")
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login resolves the provider name and saves without automatic enablement or requests", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: CF_ID, name: "Cloudflare Workers AI", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Cloudflare Workers AI", "--base-url", CF_URL, "--api-key-env", "CLOUDFLARE_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: CF_ID, baseUrl: CF_URL, apiKeyEnv: "CLOUDFLARE_API_KEY" })
    expect(h.sent.some((command) => ["providers.test", "providers.refresh"].includes(command.type))).toBe(false)
  })

  test("CLI startup keeps daemon and protocol schemas out of its module graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
