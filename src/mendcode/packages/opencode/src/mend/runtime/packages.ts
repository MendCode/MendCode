import { existsSync } from "fs"
import { cp, mkdir, readFile, readdir, rm } from "fs/promises"
import path from "path"
import { mergeDeep } from "remeda"
import { ConfigAgent } from "@/config/agent"
import { ConfigCommand } from "@/config/command"
import { ConfigPlugin } from "@/config/plugin"
import type { ConfigMCP } from "@/config/mcp"
import { mendPaths } from "../config/paths"
import { readMendMcpConfigFromDir } from "../config/mcp"
import { safeRegistryID, writeJson } from "./registry/state"
import { isApplyAllowed } from "./registry/trust"
import type { RegistryMarketplacePackManifest } from "./registry/marketplace"
import type { RuntimePack, RuntimePackSource } from "./pack"
import type { RuntimeRegistryEntry } from "./registry/types"

export type InstalledMendPackage = {
  id: string
  enabled: boolean
  source: RuntimeRegistryEntry["id"]
  sourceType: RuntimePackSource["type"]
  trust: RuntimeRegistryEntry["trust"]
  url: string | null
  installedAt: string
  updatedAt: string
  digest: { algorithm: "sha256"; value: string }
  root: string
  title?: string
  description?: string
  channel?: string
  version?: string
  copied: string[]
  skipped: string[]
}

export type MendPackageState = {
  version: 0
  active: string[]
  installed: Record<string, InstalledMendPackage>
}

export type MendPackageProjection = {
  command: Record<string, ConfigCommand.Info>
  agent: Record<string, ConfigAgent.Info>
  plugin: ConfigPlugin.Spec[]
  mcp: Record<string, ConfigMCP.Info>
  skills: { paths: string[] }
  packages: InstalledMendPackage[]
  runtimePacks: RuntimePack[]
  warnings: string[]
}

const emptyState: MendPackageState = { version: 0, active: [], installed: {} }

async function readJsonIfExists<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function listFilesRecursive(root: string) {
  const out: string[] = []
  async function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out.sort()
}

function relativeFromRoot(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join(path.posix.sep)
}

function normalizeRel(file: string) {
  return file.split(path.sep).join(path.posix.sep).replace(/^\.\//, "")
}

function packFileAllowlist(pack: RuntimePack | null | undefined) {
  if (!pack) return null
  const allowed = new Set<string>([
    "mend-package.json",
    ".mendcode/package.json",
    ".mendcode/runtime-pack.json",
  ])
  const add = (file: string | undefined | null) => {
    if (!file) return
    allowed.add(normalizeRel(file))
  }
  for (const file of pack.commands || []) add(file)
  for (const file of pack.agents || []) add(file)
  for (const file of pack.modes || []) add(file)
  for (const file of pack.skills || []) add(file)
  for (const file of pack.plugins || []) add(file)
  for (const file of pack.prompts?.templates || []) add(file)
  for (const file of pack.mcp?.files || []) add(file)
  for (const file of pack.context?.include || []) add(file)
  for (const file of pack.extensions || []) add(file)
  if (pack.models.default.providerID || pack.models.default.modelID || Object.keys(pack.models.roles).length) {
    add(".mendcode/models.yaml")
  }
  if (pack.focus.default !== "codex" || Object.keys(pack.budget).length || Object.keys(pack.worktree).length) {
    add(".mendcode/mendcode.json")
  }
  if (Object.keys(pack.tui).length) add(".mendcode/tui/profile.json")
  if (Object.keys(pack.worktree).length) add(".mendcode/worktree/policy.yaml")
  return allowed
}

export function installedMendPackageRoot(root: string, id: string) {
  return path.join(mendPaths(root).packageInstalledDir, safeRegistryID(id))
}

export async function readMendPackageState(root = mendPaths().root): Promise<MendPackageState> {
  const state = await readJsonIfExists<MendPackageState>(mendPaths(root).packageState, emptyState)
  const installed = Object.fromEntries(
    Object.entries(state.installed || {}).map(([id, item]) => [
      id,
      {
        ...item,
        id,
        enabled: state.active.includes(id) && item.enabled !== false,
        root: item.root || path.relative(root, installedMendPackageRoot(root, id)),
      },
    ]),
  )
  const active = (state.active || []).filter((id) => installed[id])
  return { version: 0, active, installed }
}

export async function writeMendPackageState(root: string, state: MendPackageState) {
  const active = state.active.filter((id, index, list) => state.installed[id] && list.indexOf(id) === index)
  await writeJson(mendPaths(root).packageState, {
    version: 0,
    active,
    installed: Object.fromEntries(
      Object.entries(state.installed).map(([id, item]) => [id, { ...item, enabled: active.includes(id) }]),
    ),
  })
}

export async function listMendPackages(root = mendPaths().root) {
  const state = await readMendPackageState(root)
  const packages = Object.values(state.installed).toSorted((a, b) => a.id.localeCompare(b.id))
  return {
    ok: true,
    path: path.relative(root, mendPaths(root).packageState),
    active: state.active,
    installed: packages,
    enabled: packages.filter((item) => item.enabled),
    secretsIncluded: false,
  }
}

export async function setMendPackageEnabled(id: string | undefined, enabled: boolean, root = mendPaths().root) {
  if (!id) throw new Error(`Usage: mend packages ${enabled ? "enable" : "disable"} <id>`)
  const state = await readMendPackageState(root)
  const current = state.installed[id]
  if (!current) throw new Error(`Unknown MendCode package: ${id}`)
  current.enabled = enabled
  state.active = enabled
    ? [...state.active.filter((item) => item !== id), id]
    : state.active.filter((item) => item !== id)
  await writeMendPackageState(root, state)
  return { ok: true, action: enabled ? "enable" : "disable", id, active: state.active, secretsIncluded: false }
}

export async function disableAllMendPackages(root = mendPaths().root) {
  const state = await readMendPackageState(root)
  for (const item of Object.values(state.installed)) item.enabled = false
  state.active = []
  await writeMendPackageState(root, state)
  return { ok: true, action: "disable-all", active: [], secretsIncluded: false }
}

export async function removeMendPackage(id: string | undefined, root = mendPaths().root) {
  if (!id) throw new Error("Usage: mend packages remove <id>")
  const state = await readMendPackageState(root)
  const current = state.installed[id]
  if (!current) return { ok: false, action: "remove", id, active: state.active, secretsIncluded: false }
  delete state.installed[id]
  state.active = state.active.filter((item) => item !== id)
  await rm(installedMendPackageRoot(root, id), { recursive: true, force: true })
  await writeMendPackageState(root, state)
  return { ok: true, action: "remove", id, active: state.active, secretsIncluded: false }
}

export async function installMendPackageFromStage(input: {
  entry: RuntimeRegistryEntry
  stageDir: string
  digest: { algorithm: "sha256"; value: string }
  selectedPack: RegistryMarketplacePackManifest | null
  pack?: RuntimePack | null
  root?: string
}) {
  const root = mendPaths(input.root).root
  const id = input.selectedPack?.id || input.entry.id
  const targetRoot = installedMendPackageRoot(root, id)
  const copied: string[] = []
  const skipped: string[] = []
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })
  const allowlist = packFileAllowlist(input.pack)

  for (const file of await listFilesRecursive(input.stageDir)) {
    const rel = relativeFromRoot(input.stageDir, file)
    const normalizedRel = normalizeRel(rel)
    if (!isApplyAllowed(normalizedRel) || (allowlist && !allowlist.has(normalizedRel))) {
      skipped.push(rel)
      continue
    }
    const target = path.join(targetRoot, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(file, target)
    copied.push(rel)
  }

  const now = new Date().toISOString()
  const state = await readMendPackageState(root)
  const existing = state.installed[id]
  const installed: InstalledMendPackage = {
    id,
    enabled: true,
    source: input.entry.id,
    sourceType: input.entry.type,
    trust: input.entry.trust,
    url: input.entry.url,
    installedAt: existing?.installedAt || now,
    updatedAt: now,
    digest: { algorithm: "sha256", value: input.digest.value },
    root: path.relative(root, targetRoot).split(path.sep).join(path.posix.sep),
    ...(input.selectedPack?.title ? { title: input.selectedPack.title } : {}),
    ...(input.selectedPack?.description ? { description: input.selectedPack.description } : {}),
    ...(input.selectedPack?.channel ? { channel: input.selectedPack.channel } : {}),
    ...(input.selectedPack?.version ? { version: input.selectedPack.version } : {}),
    copied,
    skipped,
  }
  state.installed[id] = installed
  state.active = [...state.active.filter((item) => item !== id), id]
  await writeMendPackageState(root, state)
  return installed
}

