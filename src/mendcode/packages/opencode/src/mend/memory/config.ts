import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import { readMendConfig } from "../config/project"
import { mendPaths } from "../config/paths"
import { activeMendPackageProjection } from "../runtime/packages"

export type MemoryScope = "global" | "project"

export type MemoryConfig = {
  version: 0
  configScope: "global" | "project"
  enabled: boolean
  use: boolean
  generate: boolean
  scopes: MemoryScope[]
  maxPromptTokens: number
  maxEntries: number
  projectMaxEntries: number
  globalCompactionMaxEntries: number
  extractorRole: string
  consolidatorRole: string
  memoryDreamRole: string
  memoryAssistantRole: string
  minIdleMinutes: number
  minBudgetRemainingUsd: number | null
  requireApprovalForGenerated: boolean
  allowCodexImport: boolean
}

export const defaultMemoryConfig: MemoryConfig = {
  version: 0,
  configScope: "global",
  enabled: false,
  use: false,
  generate: false,
  scopes: ["global", "project"],
  maxPromptTokens: 10_000,
  maxEntries: 50,
  projectMaxEntries: 3,
  globalCompactionMaxEntries: 50,
  extractorRole: "memoryExtractor",
  consolidatorRole: "none",
  memoryDreamRole: "memoryDream",
  memoryAssistantRole: "memoryAssistant",
  minIdleMinutes: 30,
  minBudgetRemainingUsd: 0.25,
  requireApprovalForGenerated: true,
  allowCodexImport: false,
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function numberValue(value: unknown, fallback: number, min: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function boundedNumberValue(value: unknown, fallback: number, min: number, max: number) {
  const normalized = numberValue(value, fallback, min)
  return Math.min(max, normalized)
}

function nullableNumber(value: unknown, fallback: number | null, min: number) {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function scopes(value: unknown): MemoryScope[] {
  if (!Array.isArray(value)) return defaultMemoryConfig.scopes
  const out = value.filter((item): item is MemoryScope => item === "global" || item === "project")
  return out.length ? [...new Set(out)] : defaultMemoryConfig.scopes
}

function roleValue(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback
  return value === "summary" ? fallback : value
}

export function globalMemoryDir() {
  if (process.env.MENDCODE_MEMORY_DIR) return process.env.MENDCODE_MEMORY_DIR
  return path.join(Global.Path.data, "memory")
}

export function memoryPaths(root?: string) {
  const project = mendPaths(root)
  const globalDir = globalMemoryDir()
  return {
    root: project.root,
    projectDir: project.memoryDir,
    projectConfig: project.memoryConfig,
    projectSummary: project.memorySummary,
    projectEntries: project.memoryEntries,
    projectIndex: project.memoryIndex,
    globalDir,
    globalConfig: path.join(globalDir, "config.json"),
    globalSummary: path.join(globalDir, "memory_summary.md"),
    globalEntries: path.join(globalDir, "entries.jsonl"),
    globalIndex: path.join(globalDir, "index.json"),
    proposalsDir: path.join(project.memoryDir, "proposals"),
  }
}

export function normalizeMemoryConfig(input: unknown): MemoryConfig {
  const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
  return {
    version: 0,
    configScope: raw.configScope === "project" ? "project" : "global",
    enabled: bool(raw.enabled, defaultMemoryConfig.enabled),
    use: bool(raw.use, defaultMemoryConfig.use),
    generate: bool(raw.generate, defaultMemoryConfig.generate),
    scopes: scopes(raw.scopes),
    maxPromptTokens: boundedNumberValue(raw.maxPromptTokens, defaultMemoryConfig.maxPromptTokens, 100, 10_000),
    maxEntries: boundedNumberValue(raw.maxEntries, defaultMemoryConfig.maxEntries, 1, 100),
    projectMaxEntries: boundedNumberValue(raw.projectMaxEntries, defaultMemoryConfig.projectMaxEntries, 1, 100),
    globalCompactionMaxEntries: boundedNumberValue(raw.globalCompactionMaxEntries, defaultMemoryConfig.globalCompactionMaxEntries, 1, 100),
    extractorRole: roleValue(raw.extractorRole, defaultMemoryConfig.extractorRole),
    consolidatorRole: roleValue(raw.consolidatorRole, defaultMemoryConfig.consolidatorRole),
    memoryDreamRole: roleValue(raw.memoryDreamRole, defaultMemoryConfig.memoryDreamRole),
    memoryAssistantRole: roleValue(raw.memoryAssistantRole, defaultMemoryConfig.memoryAssistantRole),
    minIdleMinutes: numberValue(raw.minIdleMinutes, defaultMemoryConfig.minIdleMinutes, 0),
    minBudgetRemainingUsd: nullableNumber(raw.minBudgetRemainingUsd, defaultMemoryConfig.minBudgetRemainingUsd, 0),
    requireApprovalForGenerated: bool(raw.requireApprovalForGenerated, defaultMemoryConfig.requireApprovalForGenerated),
    allowCodexImport: bool(raw.allowCodexImport, defaultMemoryConfig.allowCodexImport),
  }
}

async function readJsonIfExists(file: string) {
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, "utf8"))
}

export async function readMemoryConfig(root?: string): Promise<MemoryConfig> {
  const paths = memoryPaths(root)
  const cfg = readMendConfig(paths.root)
  const globalConfig = await readJsonIfExists(paths.globalConfig).catch(() => null)
  const projectConfig = await readJsonIfExists(paths.projectConfig).catch(() => null)
  const explicitProjectConfig = typeof projectConfig === "object" && projectConfig !== null && (projectConfig as Record<string, unknown>).configScope === "project"
  const projected = await activeMendPackageProjection(paths.root).catch(() => undefined)
  const packageMemoryConfig = projected?.runtimePacks.reduce<Record<string, unknown>>((acc, pack) => ({
    ...acc,
    ...(pack.settings?.memory || {}),
  }), {})
  return normalizeMemoryConfig({
    ...defaultMemoryConfig,
    ...(cfg.memory || {}),
    ...(globalConfig || {}),
    ...(explicitProjectConfig ? projectConfig : {}),
    ...(packageMemoryConfig || {}),
  })
}

export async function writeProjectMemoryConfig(config: Partial<MemoryConfig>, root?: string) {
  const paths = memoryPaths(root)
  const current = await readMemoryConfig(paths.root)
  const next = normalizeMemoryConfig({ ...current, ...config, configScope: "project" })
  await mkdir(path.dirname(paths.projectConfig), { recursive: true })
  await writeFile(paths.projectConfig, `${JSON.stringify(next, null, 2)}\n`)
  return { path: path.relative(paths.root, paths.projectConfig), config: next }
}

export async function writeGlobalMemoryConfig(config: Partial<MemoryConfig>, root?: string) {
  const paths = memoryPaths(root)
  const current = await readMemoryConfig(paths.root)
  const next = normalizeMemoryConfig({ ...current, ...config, configScope: "global" })
  await mkdir(path.dirname(paths.globalConfig), { recursive: true })
  await writeFile(paths.globalConfig, `${JSON.stringify(next, null, 2)}\n`)
  return { path: paths.globalConfig, config: next }
}
