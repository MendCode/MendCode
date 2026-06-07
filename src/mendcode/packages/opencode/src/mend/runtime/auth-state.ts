import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"

async function readJsonIfExists(file: string, fallback: any) {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8"))
}

function projectProviderAuthStateFile(root: string, providerID: string) {
  return path.join(root, ".mendcode", "auth", `${providerID}.json`)
}

function globalProviderAuthStateFile(providerID: string) {
  return path.join(Global.Path.config, "auth", `${providerID}.json`)
}

export function providerAuthStateFile(root: string, providerID: string) {
  return globalProviderAuthStateFile(providerID) || projectProviderAuthStateFile(root, providerID)
}

function projectLegacyAuthStateFile(root: string) {
  return path.join(root, ".mendcode", "data", "auth.json")
}

function globalLegacyAuthStateFile() {
  return path.join(Global.Path.data, "auth.json")
}

async function readLegacyProviderAuthStateFromFile(file: string, providerID: string) {
  const state = await readJsonIfExists(file, null)
  if (!state || typeof state !== "object") return null
  const providerState = state[providerID]
  if (!providerState || typeof providerState !== "object") return null
  return providerState
}

export async function readProviderAuthState(root: string, providerID: string) {
  for (const file of [
    globalProviderAuthStateFile(providerID),
    projectProviderAuthStateFile(root, providerID),
  ]) {
    const modern = await readJsonIfExists(file, null)
    if (modern) return modern
  }

  for (const file of [globalLegacyAuthStateFile(), projectLegacyAuthStateFile(root)]) {
    const legacy = await readLegacyProviderAuthStateFromFile(file, providerID)
    if (legacy) return legacy
  }

  return null
}

export async function repairProviderAuthState(root: string, providerID: string, options: { preferProject?: boolean } = {}) {
  const modernFile = options.preferProject ? projectProviderAuthStateFile(root, providerID) : globalProviderAuthStateFile(providerID)
  const modern = await readJsonIfExists(modernFile, null)
  if (modern) return { status: "present", file: modernFile }
  const legacy =
    (await readLegacyProviderAuthStateFromFile(globalLegacyAuthStateFile(), providerID)) ||
    (await readLegacyProviderAuthStateFromFile(projectLegacyAuthStateFile(root), providerID))
  if (!legacy) return { status: "missing", file: modernFile }
  await mkdir(path.dirname(modernFile), { recursive: true })
  await writeFile(modernFile, `${JSON.stringify({ providerID, source: "legacy-auth-json-repair", ...legacy }, null, 2)}\n`, {
    mode: 0o600,
  })
  return { status: "repaired", file: modernFile }
}
