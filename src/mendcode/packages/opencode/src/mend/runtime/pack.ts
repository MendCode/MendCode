import { existsSync } from "fs"
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { Glob } from "@mendcode/core/util/glob"
import { mendPaths } from "../config/paths"
import type { MendPackageManifest } from "../sdk/package"
import { packageMetadata, packageMetadataSet } from "../config/project"
import { readModelsConfig } from "../config/models"
import { readMendMcpConfig, readMendMcpConfigFromDir } from "../config/mcp"
import { readPromptMode } from "../prompt/mode"
import { resolvePromptFocusForRole } from "../prompt/focus-resolver"
import { readActiveTuiProfile } from "../tui/profile-actions"
import { readMemoryConfig } from "../memory/config"
import { readPermissionsConfig } from "../config/permissions"
import { applyRuntimePackAdapters, runtimePackAdapterPreview, type RuntimePackAdapterChange, type RuntimePackApplyResult } from "./apply"

export type RuntimePackSource = {
  type: "local" | "github" | "private-git" | "team" | "opencode-settings"
  url: string | null
}

export type RuntimePack = {
  id: string
  version: 0
  source: RuntimePackSource
  models: {
    default: { providerID: string | null; modelID: string | null; authMode: string | null }
    roles: Record<string, { providerID: string | null; modelID: string | null; authMode?: string | null }>
  }
  focus: { default: string; resolved: ReturnType<typeof resolvePromptFocusForRole> }
  commands: string[]
  agents: string[]
  modes: string[]
  skills: string[]
  plugins: string[]
  mcp: {
    config: Record<string, unknown>
    files: string[]
  }
  prompts: { mode: string; resolver: "provider-model-aware"; templates: string[] }
  context: { include: string[]; refresh: "deterministic" }
  extensions: string[]
  settings: {
    memory: Record<string, unknown>
    permissions: Record<string, unknown>
  }
  budget: Record<string, unknown>
  tui: Record<string, unknown>
  worktree: Record<string, unknown>
}

export type RuntimePackSelection = {
  commands?: string[]
  agents?: string[]
  modes?: string[]
  skills?: string[]
  plugins?: string[]
  prompts?: string[]
  mcp?: string[]
  context?: string[]
  extensions?: string[]
  tuiProfile?: boolean
  worktreePolicy?: boolean
  models?: boolean
  focus?: boolean
  budget?: boolean
  memory?: boolean
  permissions?: boolean
}

export type RuntimePackArtifactCandidates = {
  commands: string[]
  agents: string[]
  modes: string[]
  skills: string[]
  plugins: string[]
  prompts: string[]
  mcp: string[]
  context: string[]
  extensions: string[]
  tuiProfile: string | null
  worktreePolicy: string | null
}

export type RuntimePackPlan = {
  action: "status" | "preview" | "apply" | "rollback"
  root: string
  packPath: string
  packageManifestPath: string
  backupPath: string | null
  manifestPath: string | null
  pack: RuntimePack
  packageManifest: MendPackageManifest
  changes: Array<{ target: string; action: "write" | "replace" | "noop"; reason: string }>
  subsystemChanges: RuntimePackAdapterChange[]
  subsystemResults?: RuntimePackApplyResult[]
  secretsIncluded: false
  marketplace: { implemented: false; plannedSources: RuntimePackSource["type"][] }
  teams: { implemented: false; sharedConfigOnly: true; localSecretsExcluded: true }
  rollbackAvailable: boolean
}

async function readJsonIfExists(file: string) {
  if (!existsSync(file)) return {}
  return JSON.parse(await readFile(file, "utf8"))
}

async function listFiles(dir: string, suffix?: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix))).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

async function listPackFiles(root: string, pattern: string) {
  const mendDir = path.join(root, ".mendcode")
  if (!existsSync(mendDir)) return []
  const matches = await Glob.scan(pattern, {
    cwd: mendDir,
    absolute: false,
    dot: true,
    symlink: true,
  })
  return matches
    .map((match) => path.posix.join(".mendcode", match.split(path.sep).join(path.posix.sep)))
    .sort()
}

