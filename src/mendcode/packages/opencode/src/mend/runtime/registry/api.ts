import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import path from "path"
import semver from "semver"
import { mendPaths } from "../../config/paths"
import { applyRuntimePack, buildLocalRuntimePack } from "../pack"
import { installMendPackageFromStage, listMendPackages } from "../packages"
import { detectRegistryConflicts, writeRegistryApplyReport } from "./conflicts"
import { normalizeOpencodeSettingsToMendcode, opencodeSettingsPreview } from "./import-opencode"
import { readMarketplaceCatalog, runtimeRegistrySearchCatalog, runtimeRegistryShowCatalog, type RegistryMarketplacePackManifest } from "./marketplace"
import { readMendPackageManifest } from "./package-manifest"
import { fetchRegistrySource, readPackFromStage, smokeRegistrySource } from "./source"
import { parseRegistryEntryArgs, readRuntimeRegistry, readRuntimeRegistryLocalState, registryFilePath, registryLocalStatePath, trustForType, writeJson, writeRuntimeRegistryLocalState } from "./state"
import { digestApplicableSource, privateGitReadiness, verifyRegistryTrust } from "./trust"
import type { RegistryApplyRecord, RuntimeRegistryEntry } from "./types"

function packageSummary(
  manifest: Awaited<ReturnType<typeof readMendPackageManifest>> | null,
  fallback: RegistryMarketplacePackManifest | null,
) {
  if (manifest) {
    return {
      path: manifest.path,
      id: manifest.manifest.id,
      title: manifest.manifest.title || null,
      description: manifest.manifest.description || null,
      kind: manifest.manifest.kind || null,
      channel: manifest.manifest.channel || null,
    }
  }
  if (fallback) {
    return {
      path: null,
      id: fallback.id,
      title: fallback.title || null,
      description: fallback.description || null,
      kind: null,
      channel: fallback.channel || null,
    }
  }
  return null
}

async function readRuntimePackageVersion(root: string) {
  const packageFile = path.join(root, "src", "mendcode", "packages", "opencode", "package.json")
  const fallbackPackageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "package.json")
  const target = existsSync(packageFile) ? packageFile : fallbackPackageFile
  const value = JSON.parse(await readFile(target, "utf8")) as { version?: string }
  return value.version || "0.0.0"
}

function ensureCompatibility(pack: RegistryMarketplacePackManifest, runtimeVersion: string, packVersion: string) {
  const mendcodeRange = pack.compatibility?.mendcode
  if (mendcodeRange && semver.valid(runtimeVersion) && !semver.satisfies(runtimeVersion, mendcodeRange)) {
    throw new Error(`Marketplace pack ${pack.id} is incompatible with MendCode runtime ${runtimeVersion}; requires ${mendcodeRange}`)
  }
  const runtimePackRange = pack.compatibility?.runtimePack
  if (runtimePackRange && semver.valid(packVersion) && !semver.satisfies(packVersion, runtimePackRange)) {
    throw new Error(`Marketplace pack ${pack.id} is incompatible with runtime-pack version ${packVersion}; requires ${runtimePackRange}`)
  }
}

export async function runtimeRegistryStatus(root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  const local = await readRuntimeRegistryLocalState(root)
  const packages = await listMendPackages(root)
  return {
    ok: true,
    path: path.relative(root, registryFilePath(root)),
    localStatePath: path.relative(root, registryLocalStatePath(root)),
    defaultSource: state.defaultSource,
    entries: state.entries.length,
    enabledEntries: state.entries.filter((entry) => entry.enabled).length,
    supportedTypes: ["local", "github", "private-git", "team", "opencode-settings"],
    signedEntries: state.entries.filter((entry) => entry.signature?.algorithm === "sha256").length,
    signatureRequiredEntries: state.entries.filter((entry) => entry.trustPolicy?.requireSignature).length,
    teamChannels: local.teamChannels,
    lastApply: local.lastApply ? { id: local.lastApply.id, appliedAt: local.lastApply.appliedAt, digest: local.lastApply.digest } : null,
    packages: {
      installed: packages.installed.length,
      enabled: packages.enabled.map((item) => item.id),
      statePath: packages.path,
    },
    secretsIncluded: false,
    redaction: state.redaction,
  }
}

export async function runtimeRegistryList(root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  return {
    ok: true,
    path: path.relative(root, registryFilePath(root)),
    entries: state.entries,
    secretsIncluded: false,
  }
}

export async function runtimeRegistryAdd(args: string[], root = mendPaths().root) {
  const next = parseRegistryEntryArgs(args)
  const state = await readRuntimeRegistry(root)
  const entry: RuntimeRegistryEntry = {
    ...next,
    trust: trustForType(next.type),
  }
  state.entries = [entry, ...state.entries.filter((item) => item.id !== entry.id)]
  await writeJson(registryFilePath(root), state)
  return { ok: true, action: "add", path: path.relative(root, registryFilePath(root)), entry, secretsIncluded: false }
}

