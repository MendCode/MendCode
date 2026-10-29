import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAcpAgents } from "@mendcode/engine-acp"
import { catalogEfforts } from "@mendcode/engine-native"
import { createModelsDev, MODELS_DEV_URL } from "../src/models-dev"
import { createProviderService } from "../src/providers"
import { acpAgentName } from "../src/acp-registry"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-models-dev-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Entries as models.dev writes them (2026-10-18), nulls and fields the cache does not keep included. */
const CATALOG = {
  opencode: {
    models: {
      "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], cost: { input: 0.1, output: 0.4 }, interleaved: null, description: "x" },
      "deepseek-v4.1-flash-free": { id: "deepseek-v4.1-flash-free", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], cost: { input: 0, output: 0 } },
      "big-pickle": { id: "big-pickle", reasoning: true, reasoning_options: null, cost: { input: 0, output: 0 } },
      "gpt-5.3-codex": { id: "gpt-5.3-codex", reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }], cost: { input: 1.25, output: 10 } },
    },
  },
}
const served = (body: unknown, calls: string[] = []) => (async (url: string | URL | Request) => {
  calls.push(String(url))
  return new Response(JSON.stringify(body))
}) as typeof fetch

describe("models.dev catalog", () => {
  test("a download keeps only the reasoning controls and prices, reads models.dev's nulls as absent, and is not repeated within the week", async () => {
    const dir = temp()
    const calls: string[] = []
    let now = Date.now()
    const catalog = createModelsDev({ dir, fetch: served(CATALOG, calls), now: () => now })
    expect(catalog.facts("opencode", "deepseek-v4.1-flash")).toBeUndefined()
    expect(await catalog.refresh()).toBe(true)
    expect(calls).toEqual([MODELS_DEV_URL])
    expect(catalog.facts("opencode", "deepseek-v4.1-flash")).toEqual({ reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], cost: { input: 0.1, output: 0.4 } })
    expect(catalog.facts("opencode", "big-pickle")).toEqual({ reasoning: true, cost: { input: 0, output: 0 } })
    expect(readFileSync(path.join(dir, "models-dev-cache.json"), "utf8")).not.toContain("description")
    expect(await catalog.refresh()).toBe(false)
    now += 8 * 24 * 60 * 60 * 1000
    expect(await catalog.refresh()).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test("a failed download keeps the catalog it had and says why", async () => {
    const dir = temp()
    const logs: string[] = []
    const good = createModelsDev({ dir, fetch: served(CATALOG) })
    await good.refresh()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(path.join(dir, "models-dev-cache.json"), old, old)
    const failing = createModelsDev({ dir, fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch, log: (message) => void logs.push(message) })
    expect(await failing.refresh()).toBe(false)
    expect(logs).toEqual(["models.dev catalog not refreshed: HTTP 503"])
    expect(failing.facts("opencode", "gpt-5.3-codex")?.reasoning_options).toBeDefined()
  })

  test("OpenCode Zen's models get their levels from the catalog, a configured field wins, and its free tier (which Zen serves only to OpenCode) is not offered", async () => {
    const dir = temp()
    const catalog = createModelsDev({ dir, fetch: served(CATALOG) })
    await catalog.refresh()
    writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ providers: { opencode: { apiKey: "zen-test-key-local-only", enabled: true, refreshedAt: 1, models: [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-v4.1-flash-free" }, { id: "big-pickle" }, { id: "glm-9-free" }, { id: "gpt-5.3-codex", reasoning_options: [{ type: "effort", values: ["low", "high"] }] }] } } }), { mode: 0o600 })
    const providers = createProviderService({ dir, env: {}, modelsDev: catalog })
    const models = providers.models().filter((model) => model.id.startsWith("opencode:"))
    expect(models.map((model) => model.id)).toEqual(["opencode:deepseek-v4.1-flash", "opencode:gpt-5.3-codex"])
    expect(models.find((model) => model.id === "opencode:deepseek-v4.1-flash")?.efforts).toEqual(["low", "high", "max"])
    expect(models.find((model) => model.id === "opencode:gpt-5.3-codex")?.efforts).toEqual(["low", "high"])
    expect(existsSync(path.join(dir, "models.dev.json"))).toBe(false)
  })

  test("an ACP agent's models are named for its harness and show the catalog's levels until the agent lists its own", async () => {
    const dir = temp()
    const catalog = createModelsDev({ dir, fetch: served(CATALOG) })
    await catalog.refresh()
    writeFileSync(path.join(dir, "acp-agents.json"), JSON.stringify({ opencode: { command: "opencode-not-installed", args: ["acp"] } }))
    writeFileSync(path.join(dir, "acp-models.json"), JSON.stringify({ opencode: [{ value: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" }, { value: "opencode/gpt-5.3-codex", name: "GPT-5.3 Codex", efforts: ["low"] }, { value: "unknown/model", name: "Unknown" }] }))
    const agents = createAcpAgents({
      dir,
      displayName: acpAgentName,
      catalogEfforts: (model) => {
        const slash = model.indexOf("/")
        const facts = slash > 0 ? catalog.facts(model.slice(0, slash), model.slice(slash + 1)) : undefined
        return facts ? catalogEfforts(facts) : undefined
      },
    })
    const efforts = Object.fromEntries(agents.models().map((model) => [model.id, model.efforts]))
    expect(efforts["acp:opencode/opencode/deepseek-v4.1-flash-free"]).toEqual(["low", "high", "max"])
    expect(efforts["acp:opencode/opencode/gpt-5.3-codex"]).toEqual(["low"])
    expect(efforts["acp:opencode/unknown/model"]).toEqual([])
    // Named for the harness that runs them, apart from Zen's own models on MendCode's harness.
    expect(agents.models().slice(0, 2).map((model) => model.name)).toEqual(["OpenCode harness", "DeepSeek V4.1 Flash Free · OpenCode harness"])
  })
})
