import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CONNECT_CHOICES, connectKey, connectPaste, createConnectState, validateConnect } from "../src/view/connect-page"
import { CONNECT_PRESETS, GATEWAY_CHOICES, presetOf } from "../src/view/provider-presets"
import { info, providersHarness } from "./providers-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-gateway-ui-")); dirs.push(dir); return dir }
const KEY = "gateway-ui-key-0123456789abcdef"
const keyed = GATEWAY_CHOICES.filter((id) => id !== "atomic-chat" && id !== "foundry")

describe("gateway presets in /connect", () => {
  test("they follow the older presets, keep digits 1-9, and match the preset table", () => {
    expect(CONNECT_CHOICES.slice(-GATEWAY_CHOICES.length - 1)).toEqual([...GATEWAY_CHOICES, "opencode-free"])
    expect(GATEWAY_CHOICES.every((id) => presetOf(id))).toBe(true)
    expect(CONNECT_PRESETS.filter((preset) => GATEWAY_CHOICES.includes(preset.id))).toHaveLength(GATEWAY_CHOICES.length)
    expect(createConnectState("Hugging Face").target).toBe("huggingface")
    expect(createConnectState("moonshot ai").target).toBe("moonshotai")
  })

  for (const id of keyed) {
    test(`${id}: the key alone saves it, the variable form names the preset's variable, a bad endpoint fails inline`, () => {
      const preset = presetOf(id)!
      const state = connectPaste({ ...createConnectState(id), focus: 1 }, KEY)
      expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: id, apiKey: KEY, enabled: true } })
      const viaEnv = connectKey(createConnectState(id), "\x05").state
      expect(validateConnect(viaEnv)).toEqual({ ok: true, submit: { provider: id, apiKeyEnv: preset.keyEnv, enabled: true } })
      expect(validateConnect({ ...viaEnv, values: { ...viaEnv.values, baseUrl: "http://api.example.com/v1" } })).toMatchObject({ ok: false, focus: 0 })
      expect(validateConnect({ ...viaEnv, values: { ...viaEnv.values, baseUrl: "https://proxy.example.com/v1" } })).toMatchObject({ ok: true, submit: { baseUrl: "https://proxy.example.com/v1" } })
    })
  }

  test("foundry requires the resource endpoint; atomic-chat is a local server form without a key", () => {
    const foundry = connectKey(createConnectState("foundry"), "\x05").state
    expect(validateConnect(foundry)).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...foundry, values: { ...foundry.values, baseUrl: "https://res.services.ai.azure.com/openai/v1" } })).toEqual({ ok: true, submit: { provider: "foundry", baseUrl: "https://res.services.ai.azure.com/openai/v1", apiKeyEnv: "AZURE_AI_FOUNDRY_API_KEY", enabled: true } })
    const atomic = createConnectState("atomic-chat")
    expect(atomic.values.baseUrl).toBe("http://127.0.0.1:1337/v1")
    expect(validateConnect(atomic)).toEqual({ ok: true, submit: { provider: "atomic-chat", enabled: true } })
  })

  test("saving refreshes the model list before testing, and the key is sent once", async () => {
    const provider = info("fireworks", { baseUrl: "https://api.fireworks.ai/inference/v1", models: [{ id: "vendor/model" }] })
    const h = providersHarness({ dataDir: temp(), reply: (command) => {
      if (command.type === "providers.set" || command.type === "providers.refresh") return { ok: true, result: { provider } }
      if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 9, model: "vendor/model" } }
      return undefined
    } })
    await h.run("/connect fireworks")
    await h.type("\r")
    await h.type(`\x1b[200~${KEY}\x1b[201~`)
    await h.type("\r")
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "fireworks", apiKey: KEY, enabled: true }])
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(KEY))).toBe(false)
    expect(h.everything()).not.toContain(KEY)
    expect(h.text()).toContain("Fireworks connected")
    await h.type("\x1b"); await h.type("\x1b")
  }, 15_000)
})
