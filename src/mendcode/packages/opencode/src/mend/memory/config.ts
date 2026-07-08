import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import { readMendConfig } from "../config/project"
import { mendPaths } from "../config/paths"
import { activeMendPackageProjection } from "../runtime/packages"

export type MemoryScope = "global" | "project"

export type MemoryDreamWindow = {
  enabled: boolean
  start: string
  end: string
  timezone?: string
}

export type GeneratedMemoryWritePolicy = "pending" | "auto-safe" | "model-decides" | "disabled"
export type MemoryDreamWritePolicy = GeneratedMemoryWritePolicy

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
  dreamWindow: MemoryDreamWindow | null
  memoryWritePolicy: GeneratedMemoryWritePolicy
  memoryAutoApplyMinConfidence: number
  memoryAutoApplyMinDurability: number
  memoryAutoApplyMaxChangeRisk: number
  memoryAutoApplyAllowedCategories: string[]
  memoryAutoApplyBlockedSensitivity: Array<"medium" | "high">
  dreamWritePolicy: MemoryDreamWritePolicy
  dreamAutoApplyMinConfidence: number
  dreamAutoApplyMinDurability: number
  dreamAutoApplyMaxChangeRisk: number
  dreamAutoApplyAllowedCategories: string[]
  dreamAutoApplyBlockedSensitivity: Array<"medium" | "high">
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
  dreamWindow: null,
  memoryWritePolicy: "pending",
  memoryAutoApplyMinConfidence: 0.9,
  memoryAutoApplyMinDurability: 0.85,
  memoryAutoApplyMaxChangeRisk: 0.2,
  memoryAutoApplyAllowedCategories: ["project.commands", "project.stack", "user.preferences", "agent.policy", "memory.policy"],
  memoryAutoApplyBlockedSensitivity: ["medium", "high"],
  dreamWritePolicy: "pending",
  dreamAutoApplyMinConfidence: 0.9,
  dreamAutoApplyMinDurability: 0.85,
  dreamAutoApplyMaxChangeRisk: 0.2,
  dreamAutoApplyAllowedCategories: ["project.commands", "project.stack", "agent.policy", "memory.policy"],
  dreamAutoApplyBlockedSensitivity: ["medium", "high"],
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

function generatedMemoryWritePolicy(value: unknown, fallback: GeneratedMemoryWritePolicy): GeneratedMemoryWritePolicy {
  return value === "pending" || value === "auto-safe" || value === "model-decides" || value === "disabled" ? value : fallback
}

function stringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
  return out.length ? [...new Set(out)] : fallback
}

function blockedSensitivity(value: unknown, fallback: Array<"medium" | "high">) {
  if (!Array.isArray(value)) return fallback
  const out = value.filter((item): item is "medium" | "high" => item === "medium" || item === "high")
  return out.length ? [...new Set(out)] : fallback
}

function roleValue(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback
  return value === "summary" ? fallback : value
}

function timeValue(value: unknown) {
  if (typeof value !== "string") return undefined
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return `${String(hour).padStart(2, "0")}:${match[2]}`
}

function dreamWindow(value: unknown, fallback: MemoryDreamWindow | null) {
  if (value === null) return null
  if (typeof value !== "object" || value === null) return fallback
  const raw = value as Record<string, unknown>
  const start = timeValue(raw.start)
  const end = timeValue(raw.end)
  if (!start || !end) return fallback
  return {
    enabled: bool(raw.enabled, true),
    start,
    end,
    ...(typeof raw.timezone === "string" && raw.timezone.trim() ? { timezone: raw.timezone.trim() } : {}),
  }
}

export function globalMemoryDir() {
  if (process.env.MENDCODE_MEMORY_DIR) return process.env.MENDCODE_MEMORY_DIR
  return path.join(Global.Path.data, "memory")
}

function isFilesystemRoot(input: string) {
  return path.resolve(input) === path.parse(path.resolve(input)).root
}

export function resolveProjectMemoryRoot(root?: string | null, cwd?: string | null) {
  for (const candidate of [root, cwd]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue
    const resolved = path.resolve(candidate)
    if (!isFilesystemRoot(resolved)) return resolved
  }
  return undefined
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
    dreamWindow: dreamWindow(raw.dreamWindow, defaultMemoryConfig.dreamWindow),
    memoryWritePolicy: generatedMemoryWritePolicy(raw.memoryWritePolicy, defaultMemoryConfig.memoryWritePolicy),
    memoryAutoApplyMinConfidence: boundedNumberValue(raw.memoryAutoApplyMinConfidence, defaultMemoryConfig.memoryAutoApplyMinConfidence, 0, 1),
    memoryAutoApplyMinDurability: boundedNumberValue(raw.memoryAutoApplyMinDurability, defaultMemoryConfig.memoryAutoApplyMinDurability, 0, 1),
    memoryAutoApplyMaxChangeRisk: boundedNumberValue(raw.memoryAutoApplyMaxChangeRisk, defaultMemoryConfig.memoryAutoApplyMaxChangeRisk, 0, 1),
    memoryAutoApplyAllowedCategories: stringList(raw.memoryAutoApplyAllowedCategories, defaultMemoryConfig.memoryAutoApplyAllowedCategories),
    memoryAutoApplyBlockedSensitivity: blockedSensitivity(raw.memoryAutoApplyBlockedSensitivity, defaultMemoryConfig.memoryAutoApplyBlockedSensitivity),
    dreamWritePolicy: generatedMemoryWritePolicy(raw.dreamWritePolicy, defaultMemoryConfig.dreamWritePolicy),
    dreamAutoApplyMinConfidence: boundedNumberValue(raw.dreamAutoApplyMinConfidence, defaultMemoryConfig.dreamAutoApplyMinConfidence, 0, 1),
    dreamAutoApplyMinDurability: boundedNumberValue(raw.dreamAutoApplyMinDurability, defaultMemoryConfig.dreamAutoApplyMinDurability, 0, 1),
    dreamAutoApplyMaxChangeRisk: boundedNumberValue(raw.dreamAutoApplyMaxChangeRisk, defaultMemoryConfig.dreamAutoApplyMaxChangeRisk, 0, 1),
    dreamAutoApplyAllowedCategories: stringList(raw.dreamAutoApplyAllowedCategories, defaultMemoryConfig.dreamAutoApplyAllowedCategories),
    dreamAutoApplyBlockedSensitivity: blockedSensitivity(raw.dreamAutoApplyBlockedSensitivity, defaultMemoryConfig.dreamAutoApplyBlockedSensitivity),
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

export async function readGlobalMemoryConfig(): Promise<MemoryConfig> {
  const paths = memoryPaths()
  const globalConfig = await readJsonIfExists(paths.globalConfig).catch(() => null)
  return normalizeMemoryConfig({
    ...defaultMemoryConfig,
    ...(globalConfig || {}),
    configScope: "global",
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
  const current = await readGlobalMemoryConfig()
  const next = normalizeMemoryConfig({ ...current, ...config, configScope: "global" })
  await mkdir(path.dirname(paths.globalConfig), { recursive: true })
  await writeFile(paths.globalConfig, `${JSON.stringify(next, null, 2)}\n`)
  return { path: paths.globalConfig, config: next }
}
