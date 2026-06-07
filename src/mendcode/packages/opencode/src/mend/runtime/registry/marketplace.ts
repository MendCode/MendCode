import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"
import { ConfigParse } from "@/config/parse"
import { readMendPackageManifest } from "./package-manifest"
import { buildLocalRuntimePack, type RuntimePack } from "../pack"
import { opencodeSettingsPreview } from "./import-opencode"
import { readPackFromStage } from "./source"
import type { RuntimeRegistryEntry } from "./types"

export type RegistryMarketplacePackManifest = {
  id: string
  version: string
  title?: string
  description?: string
  tags?: string[]
  digest?: { algorithm: "sha256"; value: string }
  signature?: { algorithm: "sha256"; value: string }
  channel?: string
  compatibility?: {
    mendcode?: string
    runtimePack?: string
  }
  source?: {
    type?: RuntimeRegistryEntry["type"]
    url?: string | null
  }
  runtime?: {
    focusDefault?: string
    commands?: number
    agents?: number
    skills?: number
    prompts?: number
    mcpFiles?: number
  }
}

function summarizeArtifactCount(value?: string[] | string) {
  if (Array.isArray(value)) return value.length
  if (typeof value === "string") return 1
  return 0
}

function synthesizeManifestFromPackageManifest(
  manifest: Awaited<ReturnType<typeof readMendPackageManifest>>["manifest"],
  entry: RuntimeRegistryEntry,
  digest?: { algorithm: "sha256"; value: string },
) {
  return {
    id: manifest.id,
    version: entry.version || "0",
    ...(manifest.title ? { title: manifest.title } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(digest ? { digest } : {}),
    ...(entry.signature ? { signature: entry.signature } : {}),
    ...(manifest.channel ? { channel: manifest.channel } : entry.channel ? { channel: entry.channel } : entry.team ? { channel: entry.team.channel } : {}),
    ...(manifest.compatibility ? { compatibility: manifest.compatibility } : entry.compatibility ? { compatibility: entry.compatibility } : {}),
    source: {
      type: (manifest.distribution?.source?.type || entry.type) as RuntimeRegistryEntry["type"],
      url: manifest.distribution?.source?.url ?? entry.url,
    },
    runtime: {
      commands: summarizeArtifactCount(manifest.artifacts?.commands),
      agents: summarizeArtifactCount(manifest.artifacts?.agents),
      skills: summarizeArtifactCount(manifest.artifacts?.skills),
      prompts: summarizeArtifactCount(manifest.artifacts?.prompts),
      mcpFiles: summarizeArtifactCount(manifest.artifacts?.mcp),
    },
  } satisfies RegistryMarketplacePackManifest
}

type RegistryMarketplaceIndexFile = {
  version: 0
  marketplace?: {
    name?: string
    source?: string
  }
  packs: RegistryMarketplacePackManifest[]
}

const MARKETPLACE_CANDIDATES = [
  [".mendcode", "marketplace", "index.json"],
  [".mendcode", "marketplace", "index.jsonc"],
  [".mendcode", "registry-index.json"],
  [".mendcode", "registry-index.jsonc"],
  ["marketplace-index.json"],
  ["marketplace-index.jsonc"],
]

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function parseStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function parseManifest(raw: unknown, fallbackSource: RuntimeRegistryEntry): RegistryMarketplacePackManifest {
  const value = ensureObject(raw, "Marketplace pack entry")
  const id = value.id
  const version = value.version
  if (typeof id !== "string" || !id.trim()) throw new Error("Marketplace pack entry requires string id")
  if (typeof version !== "string" || !version.trim()) throw new Error(`Marketplace pack ${id} requires string version`)
  const digest = value.digest && ensureObject(value.digest, `Marketplace pack ${id} digest`)
  const signature = value.signature && ensureObject(value.signature, `Marketplace pack ${id} signature`)
  const runtime = value.runtime && ensureObject(value.runtime, `Marketplace pack ${id} runtime`)
  const source = value.source && ensureObject(value.source, `Marketplace pack ${id} source`)
  const compatibility = value.compatibility && ensureObject(value.compatibility, `Marketplace pack ${id} compatibility`)
  return {
    id,
    version,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(parseStringArray(value.tags).length ? { tags: parseStringArray(value.tags) } : {}),
    ...(digest && typeof digest.algorithm === "string" && typeof digest.value === "string"
      ? { digest: { algorithm: "sha256", value: String(digest.value).toLowerCase() } }
      : {}),
    ...(signature && typeof signature.algorithm === "string" && typeof signature.value === "string"
      ? { signature: { algorithm: "sha256", value: String(signature.value).toLowerCase() } }
      : {}),
    ...(typeof value.channel === "string" ? { channel: value.channel } : {}),
    ...(compatibility ? {
      compatibility: {
        ...(typeof compatibility.mendcode === "string" ? { mendcode: compatibility.mendcode } : {}),
        ...(typeof compatibility.runtimePack === "string" ? { runtimePack: compatibility.runtimePack } : {}),
      },
    } : {}),
    source: {
      type: (typeof source?.type === "string" ? source.type : fallbackSource.type) as RuntimeRegistryEntry["type"],
      url: typeof source?.url === "string" ? source.url : fallbackSource.url,
    },
    runtime: runtime ? {
      ...(typeof runtime.focusDefault === "string" ? { focusDefault: runtime.focusDefault } : {}),
      ...(typeof runtime.commands === "number" ? { commands: runtime.commands } : {}),
      ...(typeof runtime.agents === "number" ? { agents: runtime.agents } : {}),
      ...(typeof runtime.skills === "number" ? { skills: runtime.skills } : {}),
      ...(typeof runtime.prompts === "number" ? { prompts: runtime.prompts } : {}),
      ...(typeof runtime.mcpFiles === "number" ? { mcpFiles: runtime.mcpFiles } : {}),
    } : undefined,
  }
}

async function readMarketplaceIndexFile(stageDir: string, entry: RuntimeRegistryEntry) {
  for (const candidate of MARKETPLACE_CANDIDATES) {
    const file = path.join(stageDir, ...candidate)
    if (!existsSync(file)) continue
    const parsed = ConfigParse.jsonc(await readFile(file, "utf8"), file)
    const value = ensureObject(parsed, "Marketplace index")
    if (value.version !== 0) throw new Error(`Marketplace index version is unsupported in ${path.relative(stageDir, file)}`)
    if (!Array.isArray(value.packs)) throw new Error(`Marketplace index ${path.relative(stageDir, file)} must contain packs[]`)
    const packs = value.packs.map((item) => parseManifest(item, entry))
    return {
      path: path.relative(stageDir, file),
      format: file.endsWith(".jsonc") ? "jsonc" : "json",
      version: 0 as const,
      marketplace: value.marketplace && ensureObject(value.marketplace, "Marketplace metadata"),
      packs,
    }
  }
  return null
}

function synthesizeManifestFromPack(pack: RuntimePack, entry: RuntimeRegistryEntry, digest?: { algorithm: "sha256"; value: string }) {
  return {
    id: entry.id,
    version: String(pack.version),
    title: entry.id,
    description: entry.note,
    tags: [entry.type, entry.trust],
    ...(entry.version ? { version: entry.version } : {}),
    ...(digest ? { digest } : {}),
    ...(entry.signature ? { signature: entry.signature } : {}),
    ...(entry.channel ? { channel: entry.channel } : entry.team ? { channel: entry.team.channel } : {}),
    ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
    source: {
      type: entry.type,
      url: entry.url,
    },
    runtime: {
      focusDefault: pack.focus.default,
      commands: pack.commands?.length || 0,
      agents: pack.agents?.length || 0,
      skills: pack.skills?.length || 0,
      prompts: pack.prompts?.templates?.length || 0,
      mcpFiles: pack.mcp?.files?.length || 0,
    },
  } satisfies RegistryMarketplacePackManifest
}

function matchesQuery(pack: RegistryMarketplacePackManifest, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [
    pack.id,
    pack.version,
    pack.title || "",
    pack.description || "",
    ...(pack.tags || []),
    pack.channel || "",
    pack.source?.type || "",
  ].some((value) => value.toLowerCase().includes(needle))
}

export async function readMarketplaceCatalog(args: {
  entry: RuntimeRegistryEntry
  stageDir: string
  digest?: { algorithm: "sha256"; value: string }
}) {
  const { entry, stageDir, digest } = args
  const index = await readMarketplaceIndexFile(stageDir, entry)
  if (index) {
    return {
      source: "index" as const,
      indexPath: index.path,
      indexFormat: index.format,
      version: index.version,
      packs: index.packs,
      marketplace: {
        name: typeof index.marketplace?.name === "string" ? index.marketplace.name : null,
        source: typeof index.marketplace?.source === "string" ? index.marketplace.source : null,
      },
    }
  }

  const packageManifest = await readMendPackageManifest(stageDir)
  if (packageManifest) {
    return {
      source: "synthetic" as const,
      indexPath: packageManifest.path,
      indexFormat: packageManifest.path.endsWith(".jsonc") ? "jsonc" : "json",
      version: 0 as const,
      marketplace: { name: "staged-mend-package", source: "synthetic" },
      packs: [synthesizeManifestFromPackageManifest(packageManifest.manifest, entry, digest)],
    }
  }

  if (entry.type === "opencode-settings") {
    const preview = await opencodeSettingsPreview(stageDir)
    return {
      source: "synthetic" as const,
      indexPath: null,
      indexFormat: null,
      version: 0 as const,
      marketplace: { name: "staged-opencode-settings", source: "synthetic" },
      packs: [{
        id: entry.id,
        version: entry.version || "0",
        title: entry.id,
        description: "Synthetic marketplace view generated from staged OpenCode settings.",
        tags: ["opencode-settings"],
        ...(digest ? { digest } : {}),
        ...(entry.signature ? { signature: entry.signature } : {}),
        ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
        source: { type: entry.type, url: entry.url },
        runtime: {
          commands: preview.commandDirs.length,
          agents: preview.agentDirs.length,
          skills: preview.skillDirs.length,
        },
      } satisfies RegistryMarketplacePackManifest],
    }
  }

  const pack = entry.type === "local" && entry.url === ".mendcode/runtime-pack.json"
    ? await buildLocalRuntimePack(stageDir)
    : await readPackFromStage(stageDir)
  if (!pack) throw new Error(`Registry source ${entry.id} did not contain a marketplace index, MendCode runtime pack, or .mendcode directory`)
  const manifest = synthesizeManifestFromPack(pack, entry, digest)
  return {
    source: "synthetic" as const,
    indexPath: null,
    indexFormat: null,
    version: 0 as const,
    marketplace: { name: "staged-runtime-pack", source: "synthetic" },
    packs: [manifest],
  }
}

export async function runtimeRegistrySearchCatalog(args: {
  entry: RuntimeRegistryEntry
  stageDir: string
  query: string
  digest?: { algorithm: "sha256"; value: string }
}) {
  const catalog = await readMarketplaceCatalog(args)
  return {
    ...catalog,
    query: args.query,
    matches: catalog.packs.filter((pack) => matchesQuery(pack, args.query)),
  }
}

export async function runtimeRegistryShowCatalog(args: {
  entry: RuntimeRegistryEntry
  stageDir: string
  packID: string
  digest?: { algorithm: "sha256"; value: string }
}) {
  const catalog = await readMarketplaceCatalog(args)
  const pack = catalog.packs.find((item) => item.id === args.packID)
  if (!pack) throw new Error(`Marketplace pack not found: ${args.packID}`)
  return {
    ...catalog,
    pack,
  }
}