export async function activeMendPackageProjection(root = mendPaths().root): Promise<MendPackageProjection> {
  const state = await readMendPackageState(root)
  const projection: MendPackageProjection = {
    command: {},
    agent: {},
    plugin: [],
    mcp: {},
    skills: { paths: [] },
    packages: [],
    runtimePacks: [],
    warnings: [],
  }

  for (const id of state.active) {
    const item = state.installed[id]
    if (!item || item.enabled === false) continue
    const packageRoot = installedMendPackageRoot(root, id)
    const packageMendDir = path.join(packageRoot, ".mendcode")
    const runtimePackFile = path.join(packageMendDir, "runtime-pack.json")
    if (existsSync(runtimePackFile)) {
      try {
        projection.runtimePacks.push(JSON.parse(await readFile(runtimePackFile, "utf8")) as RuntimePack)
      } catch (error) {
        projection.warnings.push(`${id}: invalid runtime-pack.json: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!existsSync(packageMendDir)) {
      projection.warnings.push(`Package ${id} has no .mendcode directory; skipped`)
      continue
    }

    projection.command = mergeDeep(projection.command, await ConfigCommand.load(packageMendDir)) as typeof projection.command
    projection.agent = mergeDeep(projection.agent, await ConfigAgent.load(packageMendDir)) as typeof projection.agent
    projection.agent = mergeDeep(projection.agent, await ConfigAgent.loadMode(packageMendDir)) as typeof projection.agent
    projection.plugin.push(...await ConfigPlugin.load(packageMendDir))
    projection.skills.paths.push(packageMendDir)

    const mcp = await readMendMcpConfigFromDir(packageRoot, path.join(packageMendDir, "mcp"))
    projection.warnings.push(...mcp.warnings.map((warning) => `${id}: ${warning}`))
    if (mcp.failures.length) {
      projection.warnings.push(...mcp.failures.map((failure) => `${id}: ${failure}`))
    } else {
      projection.mcp = mergeDeep(projection.mcp, mcp.servers) as typeof projection.mcp
    }
    projection.packages.push(item)
  }

  projection.plugin = ConfigPlugin.deduplicatePluginOrigins(
    projection.plugin.map((spec) => ({ spec, source: mendPaths(root).packageState, scope: "local" })),
  ).map((origin) => origin.spec)
  projection.skills.paths = Array.from(new Set(projection.skills.paths))
  return projection
}