function selectedFiles(all: string[], selected: string[] | undefined) {
  if (!selected) return all
  const allowed = new Set(selected.map((file) => file.split(path.sep).join(path.posix.sep)))
  return all.filter((file) => allowed.has(file))
}

function packageSelection(root: string): RuntimePackSelection {
  const metadata = packageMetadata(root)
  return metadata.selection && typeof metadata.selection === "object" ? metadata.selection as RuntimePackSelection : {}
}

export async function runtimePackArtifactCandidates(root?: string): Promise<RuntimePackArtifactCandidates> {
  const paths = mendPaths(root)
  const mcp = await readMendMcpConfig(paths.root)
  return {
    commands: await listPackFiles(paths.root, "{command,commands}/**/*.md"),
    agents: await listPackFiles(paths.root, "{agent,agents}/**/*.md"),
    modes: await listPackFiles(paths.root, "{mode,modes}/**/*.md"),
    skills: await listPackFiles(paths.root, "{skill,skills}/**/SKILL.md"),
    plugins: await listPackFiles(paths.root, "{plugin,plugins}/**/*.{ts,js}"),
    prompts: await listPackFiles(paths.root, "{prompt,prompts}/**/*.md"),
    mcp: mcp.files.map((file) => file.split(path.sep).join(path.posix.sep)),
    context: [
      ".mendcode/context/project.md",
      ".mendcode/context/summary.md",
      ".mendcode/context/refresh.json",
    ].filter((file) => existsSync(path.join(paths.root, file))),
    extensions: await listPackFiles(paths.root, "{widget,widgets,component,components,script,scripts}/**/*"),
    tuiProfile: existsSync(paths.tuiProfile) ? ".mendcode/tui/profile.json" : null,
    worktreePolicy: existsSync(path.join(paths.root, ".mendcode", "worktree", "policy.yaml"))
      ? ".mendcode/worktree/policy.yaml"
      : null,
  }
}

function packFile(root: string) {
  return path.join(root, ".mendcode", "runtime-pack.json")
}

function mendPackageManifestFile(root: string) {
  return path.join(root, "mend-package.json")
}

function runtimePackStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "")
}

function backupFile(root: string) {
  const stamp = runtimePackStamp()
  return path.join(root, ".mendcode", "runtime-pack.backups", `${stamp}.json`)
}

function runtimePackManifestFile(root: string, action: "apply" | "rollback") {
  const stamp = runtimePackStamp()
  return path.join(root, ".mendcode", "runs", `runtime-pack-${action}-${stamp}.json`)
}

async function readRuntimeVersion(root: string) {
  const packageFile = path.join(root, "src", "mendcode", "packages", "opencode", "package.json")
  const fallbackPackageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json")
  const target = existsSync(packageFile) ? packageFile : fallbackPackageFile
  const value = JSON.parse(await readFile(target, "utf8")) as { version?: string }
  return value.version || "0.0.0"
}

function inferPackageKind(pack: RuntimePack): MendPackageManifest["kind"] {
  if (pack.skills.length && !pack.commands.length && !pack.agents.length && !pack.modes.length) return "skill-pack"
  if (pack.prompts.templates.length && !pack.skills.length && !pack.commands.length) return "prompt-pack"
  if (pack.tui && Object.keys(pack.tui).length && !pack.commands.length && !pack.skills.length) return "theme"
  return "bundle"
}

