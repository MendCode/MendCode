import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { ModelInfo, RecipesReport } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { ModelCatalog } from "../src/models"
import { activeRecipe, readRecipes } from "../src/recipes"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
}

const MODELS: ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
]
const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-luna", effort: "low" } }

describe("recipes", () => {
  test("recipes load from every layer, a later layer wins, and bad files carry a problem", () => {
    const user = temp("recipes-user-")
    const project = temp("recipes-proj-")
    write(path.join(user, "recipes", "fast.json"), { description: "cheap everywhere", roles: { main: { model: "gpt-6-luna", effort: "low" } } })
    write(path.join(user, "recipes", "deep.json"), { description: "user deep", roles: { main: { model: "gpt-6-sol", effort: "high" } } })
    write(path.join(project, ".mendcode", "recipes", "deep.json"), { description: "project deep", version: "2", roles: { main: { model: "gpt-6-sol", effort: "xhigh" }, subagent: { model: "gpt-6-luna" } } })
    write(path.join(project, ".mendcode", "recipes", "broken.json"), { roles: {} })
    const recipes = readRecipes([
      { dir: user, source: "user" },
      { dir: path.join(project, ".mendcode"), source: "project" },
    ])
    expect(recipes.map((r) => [r.name, r.source, r.description])).toEqual([
      ["fast", "user", "cheap everywhere"],
      ["broken", "project", ""],
      ["deep", "project", "project deep"],
    ])
    expect(recipes.find((r) => r.name === "broken")!.problem).toContain("description")
    expect(activeRecipe(recipes, { main: { model: "gpt-6-luna", effort: "low" } })).toBe("fast")
    expect(activeRecipe(recipes, {})).toBeUndefined()
  })

  test("applying a recipe replaces the roles after checking every choice against the catalog", async () => {
    const dir = temp("mendd-recipes-")
    const project = temp("mendd-recipes-proj-")
    write(path.join(dir, "recipes", "deep.json"), { description: "deep work", roles: { main: { model: "gpt-6-sol", effort: "high" }, compaction: { model: "gpt-6-luna", effort: "low" } } })
    write(path.join(dir, "recipes", "bogus.json"), { description: "bad effort", roles: { main: { model: "gpt-6-luna", effort: "xhigh" } } })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), models: catalog, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "recipes" })
    await client.connect()
    cleanups.push(() => client.close())

    const applied = await client.send({ type: "recipes.apply", directory: project, name: "deep" })
    expect(applied).toMatchObject({ ok: true, result: { active: "deep" } })
    expect((applied.ok ? (applied.result as RecipesReport) : undefined)?.recipes.map((r) => r.name)).toEqual(["balanced", "quick", "bogus", "deep"])
    expect(await client.send({ type: "settings.get" })).toMatchObject({ result: { settings: { models: { main: { model: "gpt-6-sol", effort: "high" }, compaction: { model: "gpt-6-luna", effort: "low" } } } } })

    const rejected = await client.send({ type: "recipes.apply", directory: project, name: "bogus" })
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(rejected.ok ? "" : rejected.error.message).toContain("supports low, medium, high")
    expect(await client.send({ type: "recipes.apply", directory: project, name: "missing" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    // The failed applies left the roles alone.
    expect(await client.send({ type: "recipes.list", directory: project })).toMatchObject({ ok: true, result: { active: "deep" } })
  })
})

describe("built-in recipes", () => {
  test("quick, balanced and deep ship with the daemon and only use the default model's guaranteed efforts", () => {
    const builtin = readRecipes([{ dir: path.join(import.meta.dir, "..", "builtin"), source: "builtin" } as never])
    expect(builtin.map((recipe) => recipe.name).sort()).toEqual(["balanced", "deep", "quick"])
    for (const recipe of builtin) {
      expect(recipe.problem).toBeUndefined()
      for (const choice of Object.values(recipe.roles)) {
        expect(choice?.model).toBe("gpt-6-luna")
        expect(["low", "medium", "high"]).toContain(choice?.effort ?? "")
      }
    }
  })
})
