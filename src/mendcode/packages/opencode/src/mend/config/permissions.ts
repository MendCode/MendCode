import { mkdir, readFile, writeFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { Global } from "@mendcode/core/global"

export type PermissionMode = "approval" | "smart" | "full_access"

export type PermissionsConfig = {
  version: 0
  mode: PermissionMode
  reviewerRole: string
  trigger: "dangerous-shell"
}

export const defaultPermissionsConfig: PermissionsConfig = {
  version: 0,
  mode: "approval",
  reviewerRole: "permissionReviewer",
  trigger: "dangerous-shell",
}

export function globalPermissionsConfigPath(configDir = Global.Path.config) {
  return path.join(configDir, "permissions.json")
}

function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === "smart" || value === "full_access") return value
  return "approval"
}

function normalizePermissionsConfig(input: unknown): PermissionsConfig {
  if (!input || typeof input !== "object") return { ...defaultPermissionsConfig }
  const record = input as Record<string, unknown>
  return {
    version: 0,
    mode: normalizePermissionMode(record.mode),
    reviewerRole: typeof record.reviewerRole === "string" && record.reviewerRole.trim()
      ? record.reviewerRole.trim()
      : defaultPermissionsConfig.reviewerRole,
    trigger: "dangerous-shell",
  }
}

export async function readPermissionsConfig(configDir?: string): Promise<PermissionsConfig> {
  const file = globalPermissionsConfigPath(configDir)
  if (!existsSync(file)) return { ...defaultPermissionsConfig }
  return normalizePermissionsConfig(JSON.parse(await readFile(file, "utf8")))
}

export async function writePermissionsConfig(config: Partial<PermissionsConfig>, configDir?: string) {
  const file = globalPermissionsConfigPath(configDir)
  const current = await readPermissionsConfig(configDir)
  const next = normalizePermissionsConfig({ ...current, ...config })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
  return { path: file, config: next }
}
