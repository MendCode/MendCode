import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Fetch } from "@mendcode/engine-native"
import { collectZen, ZEN_TOKEN, ZEN_URL, zenFake, zenRequest } from "../../engine-native/test/zen-fixtures"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-levels-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/** Entries as models.dev writes them (2026-10-17), nulls included. */
const CATALOG = {
  "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], tool_call: true, interleaved: { field: "reasoning_content" }, status: null, limit: { context: 200_000, output: 32_000 }, provider: { api: "https://opencode.ai/inference/openai/v1" }, cost: { input: 0.1, output: 0.4, cache_read: 0.01 } },
  "nemotron-3.5-super-vl": { id: "nemotron-3.5-super-vl", reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] }], interleaved: null, status: null },
  "big-pickle": { id: "big-pickle", reasoning: true, reasoning_options: [], status: null },
  "kimi-k2.5": { id: "kimi-k2.5", reasoning: true, reasoning_options: [{ type: "toggle" }], interleaved: { field: "reasoning_content" } },
  "trinity-large-preview": { id: "trinity-large-preview", reasoning: false, reasoning_options: null },
  "plain-reasoner": { id: "plain-reasoner", reasoning: true },
}

function zen(dir: string, seen: Array<Record<string, unknown>>) {
  writeFileSync(path.join(dir, "models.dev.json"), JSON.stringify({ opencode: { models: CATALOG } }))
  writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { opencode: { enabled: true, apiKey: ZEN_TOKEN, baseUrl: ZEN_URL } } }))
  const fetch: Fetch = async (url, init) => { if (init.method !== "GET") seen.push(JSON.parse(String(init.body))); return zenFake(url, init) }
  return createProviderService({ dir, env: {}, fetch })
}

describe("reasoning levels from the model catalog", () => {
  test("a model's selectable levels are its catalog's, max and none included; an empty list means none; no list keeps the old three", () => {
    const providers = zen(temp(), [])
    const efforts = Object.fromEntries(providers.models().map((model) => [model.id, model.efforts]))
    expect(efforts).toEqual({
      "opencode:deepseek-v4.1-flash": ["low", "high", "max"],
      "opencode:nemotron-3.5-super-vl": ["none", "minimal", "low", "medium", "high", "xhigh"],
      "opencode:big-pickle": [],
      // A toggle alone gives no level on a plain Chat Completions host (OpenCode offers none there either).
      "opencode:kimi-k2.5": [],
      "opencode:trinity-large-preview": [],
      "opencode:plain-reasoner": ["low", "medium", "high"],
    })
    // models.dev's nulls do not drop an entry, and the catalog's controls reach the model info.
    const deepseek = providers.models().find((model) => model.id === "opencode:deepseek-v4.1-flash")!
    expect(deepseek).toMatchObject({ contextWindow: 200_000, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] })
    expect(deepseek.defaultEffort).toBeUndefined()
  })

  test("a level the catalog lists goes to the host as named: max, none and a listed xhigh; an unlisted xhigh still becomes high", async () => {
    const seen: Array<Record<string, unknown>> = []
    const runtime = zen(temp(), seen).runtime().opencode!
    for (const [model, effort] of [["deepseek-v4.1-flash", "max"], ["deepseek-v4.1-flash", "low"], ["nemotron-3.5-super-vl", "none"], ["nemotron-3.5-super-vl", "xhigh"], ["plain-reasoner", "xhigh"]] as const) {
      const events = await collectZen(runtime.stream({ ...zenRequest(model), effort }))
      expect(events.at(-1)).toMatchObject({ type: "finish" })
    }
    expect(seen.map((body) => [body.model, body.reasoning_effort, body.thinking])).toEqual([
      ["deepseek-v4.1-flash", "max", undefined],
      ["deepseek-v4.1-flash", "low", undefined],
      ["nemotron-3.5-super-vl", "none", undefined],
      ["nemotron-3.5-super-vl", "xhigh", undefined],
      ["plain-reasoner", "high", undefined],
    ])
  })

  test("DeepSeek's own API: low/high/max by default, reasoning_effort with thinking enabled, and none turns thinking off", async () => {
    const dir = temp()
    const seen: Array<Record<string, unknown>> = []
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { deepseek: { baseUrl: "http://127.0.0.1:1235/v1", models: [{ id: "deepseek-v4-flash", reasoning: true }, { id: "deepseek-toggle", reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort" }] }] } } }))
    const providers = createProviderService({ dir, env: { DEEPSEEK_API_KEY: "deepseek-local-fixture-0123456789" }, fetch: async (url, init) => { seen.push(JSON.parse(String(init.body))); return zenFake(url, init) } })
    expect(Object.fromEntries(providers.models().map((model) => [model.id, model.efforts]))).toEqual({ "deepseek:deepseek-v4-flash": ["low", "high", "max"], "deepseek:deepseek-toggle": ["none", "low", "high", "max"] })
    const runtime = providers.runtime().deepseek!
    for (const effort of ["max", "none", undefined] as const) await collectZen(runtime.stream({ ...zenRequest("deepseek-v4-flash"), ...(effort ? { effort } : {}) }))
    expect(seen.map((body) => [body.reasoning_effort, body.thinking])).toEqual([["max", { type: "enabled" }], [undefined, { type: "disabled" }], [undefined, undefined]])
  })
})