export async function buildLocalMendPackageManifest(root?: string, pack?: RuntimePack): Promise<MendPackageManifest> {
  const paths = mendPaths(root)
  const resolvedPack = pack || await buildLocalRuntimePack(paths.root)
  const runtimeVersion = await readRuntimeVersion(paths.root)
  const metadata = packageMetadata(paths.root)
  return {
    version: 0,
    id: metadata.id || resolvedPack.id,
    packageVersion: metadata.version,
    ...(metadata.title ? { title: metadata.title } : { title: "MendCode Local Runtime Pack" }),
    ...(metadata.description ? { description: metadata.description } : { description: "Local-first MendCode package manifest generated from shareable project configuration." }),
    kind: metadata.kind || inferPackageKind(resolvedPack),
    channel: metadata.channel || "local",
    compatibility: {
      mendcode: metadata.compatibility.mendcode || `^${runtimeVersion}`,
      runtimePack: metadata.compatibility.runtimePack || "^0",
    },
    artifacts: {
      ...(resolvedPack.commands.length ? { commands: resolvedPack.commands } : {}),
      ...(resolvedPack.agents.length ? { agents: resolvedPack.agents } : {}),
      ...(resolvedPack.modes.length ? { modes: resolvedPack.modes } : {}),
      ...(resolvedPack.skills.length ? { skills: resolvedPack.skills } : {}),
      ...(resolvedPack.plugins.length ? { plugins: resolvedPack.plugins } : {}),
      ...(resolvedPack.prompts.templates.length ? { prompts: resolvedPack.prompts.templates } : {}),
      ...(resolvedPack.mcp.files.length ? { mcp: resolvedPack.mcp.files } : {}),
      ...(resolvedPack.context.include.length ? { context: resolvedPack.context.include } : {}),
      ...(resolvedPack.extensions.length ? { extensions: resolvedPack.extensions } : {}),
      ...(Object.keys(resolvedPack.tui).length ? { tuiProfile: ".mendcode/tui/profile.json" } : {}),
      ...(Object.keys(resolvedPack.worktree).length ? { worktreePolicy: ".mendcode/worktree/policy.yaml" } : {}),
    },
    distribution: {
      source: {
        type: metadata.source.type || resolvedPack.source.type,
        url: metadata.source.url ?? resolvedPack.source.url,
      },
      trust: {
        signatureRequired: false,
      },
    },
  }
}

export async function buildLocalRuntimePack(root?: string): Promise<RuntimePack> {
  const paths = mendPaths(root)
  const selection = packageSelection(paths.root)
  const [config, models, prompt, profile] = await Promise.all([
    readJsonIfExists(paths.mendConfig),
    readModelsConfig(paths.root),
    readPromptMode(paths.root),
    readActiveTuiProfile(paths.root),
  ])
  const [memory, permissions] = await Promise.all([
    readMemoryConfig(paths.root).catch(() => ({})),
    readPermissionsConfig().catch(() => ({})),
  ])
  const allMcp = await readMendMcpConfig(paths.root)
  const selectedMcpFiles = selectedFiles(allMcp.files.map((file) => file.split(path.sep).join(path.posix.sep)), selection.mcp)
  const mcp = await readMendMcpConfigFromDir(paths.root, paths.mcpDir, selectedMcpFiles)
  if (mcp.failures.length) throw new Error(`Invalid .mendcode/mcp config:\n${mcp.failures.join("\n")}`)
  const defaultRole = models.roles.default || { providerID: null, modelID: null, authMode: null }
  const focusDefault = config?.focus?.default || "codex"
  const commands = selectedFiles(await listPackFiles(paths.root, "{command,commands}/**/*.md"), selection.commands)
  const agents = selectedFiles(await listPackFiles(paths.root, "{agent,agents}/**/*.md"), selection.agents)
  const modes = selectedFiles(await listPackFiles(paths.root, "{mode,modes}/**/*.md"), selection.modes)
  const skills = selectedFiles(await listPackFiles(paths.root, "{skill,skills}/**/SKILL.md"), selection.skills)
  const plugins = selectedFiles(await listPackFiles(paths.root, "{plugin,plugins}/**/*.{ts,js}"), selection.plugins)
  const prompts = selectedFiles(await listPackFiles(paths.root, "{prompt,prompts}/**/*.md"), selection.prompts)
  const context = selectedFiles([
    ".mendcode/context/project.md",
    ".mendcode/context/summary.md",
    ".mendcode/context/refresh.json",
  ].filter((file) => existsSync(path.join(paths.root, file))), selection.context)
  const extensions = selectedFiles(
    await listPackFiles(paths.root, "{widget,widgets,component,components,script,scripts}/**/*"),
    selection.extensions,
  )
  return {
    id: "codex-local",
    version: 0,
    source: { type: "local", url: null },
    models: {
      default: {
        providerID: selection.models === false ? null : defaultRole.providerID || null,
        modelID: selection.models === false ? null : defaultRole.modelID || null,
        authMode: selection.models === false ? null : defaultRole.authMode || null,
      },
      roles: selection.models === false ? {} : models.roles,
    },
    focus: {
      default: selection.focus === false ? "codex" : focusDefault,
      resolved: resolvePromptFocusForRole(defaultRole),
    },
    commands,
    agents,
    modes,
    skills,
    plugins,
    mcp: {
      config: { ...(config?.mcp || {}), ...mcp.servers },
      files: mcp.files.map((file) => file.split(path.sep).join(path.posix.sep)),
    },
    prompts: {
      mode: prompt.mode,
      resolver: "provider-model-aware",
      templates: prompts,
    },
    context: {
      include: context,
      refresh: "deterministic",
    },
    extensions,
    settings: {
      memory: selection.memory === false ? {} : memory as Record<string, unknown>,
      permissions: selection.permissions === false ? {} : permissions as Record<string, unknown>,
    },
    budget: selection.budget === false ? {} : config?.budgets || {},
    tui: selection.tuiProfile === false ? {} : profile,
    worktree: selection.worktreePolicy === false ? {} : config?.worktree || {},
  }
}

