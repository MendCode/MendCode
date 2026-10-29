import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { ExtensionLayer } from "@mendcode/packages"
import { ModelRoles, type RecipeInfo } from "@mendcode/protocol"
import { z } from "zod"

/**
 * Model recipes: a named, versioned set of model roles in any layer's `recipes/<name>.json`
 * (`{ "description", "version"?, "roles": { "main": { "model", "effort"? }, … } }`). Applying one replaces the
 * settings' roles in one step. A later layer's recipe replaces one of the same name.
 */
const RECIPE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const MAX_RECIPE_BYTES = 16 * 1024
const MAX_RECIPES = 100

const recipeSchema = z.strictObject({
  description: z.string().min(1).max(300),
  version: z.string().max(40).optional(),
  roles: ModelRoles,
})

export function readRecipes(layers: readonly ExtensionLayer[]): RecipeInfo[] {
  const byName = new Map<string, RecipeInfo>()
  for (const layer of layers) {
    const dir = path.join(layer.dir, "recipes")
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (byName.size >= MAX_RECIPES) break
      const name = entry.slice(0, -".json".length)
      const file = path.join(dir, entry)
      const base = { name, file, source: layer.source, ...(layer.pkg ? { pkg: layer.pkg } : {}) }
      byName.delete(name)
      byName.set(name, { ...base, ...parseRecipe(file, name) })
    }
  }
  return [...byName.values()]
}

function parseRecipe(file: string, name: string): Pick<RecipeInfo, "description" | "version" | "roles" | "problem"> {
  const problem = (message: string) => ({ description: "", roles: {}, problem: message })
  if (!RECIPE_NAME.test(name)) return problem("recipe names use lowercase letters, digits, . _ - (max 40)")
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (size === undefined || size > MAX_RECIPE_BYTES) return problem(size === undefined ? "not readable" : `larger than ${MAX_RECIPE_BYTES / 1024} KB`)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    return problem(`invalid JSON: ${(error as Error).message}`)
  }
  const parsed = recipeSchema.safeParse(json)
  if (!parsed.success) return problem(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "))
  return { description: parsed.data.description, ...(parsed.data.version ? { version: parsed.data.version } : {}), roles: parsed.data.roles }
}

/** The recipe whose roles equal the settings' roles, if any (shown as the active one). */
export function activeRecipe(recipes: readonly RecipeInfo[], roles: ModelRoles): string | undefined {
  const key = (value: ModelRoles) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  return recipes.find((recipe) => !recipe.problem && key(recipe.roles) === key(roles))?.name
}