export async function runtimeRegistryRemove(id: string | undefined, root = mendPaths().root) {
  if (!id) throw new Error("Usage: mend runtime registry remove <id>")
  const state = await readRuntimeRegistry(root)
  const before = state.entries.length
  state.entries = state.entries.filter((entry) => entry.id !== id)
  await writeJson(registryFilePath(root), state)
  return { ok: before !== state.entries.length, action: "remove", id, path: path.relative(root, registryFilePath(root)), entries: state.entries.length }
}

export async function runtimeRegistryApply(id: string | undefined, root = mendPaths().root) {
  if (!id) throw new Error("Usage: mend runtime registry apply <id>")
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  if (!entry.enabled) throw new Error(`Registry source is disabled: ${id}`)
  const fetched = await fetchRegistrySource(entry, root)
  const normalized = entry.type === "opencode-settings" ? await normalizeOpencodeSettingsToMendcode(entry, fetched.stageDir, root) : null
  const sourceStageDir = normalized?.stageDir || fetched.stageDir
  const digest = await digestApplicableSource(sourceStageDir)
  const trust = verifyRegistryTrust(entry, digest)
  const catalog = await readMarketplaceCatalog({ entry, stageDir: sourceStageDir, digest })
  const selectedPack = catalog.packs.find((item) => item.id === entry.id) || catalog.packs[0]
  const runtimeVersion = await readRuntimePackageVersion(root)
  const conflicts = await detectRegistryConflicts(sourceStageDir, root)
  const approvalRequired = entry.type === "team" && (entry.team?.requireApproval || conflicts.requiresApproval)
  if (approvalRequired && !process.env.MENDCODE_TEAM_PACK_APPROVED) {
    throw new Error(`Team registry source ${entry.id} requires approval; set MENDCODE_TEAM_PACK_APPROVED=1 for this apply after review`)
  }
  const pack = entry.type === "local" && sourceStageDir === root ? await buildLocalRuntimePack(root) : await readPackFromStage(sourceStageDir)
  if (!pack) throw new Error(`Registry source ${id} did not contain a MendCode runtime pack or .mendcode directory`)
  if (selectedPack) ensureCompatibility(selectedPack, runtimeVersion, String(pack.version))

  const copied: string[] = []
  const skipped: string[] = []
  const installedPackage = sourceStageDir !== root
    ? await installMendPackageFromStage({
      entry,
      stageDir: sourceStageDir,
      digest,
      selectedPack: selectedPack || null,
      pack,
      root,
    })
    : null
  if (installedPackage) {
    copied.push(...installedPackage.copied)
    skipped.push(...installedPackage.skipped)
  }

  const applyPlan = await applyRuntimePack(root)
  const reportPath = await writeRegistryApplyReport(root, {
    version: 0,
    appliedAt: new Date().toISOString(),
    source: {
      id: entry.id,
      type: entry.type,
      url: entry.url,
      trust: entry.trust,
    },
    digest,
    trust: { signed: trust.signed, verified: trust.verified, warnings: trust.warnings },
    compatibility: selectedPack?.compatibility || null,
    approval: {
      required: approvalRequired,
      via: entry.type === "team"
        ? entry.team?.requireApproval ? "policy" : conflicts.requiresApproval ? "conflicts" : "none"
        : "none",
      envApproved: Boolean(process.env.MENDCODE_TEAM_PACK_APPROVED),
    },
    conflicts,
    copied,
    skipped,
    package: installedPackage
      ? { id: installedPackage.id, enabled: installedPackage.enabled, root: installedPackage.root }
      : null,
    applyPlan,
    privateGit: privateGitReadiness(entry),
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    secretsIncluded: false,
  })
  const local = await readRuntimeRegistryLocalState(root)
  const record: RegistryApplyRecord = {
    id: entry.id,
    source: entry.url || "",
    type: entry.type,
    trust: entry.trust,
    appliedAt: new Date().toISOString(),
    digest: { algorithm: "sha256", value: digest.value, signed: trust.signed, verified: trust.verified },
    reportPath,
    approval: {
      required: approvalRequired,
      via: entry.type === "team"
        ? entry.team?.requireApproval ? "policy" : conflicts.requiresApproval ? "conflicts" : "none"
        : "none",
      envApproved: Boolean(process.env.MENDCODE_TEAM_PACK_APPROVED),
    },
    conflicts,
    copied,
    skipped,
    ...(entry.team ? { team: entry.team } : {}),
  }
  local.lastApply = record
  local.history = [...local.history, record]
  if (entry.type === "team" && entry.team) {
    local.teamChannels[`${entry.team.id}:${entry.team.channel}`] = {
      source: entry.id,
      channel: entry.team.channel,
      appliedAt: record.appliedAt,
      digest: digest.value,
    }
  }
  await writeRuntimeRegistryLocalState(root, local)
  return {
    ok: true,
    source: entry,
    staging: {
      path: path.relative(root, fetched.stageDir),
      fetched: fetched.fetched,
    },
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    digest,
    trust: { signed: trust.signed, verified: trust.verified, warnings: trust.warnings },
    compatibility: selectedPack?.compatibility || null,
    privateGit: privateGitReadiness(entry),
    team: entry.team || null,
    approval: record.approval,
    conflicts,
    copied,
    skipped,
    package: installedPackage
      ? { id: installedPackage.id, enabled: installedPackage.enabled, root: installedPackage.root }
      : null,
    applyPlan,
    reportPath,
    localStatePath: path.relative(root, registryLocalStatePath(root)),
    writesConfig: true,
    fetchesNetwork: fetched.fetchesNetwork,
    secretsIncluded: false,
  }
}