export async function runtimePackPlan(action: RuntimePackPlan["action"], root?: string): Promise<RuntimePackPlan> {
  const paths = mendPaths(root)
  const target = packFile(paths.root)
  const packageTarget = mendPackageManifestFile(paths.root)
  const exists = existsSync(target)
  const pack = await buildLocalRuntimePack(paths.root)
  const packageManifest = await buildLocalMendPackageManifest(paths.root, pack)
  return {
    action,
    root: paths.root,
    packPath: path.relative(paths.root, target),
    packageManifestPath: path.relative(paths.root, packageTarget),
    backupPath: null,
    manifestPath: null,
    pack,
    packageManifest,
    changes: [
      {
        target: path.relative(paths.root, packageTarget),
        action: existsSync(packageTarget) ? "replace" : "write",
        reason: "Persist MendCode package metadata alongside runtime-pack for registry authoring and export flows.",
      },
      {
        target: path.relative(paths.root, target),
        action: action === "rollback" ? "replace" : exists ? "replace" : "write",
        reason: "Persist resolved local runtime pack without provider secrets or registry sync state.",
      },
      ...(action === "apply" || action === "rollback"
        ? [{
            target: path.relative(paths.root, runtimePackManifestFile(paths.root, action)),
            action: "write" as const,
            reason: "Record a local rollback/apply manifest under ignored runtime-pack runs.",
          }]
        : []),
    ],
    subsystemChanges: runtimePackAdapterPreview(pack),
    secretsIncluded: false,
    marketplace: { implemented: false, plannedSources: ["local", "github", "private-git", "team", "opencode-settings"] },
    teams: { implemented: false, sharedConfigOnly: true, localSecretsExcluded: true },
    rollbackAvailable: existsSync(path.join(paths.root, ".mendcode", "runtime-pack.backups")),
  }
}

export async function applyRuntimePack(root?: string) {
  const paths = mendPaths(root)
  const target = packFile(paths.root)
  const packageTarget = mendPackageManifestFile(paths.root)
  const backup = backupFile(paths.root)
  const manifest = runtimePackManifestFile(paths.root, "apply")
  const plan = await runtimePackPlan("apply", paths.root)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(packageTarget, `${JSON.stringify(plan.packageManifest, null, 2)}\n`)
  if (existsSync(target)) {
    await mkdir(path.dirname(backup), { recursive: true })
    await copyFile(target, backup)
    plan.backupPath = path.relative(paths.root, backup)
  }
  await writeFile(target, `${JSON.stringify(plan.pack, null, 2)}\n`)
  plan.subsystemResults = await applyRuntimePackAdapters(plan.pack, paths.root)
  await mkdir(path.dirname(manifest), { recursive: true })
  plan.manifestPath = path.relative(paths.root, manifest)
  await writeFile(manifest, `${JSON.stringify({
    version: 0,
    action: "apply",
    appliedAt: new Date().toISOString(),
    packPath: plan.packPath,
    packageManifestPath: plan.packageManifestPath,
    backupPath: plan.backupPath,
    manifestPath: plan.manifestPath,
    packID: plan.pack.id,
    packVersion: plan.pack.version,
    secretsIncluded: false,
  }, null, 2)}\n`)
  return plan
}

