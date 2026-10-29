import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderInfo } from "@mendcode/protocol"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { KILO_MODELS, KILO_TOKEN, KILO_URL } from "../../../packages/engine-native/test/kilo-fixtures"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, renderConnectPage, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS, presetOf } from "../src/view/provider-presets"
import { renderProvidersPage } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { catalogHarness } from "./catalog-harness"
import { plain, providersHarness, REPORT } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-gateway-ui-")); dirs.push(dir); return dir }
const provider: ProviderInfo = { id: "kilo", type: "openai-compatible", baseUrl: KILO_URL, enabled: true, hasKey: true, source: "config", models: KILO_MODELS }
const report = { ...REPORT, models: [...REPORT.models, ...KILO_MODELS.map((model) => ({ id: `kilo:${model.id}`, name: model.name ?? model.id, provider: "kilo", efforts: [] }))] }

describe("B10.23 Kilo CLI factories", () => {
  test("appends the provider, preserves numeric shortcuts and aligns both preset tables", () => {
    expect(CONNECT_CHOICES.slice(0, 9)).toEqual(["openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "ollama", "lmstudio", "custom"])
    expect(CONNECT_CHOICES.indexOf("kilo")).toBeGreaterThan(CONNECT_CHOICES.indexOf("togetherai"))
    expect(CONNECT_CHOICES.filter((id) => id === "kilo")).toHaveLength(1)
    expect(CONNECT_PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(PROVIDER_PRESETS).sort())
    const { id: _id, ...preset } = presetOf("kilo")!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS.kilo!
    expect(preset).toEqual(native)
    expect(models).toEqual([])
    expect(defaultEnabled).toBe(false)
    expect(createConnectState("Kilo").target).toBe("kilo")
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("saves the masked token once, refreshes before testing and selects a gateway model", async () => {
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "reasoning-fixture" } }
      if (command.type === "models.list") return { ok: true, result: report }
      if (command.type === "session.model.set") return { ok: true, result: { ...report, effective: command.choice } }
      return undefined
    } })
    await h.run("/connect Kilo")
    expect(h.text()).toContain("https://api.kilo.ai/api/gateway")
    await h.type(KILO_URL); await h.type("\r"); await h.type(`\x1b[200~${KILO_TOKEN}\x1b[201~`)
    await h.type("\t")
    expect(h.commands("providers.set")).toHaveLength(0)
    await h.type("\t")
    expect(h.text()).toContain("chars")
    expect(h.everything()).not.toContain(KILO_TOKEN)
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "kilo", baseUrl: KILO_URL, apiKey: KILO_TOKEN, enabled: true }])
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(KILO_TOKEN))).toBe(false)
    expect(h.text()).toContain("Kilo connected")
    await h.type("r"); expect(h.text()).toContain("2 models loaded")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("reasoning-fixture"); expect(h.text()).toContain("reasoning-fixture")
    expect(h.text()).not.toContain("· Kilo · Kilo")
    await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "kilo:reasoning-fixture" } })
    expect(h.everything()).not.toContain(KILO_TOKEN)
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)

  test("environment references need no URL (public default) and plain-HTTP public or capability-bearing URLs fail inline", () => {
    let state = connectKey(createConnectState("kilo"), "\x05").state
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "kilo", apiKeyEnv: "KILO_API_KEY", enabled: true } })
    state = connectPaste(state, KILO_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "kilo", baseUrl: KILO_URL, apiKeyEnv: "KILO_API_KEY", enabled: true } })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("KILO_API_KEY")
    for (const baseUrl of ["http://api.kilo.ai/api/gateway", "http://127.0.0.1.evil/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
  })

  test("failed save, refresh and test redact tokens; refresh failure skips testing and supports retry", async () => {
    for (const phase of ["providers.set", "providers.refresh", "providers.test"]) {
      let fail = true
      const h = providersHarness({ dataDir: temp(), reply: (command) => {
        if (command.type === phase && fail) return { ok: false, error: { code: "internal", message: `rejected ${KILO_TOKEN}` } }
        if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 1, model: "reasoning-fixture" } }
        return undefined
      } })
      await h.run("/connect kilo"); await h.type(KILO_URL); await h.type("\r"); await h.type(KILO_TOKEN); await h.type("\r")
      expect(h.everything()).not.toContain(KILO_TOKEN)
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      if (phase === "providers.refresh") {
        expect(h.text()).toContain("saved, model refresh failed")
        expect(h.text()).not.toContain("test failed")
        fail = false
        await h.type("r"); expect(h.commands("providers.refresh")).toHaveLength(2)
        expect(h.commands("providers.test")).toHaveLength(1)
        expect(h.text()).toContain("Kilo connected")
        await h.type("t"); expect(h.text()).toContain("Kilo connected")
      }
      if (phase !== "providers.set") { await h.type("e"); expect(h.text()).toContain("Endpoint"); expect(h.text()).toContain("required") }
      expect(h.app.editor.text).toBe("")
      await h.type("\x1b"); await h.type("\x1b")
    }
  }, 15_000)

  test("provider management toggles and removes through daemon commands", async () => {
    let current = { ...provider }
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.list") return { ok: true, result: { providers: [current] } }
      if (command.type === "providers.set") { current = { ...current, enabled: command.enabled === true }; return { ok: true, result: { provider: current } } }
      if (command.type === "providers.remove") return { ok: true, result: { providers: [] } }
      return undefined
    } })
    await h.run("/providers"); expect(h.text()).toContain("Kilo")
    await h.type("\r"); expect(h.text()).toContain("reasoning-fixture")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "kilo", enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: "kilo" }])
    await h.type("\x1b")
  })

  test("all connection states fit compact and wide grids with visible focus and header hints", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const form = createConnectState("kilo")
      const states = [form, connectKey(form, "\x05").state, { ...createConnectState(), selected: CONNECT_CHOICES.indexOf("kilo") }, { ...form, step: "result" as const, result: { provider: "kilo", ok: false, note: "Model refresh failed", error: "proxy unavailable" } }]
      for (const state of states) {
        const rows = renderConnectPage({ state, providers: [provider], width: width!, height: height! }).map(plain)
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Kilo")
        expect(rows.join("\n")).toContain("┌")
        expect(rows.join("\n")).toContain("└")
        expect(rows[0]).toContain("esc")
        if (state.step === "form" || state.step === "result") expect(rows.join("\n").includes("configured models")).toBe(width! >= 110)
      }
      const rows = renderProvidersPage({ state: { selected: 0, detail: true }, providers: [provider], width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
      expect(rows.join("\n")).toContain("reasoning-fixture")
      expect(rows[0]).toContain("esc")
    }
  })

  test("CLI login resolves the display name and stays explicit about requests", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "providers.catalog" ? { providers: [{ id: "kilo", name: "Kilo", authMode: "api-key" }] } : {} }) })
    expect(await h.run(["providers", "login", "--provider", "Kilo", "--base-url", KILO_URL, "--api-key-env", "KILO_API_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "kilo", baseUrl: KILO_URL, apiKeyEnv: "KILO_API_KEY", enabled: true })
    expect(h.sent.some((command) => ["providers.test", "providers.refresh"].includes(command.type))).toBe(false)
  })

  test("terminal startup remains free of daemon and protocol schemas", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/view/connect-page"); await import("./src/catalog-args"); console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(providers|commands|queries|events)\\.ts$/.test(key))))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual([])
  })
})