export async function runtimeRegistryPreview(id = "local", root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  const fetched = await fetchRegistrySource(entry, root)
  const normalized = entry.type === "opencode-settings" ? await normalizeOpencodeSettingsToMendcode(entry, fetched.stageDir, root) : null
  const sourceStageDir = normalized?.stageDir || fetched.stageDir
  const pack = entry.type === "local" && sourceStageDir === root ? await buildLocalRuntimePack(root) : await readPackFromStage(sourceStageDir)
  const opencodeSettings = entry.type === "opencode-settings" ? await opencodeSettingsPreview(fetched.stageDir) : null
  const digest = await digestApplicableSource(sourceStageDir)
  const trust = verifyRegistryTrust(entry, digest)
  const conflicts = await detectRegistryConflicts(sourceStageDir, root)
  const approvalRequired = entry.type === "team" && (entry.team?.requireApproval || conflicts.requiresApproval)
  const manifest = await readMendPackageManifest(sourceStageDir)
  return {
    ok: true,
    source: entry,
    mode: "preview-only",
    pack,
    package: packageSummary(manifest, null),
    opencodeSettings,
    staging: {
      path: path.relative(root, fetched.stageDir),
      fetched: fetched.fetched,
    },
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    digest,
    trust: { signed: trust.signed, verified: trust.verified, warnings: trust.warnings },
    privateGit: privateGitReadiness(entry),
    team: entry.team || null,
    approval: {
      required: approvalRequired,
      via: entry.type === "team"
        ? entry.team?.requireApproval ? "policy" : conflicts.requiresApproval ? "conflicts" : "none"
        : "none",
      envApproved: Boolean(process.env.MENDCODE_TEAM_PACK_APPROVED),
    },
    conflicts,
    redaction: state.redaction,
    writesConfig: false,
    fetchesNetwork: fetched.fetchesNetwork,
    secretsIncluded: false,
    note: entry.type === "local"
      ? "Local pack preview is materialized from shareable .mendcode config only."
      : entry.type === "opencode-settings"
        ? "OpenCode settings source was fetched/copied to staging and normalized into cache for preview; apply copies the normalized .mendcode projection."
        : "Registry source was fetched/copied to staging for preview; apply uses a filtered .mendcode-only copy path.",
  }
}

export async function runtimeRegistrySearch(query = "", id = "local", root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  const fetched = await fetchRegistrySource(entry, root)
  const normalized = entry.type === "opencode-settings" ? await normalizeOpencodeSettingsToMendcode(entry, fetched.stageDir, root) : null
  const sourceStageDir = normalized?.stageDir || fetched.stageDir
  const digest = await digestApplicableSource(sourceStageDir)
  const trust = verifyRegistryTrust(entry, digest)
  const result = await runtimeRegistrySearchCatalog({ entry, stageDir: sourceStageDir, query, digest })
  const manifest = await readMendPackageManifest(sourceStageDir)
  return {
    ok: true,
    source: entry,
    query,
    staging: {
      path: path.relative(root, fetched.stageDir),
      fetched: fetched.fetched,
    },
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    catalog: {
      source: result.source,
      indexPath: result.indexPath,
      indexFormat: result.indexFormat,
      version: result.version,
      marketplace: result.marketplace,
      total: result.packs.length,
      matches: result.matches.length,
    },
    package: packageSummary(manifest, result.matches[0] || result.packs[0] || null),
    results: result.matches,
    digest,
    trust: { signed: trust.signed, verified: trust.verified, warnings: trust.warnings },
    fetchesNetwork: fetched.fetchesNetwork,
    secretsIncluded: false,
  }
}

