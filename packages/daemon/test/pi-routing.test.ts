import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory, ModelInfo, type SessionId } from "@mendcode/protocol"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import { createPiConfig, withPiEngine } from "@mendcode/engine-pi"
import { catalogChoice } from "../src/catalog-control"
import { invalidChoice, modelEngine, resolveModel, type ModelCatalog } from "../src/models"

const ids = createIdFactory()
const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" }]
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function catalogWith(piJson: object | undefined, optedIn = false): ModelCatalog {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-pi-catalog-"))
  temps.push(dir)
  if (piJson) writeFileSync(join(dir, "pi.json"), JSON.stringify(piJson))
  const config = createPiConfig({ dir, optedIn: () => optedIn })
  return { selectable: true, list: () => [...NATIVE, ...config.models()], defaults: { model: "gpt-6-luna", effort: "low" } }
}

describe("pi models in the catalog", () => {
  test("nothing is listed until the user opts in with pi.json or features.pi", () => {
    expect(catalogWith(undefined).list().map((model) => model.id)).toEqual(["gpt-6-luna"])
    expect(catalogWith(undefined, true).list().map((model) => model.id)).toEqual(["gpt-6-luna", "pi"])
    expect(catalogWith({ models: ["anthropic/sonnet"] }).list().map((model) => model.id)).toEqual(["gpt-6-luna", "pi", "pi:anthropic/sonnet"])
  })

  test("entries pass the protocol schema and carry engine pi", () => {
    for (const model of catalogWith({ models: ["openai/gpt-5:high"] }).list().slice(1)) {
      expect(ModelInfo.safeParse(model).success).toBe(true)
      expect(model.engine).toBe("pi")
    }
  })

  test("a pi model drives main only: other roles skip it and it is refused for them", () => {
    const catalog = catalogWith({ models: ["anthropic/sonnet"] })
    const roles = { main: { model: "pi:anthropic/sonnet" } }
    expect(modelEngine(resolveModel({ role: "main", roles, catalog }), catalog)).toBe("pi")
    expect(resolveModel({ role: "dream", roles, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(invalidChoice({ model: "pi" }, catalog)).toBeUndefined()
    expect(invalidChoice({ model: "pi" }, catalog, "dream")).toContain("runs whole sessions")
    expect(invalidChoice({ model: "pi", effort: "high" }, catalog)).toBeUndefined()
  })

  test("catalog control resolves provider pi and refuses an API key for it", () => {
    const catalog = catalogWith({ models: ["anthropic/sonnet"] })
    expect(catalogChoice({ provider: "pi", model: "pi:anthropic/sonnet" }, catalog)).toEqual({ model: "pi:anthropic/sonnet" })
    expect(() => catalogChoice({ provider: "pi", model: "pi", authMode: "api-key" }, catalog)).toThrow("API key auth requires an API provider")
    expect(() => catalogChoice({ provider: "pi", model: "pi:other" }, catalog)).toThrow("unavailable model")
  })
})

describe("the pi router in front of the daemon's engines", () => {
  test("agent debug and catalog tools stay on the base engine, a pi session never loads anything for them", async () => {
    const calls: string[] = []
    let created = 0
    const base: EnginePort = {
      runTurn: async () => (calls.push("base.turn"), { status: "ok" }),
      needsCompaction: () => true,
      compact: async () => ({ status: "ok" }),
      debugAgent: async () => (calls.push("base.debug"), { tools: {} }),
      catalogTools: async () => (calls.push("base.catalog"), []),
    }
    const router = withPiEngine({ base, pi: async () => (created++, base), usesPi: (sessionId) => sessionId === ("pi" as SessionId) })
    await router.debugAgent?.({ directory: "/x", sessionId: "pi" as SessionId, agent: { name: "a", prompt: "" } as never })
    await router.catalogTools?.({ directory: "/x" })
    await router.runTurn({ sessionId: ids("session") } as TurnInput)
    expect(calls).toEqual(["base.debug", "base.catalog", "base.turn"])
    expect(created).toBe(0)
  })
})