export async function deleteLocalRuntimePack(root?: string) {
  const paths = mendPaths(root)
  const removed: string[] = []
  const targets = [mendPackageManifestFile(paths.root), packFile(paths.root)]
  for (const target of targets) {
    if (!existsSync(target)) continue
    await rm(target, { force: true })
    removed.push(path.relative(paths.root, target).split(path.sep).join(path.posix.sep))
  }
  await packageMetadataSet({ selection: null }, paths.root)
  return {
    ok: true,
    action: "delete-local",
    removed,
    selectionCleared: true,
    localArtifactsTouched: false,
    secretsIncluded: false,
  }
}

export async function rollbackRuntimePack(root?: string) {
  const paths = mendPaths(root)
  const backupDir = path.join(paths.root, ".mendcode", "runtime-pack.backups")
  const backups = await listFiles(backupDir, ".json")
  if (!backups.length) throw new Error("No runtime pack backup is available for rollback.")
  const latest = path.join(backupDir, backups[backups.length - 1]!)
  const target = packFile(paths.root)
  const manifest = runtimePackManifestFile(paths.root, "rollback")
  await copyFile(latest, target)
  const plan = await runtimePackPlan("rollback", paths.root)
  plan.backupPath = path.relative(paths.root, latest)
  plan.subsystemResults = await applyRuntimePackAdapters(plan.pack, paths.root)
  await mkdir(path.dirname(manifest), { recursive: true })
  plan.manifestPath = path.relative(paths.root, manifest)
  await writeFile(manifest, `${JSON.stringify({
    version: 0,
    action: "rollback",
    appliedAt: new Date().toISOString(),
    packPath: plan.packPath,
    backupPath: plan.backupPath,
    manifestPath: plan.manifestPath,
    restoredFrom: plan.backupPath,
    secretsIncluded: false,
  }, null, 2)}\n`)
  return plan
}

export function formatRuntimePackPlan(plan: RuntimePackPlan) {
  const model = plan.pack.models.default.providerID && plan.pack.models.default.modelID
    ? `${plan.pack.models.default.providerID}/${plan.pack.models.default.modelID}`
    : "runtime default"
  return [
    `Action: ${plan.action}`,
    `Pack: ${plan.pack.id}@${plan.pack.version} (${plan.pack.source.type})`,
    `Package ID: ${plan.packageManifest.id}`,
    `Package title: ${plan.packageManifest.title || "unnamed"}`,
    `Package channel: ${plan.packageManifest.channel || "unset"}`,
    `Target: ${plan.packPath}`,
    `Package manifest: ${plan.packageManifestPath}`,
    `Default model: ${model}`,
    `Focus: ${plan.pack.focus.resolved.focusID} (${plan.pack.focus.resolved.source})`,
    `Commands: ${plan.pack.commands.length}`,
    `Agents: ${plan.pack.agents.length}`,
    `Modes: ${plan.pack.modes.length}`,
    `Skills: ${plan.pack.skills.length}`,
    `Plugins: ${plan.pack.plugins.length}`,
    `Prompt templates: ${plan.pack.prompts.templates.length}`,
    `Extensions: ${plan.pack.extensions.length}`,
    `Memory settings: ${Object.keys(plan.pack.settings.memory || {}).length ? "included" : "none"}`,
    `Permission settings: ${Object.keys(plan.pack.settings.permissions || {}).length ? "included" : "none"}`,
    `Context: ${plan.pack.context.include.join(", ") || "none"}`,
    `TUI: ${(plan.pack.tui as any).profile || "unknown"} / ${(plan.pack.tui as any).layout?.density || "unknown"}`,
    `Budget keys: ${Object.keys(plan.pack.budget).join(", ") || "none"}`,
    `Worktree mode: ${(plan.pack.worktree as any).mode || "off"}`,
    `Subsystems: ${plan.subsystemChanges.length}`,
    `Secrets included: ${plan.secretsIncluded}`,
    `Marketplace: local registry/catalog (${plan.marketplace.plannedSources.join(", ") || "none"})`,
    `Teams: shared-config-only preview/apply, approval gated, local secrets excluded`,
    `Rollback: ${plan.rollbackAvailable ? "available" : "not available yet"}`,
  ].join("\n")
}