export async function runtimeRegistryShow(packID: string | undefined, id = "local", root = mendPaths().root) {
  if (!packID) throw new Error("Usage: mend runtime registry show <pack-id> [source-id]")
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  const fetched = await fetchRegistrySource(entry, root)
  const normalized = entry.type === "opencode-settings" ? await normalizeOpencodeSettingsToMendcode(entry, fetched.stageDir, root) : null
  const sourceStageDir = normalized?.stageDir || fetched.stageDir
  const digest = await digestApplicableSource(sourceStageDir)
  const trust = verifyRegistryTrust(entry, digest)
  const result = await runtimeRegistryShowCatalog({ entry, stageDir: sourceStageDir, packID, digest })
  const manifest = await readMendPackageManifest(sourceStageDir)
  return {
    ok: true,
    source: entry,
    staging: {
      path: path.relative(root, fetched.stageDir),
      fetched: fetched.fetched,
    },
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    catalog: {
      source: result.source,
      indexPath: result.indexPath,
      indexFormat: result.indexFormat,
      version: result.version,
      marketplace: result.marketplace,
      total: result.packs.length,
    },
    package: packageSummary(manifest, result.pack),
    pack: result.pack,
    digest,
    trust: { signed: trust.signed, verified: trust.verified, warnings: trust.warnings },
    fetchesNetwork: fetched.fetchesNetwork,
    secretsIncluded: false,
  }
}

export async function runtimeRegistryPublishPlan(id = "local", root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  const fetched = await fetchRegistrySource(entry, root)
  const normalized = entry.type === "opencode-settings" ? await normalizeOpencodeSettingsToMendcode(entry, fetched.stageDir, root) : null
  const sourceStageDir = normalized?.stageDir || fetched.stageDir
  const digest = await digestApplicableSource(sourceStageDir)
  const packageManifest = await readMendPackageManifest(sourceStageDir)
  const pack = entry.type === "local" && sourceStageDir === root ? await buildLocalRuntimePack(root) : await readPackFromStage(sourceStageDir)
  if (!pack) throw new Error(`Registry source ${id} did not contain a MendCode runtime pack or .mendcode directory`)
  const runtimeVersion = await readRuntimePackageVersion(root)
  const manifest = {
    version: 0,
    id: packageManifest?.manifest.id || entry.id,
    packVersion: packageManifest?.manifest.packageVersion || entry.version || String(pack.version),
    title: packageManifest?.manifest.title || entry.id,
    description: packageManifest?.manifest.description || entry.note,
    channel: packageManifest?.manifest.channel || entry.channel || entry.team?.channel || "stable",
    source: {
      type: packageManifest?.manifest.distribution?.source?.type || entry.type,
      url: packageManifest?.manifest.distribution?.source?.url ?? entry.url,
    },
    digest,
    compatibility: {
      mendcode: packageManifest?.manifest.compatibility?.mendcode || entry.compatibility?.mendcode || `^${runtimeVersion}`,
      ...(
        packageManifest?.manifest.compatibility?.runtimePack
          ? { runtimePack: packageManifest.manifest.compatibility.runtimePack }
          : entry.compatibility?.runtimePack
            ? { runtimePack: entry.compatibility.runtimePack }
            : {}
      ),
    },
    runtime: {
      focusDefault: pack.focus.default,
      commands: pack.commands.length,
      agents: pack.agents.length,
      modes: pack.modes.length,
      skills: pack.skills.length,
      plugins: pack.plugins.length,
      prompts: pack.prompts.templates.length,
      mcpFiles: pack.mcp.files.length,
      extensions: pack.extensions.length,
    },
    ...(packageManifest?.path ? { packageManifestPath: packageManifest.path } : {}),
    secretsIncluded: false,
  }
  return {
    ok: true,
    source: entry,
    manifest,
    staging: { path: path.relative(root, fetched.stageDir), fetched: fetched.fetched },
    normalized: normalized ? { path: path.relative(root, normalized.stageDir), writes: normalized.writes, preview: normalized.preview } : null,
    fetchesNetwork: fetched.fetchesNetwork,
    secretsIncluded: false,
  }
}

export async function runtimeRegistrySign(id = "local", root = mendPaths().root) {
  const plan = await runtimeRegistryPublishPlan(id, root)
  const signature = { algorithm: "sha256" as const, value: plan.manifest.digest.value }
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  entry.signature = signature
  entry.trustPolicy = { ...(entry.trustPolicy || {}), allowUnsigned: false }
  await writeJson(registryFilePath(root), state)
  return {
    ok: true,
    id,
    signature,
    path: path.relative(root, registryFilePath(root)),
    note: "Current signing is SHA-256 digest pinning, not asymmetric cryptographic signing.",
    secretsIncluded: false,
  }
}

export async function runtimeRegistrySmoke(id = "local", execute = false, root = mendPaths().root) {
  const state = await readRuntimeRegistry(root)
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) throw new Error(`Unknown registry source: ${id}`)
  return smokeRegistrySource(entry, root, execute)
}
