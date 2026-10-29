import { readdir, readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { readPetLayout, type PetLayout } from "../../../../packages/protocol/src/pet-data"

export type PetSource = "codex" | "user" | "package"
export type PetInfo = { ref: `${PetSource}:${string}`; id: string; displayName: string; description: string; sheetPath: string; version: 1 | 2; /** Generated pets only: the states the generator drew. */ generatedStates?: string[]; /** Imported pets only (`/pet import`): their own frames and timings instead of the Codex atlas. */ layout?: PetLayout }
export type SkippedPet = { dir: string; reason: string }

const MAX_MANIFEST_BYTES = 64 * 1024
const SHEET_EXTENSIONS = [".png", ".webp"]

/**
 * Lists Codex-format pets: every subfolder of each `dir` with a valid `pet.json` and its spritesheet.
 * Read-only and never throws; a folder that cannot be used is reported in `skipped` with a reason.
 */
export async function listPets(dirs: Array<{ dir: string; source: PetSource }>): Promise<{ pets: PetInfo[]; skipped: SkippedPet[] }> {
  const pets: PetInfo[] = []
  const skipped: SkippedPet[] = []
  const seen = new Set<string>()
  for (const { dir, source } of dirs) {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.sort()) {
      const folder = join(dir, name)
      if (!(await stat(folder).then((s) => s.isDirectory(), () => false))) continue
      const result = await readPet({ folder, source })
      if (typeof result === "string") skipped.push({ dir: folder, reason: result })
      else if (seen.has(result.ref)) skipped.push({ dir: folder, reason: `duplicate pet ${result.ref}` })
      else {
        seen.add(result.ref)
        pets.push(result)
      }
    }
  }
  return { pets, skipped }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Returns the pet, or the reason it was rejected. */
async function readPet({ folder, source }: { folder: string; source: PetSource }): Promise<PetInfo | string> {
  const file = join(folder, "pet.json")
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return "missing pet.json"
  if (info.size > MAX_MANIFEST_BYTES) return "pet.json is too large"
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    return `invalid pet.json: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!record(json)) return "pet.json must be an object"
  const { id, displayName, description, spritesheetPath, spriteVersionNumber } = json
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return "pet.json needs an id of letters, digits, dot, dash or underscore"
  if (typeof spritesheetPath !== "string" || spritesheetPath === "") return "pet.json needs a spritesheetPath"
  if (displayName !== undefined && typeof displayName !== "string") return "displayName must be a string"
  if (description !== undefined && typeof description !== "string") return "description must be a string"
  if (spriteVersionNumber !== undefined && spriteVersionNumber !== 1 && spriteVersionNumber !== 2) return "spriteVersionNumber must be 1 or 2"
  const sheetPath = join(folder, spritesheetPath)
  const outside = relative(folder, sheetPath)
  if (isAbsolute(spritesheetPath) || outside.startsWith("..") || isAbsolute(outside)) return "spritesheetPath must stay inside the pet folder"
  if (!SHEET_EXTENSIONS.some((extension) => sheetPath.toLowerCase().endsWith(extension))) return "spritesheet must be a .png or .webp file"
  if (!(await stat(sheetPath).then((s) => s.isFile(), () => false))) return `missing spritesheet ${spritesheetPath}`
  const generatedStates = json.experimental === true && Array.isArray(json.states) ? json.states.filter((item): item is string => typeof item === "string").slice(0, 16) : undefined
  const layout = json.imported === true ? readPetLayout(json.layout) : undefined
  if (json.imported === true && !layout) return "imported pet without a usable layout"
  return { ref: `${source}:${id}`, id, displayName: displayName?.trim() || id, description: description ?? "", sheetPath, version: spriteVersionNumber === 2 ? 2 : 1, ...(generatedStates ? { generatedStates } : {}), ...(layout ? { layout } : {}) }
}
