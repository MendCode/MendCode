import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { PackageInfo } from "./queries"
import { PromptMode } from "./prompt"
import { lazySchema } from "./lazy"

const base = { id: CommandId, clientId: ClientId, directory: z.string().min(1).max(4096) }
const name = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const scope = z.enum(["user", "project"])

export const PackageSourceInfo = lazySchema(() => z.strictObject({ id: name, location: z.string(), enabled: z.boolean(), builtin: z.boolean(), remote: z.boolean().optional(), fetchedAt: z.number().optional() }))
export type PackageSourceInfo = z.infer<typeof PackageSourceInfo>
export const PackageCatalogEntry = lazySchema(() => z.strictObject({
  name, version: z.string(), description: z.string(), title: z.string().optional(), tags: z.array(z.string()),
  sourceId: name, location: z.string(), contents: PackageInfo.shape.contents,
  state: z.enum(["available", "installed", "active"]), problem: z.string().optional(),
  /** Entry names an npm package or git repository (location is its pinned spec); it is fetched and audited at install. */
  remote: z.boolean().optional(),
  /** The profile manifest's `author`, when the entry was read from a folder whose manifest names one. */
  author: z.string().max(200).optional(),
}))
export type PackageCatalogEntry = z.infer<typeof PackageCatalogEntry>
export const PackageCatalogReport = lazySchema(() => z.strictObject({ entries: z.array(PackageCatalogEntry), issues: z.array(z.string()), query: z.string() }))
export type PackageCatalogReport = z.infer<typeof PackageCatalogReport>
export const PackageCapabilities = lazySchema(() => z.strictObject({ declared: z.array(z.string().max(64)).max(32), observed: z.array(z.string().max(64)).max(32), complete: z.boolean(), declaredEnvironment: z.array(z.string().max(64)).max(32).optional(), observedEnvironment: z.array(z.string().max(64)).max(32).optional() }))
export type PackageCapabilities = z.infer<typeof PackageCapabilities>
export const PackagePreviewReport = lazySchema(() => z.strictObject({ entry: PackageCatalogEntry, scope, action: z.enum(["install", "replace"]), installedVersion: z.string().optional(), problems: z.array(z.string()), capabilities: PackageCapabilities.optional(),
  trust: z.strictObject({ identity: z.string(), signed: z.literal(false), authorization: z.literal("required"), duplicates: z.array(z.string()).max(128), comparisonComplete: z.boolean() }).optional(),
}))
export type PackagePreviewReport = z.infer<typeof PackagePreviewReport>
const assetCounts = lazySchema(() => PackageInfo.shape.contents.extend({ prompts: z.number().int().nonnegative(), templates: z.number().int().nonnegative() }))
export const PackageAssetsReport = lazySchema(() => z.strictObject({
  layers: z.array(z.strictObject({ source: z.string(), contents: PackageInfo.shape.contents, prompts: z.number().int().nonnegative(), templates: z.number().int().nonnegative() })),
  totals: assetCounts, promptMode: PromptMode,
}))
export type PackageAssetsReport = z.infer<typeof PackageAssetsReport>

export const PackagesSearch = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.search"), query: z.string().max(500).optional(), sourceId: name.optional() }))
export const PackagesShow = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.show"), name, sourceId: name.optional() }))
export const PackagesPreview = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.preview"), name: name.optional(), sourceId: name, scope }))
export const PackagesSources = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.sources") }))
export const PackagesAddSource = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.add-source"), sourceId: name, location: z.string().min(1).max(4096), enabled: z.boolean().optional() }))
export const PackagesRemoveSource = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.remove-source"), sourceId: name }))
export const PackagesInstallCatalog = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.install-catalog"), name, sourceId: name.optional(), scope, replace: z.boolean().optional() }))
export const PackagesInstallSource = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.install-source"), sourceId: name, scope, replace: z.boolean().optional() }))
export const PackagesDisableAll = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.disable-all"), scope: scope.optional() }))
export const PackagesAssets = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.assets") }))
/** Downloads a remote catalog's index into the local cache (the only catalog call that reaches the network). Opt-in: the source must be enabled. Ack: `{ sources, entries }`. */
export const PackagesRefresh = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.refresh"), sourceId: name }))
/** Lists installed profiles' switchable resources (skills, commands, agents, themes, tools, extensions); `key` narrows to one profile. Ack: `PackageConfigReport`. */
export const PackagesConfig = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.config"), key: z.string().max(200).optional() }))
/** Turns one resource of an installed profile on or off (`Settings.disabledProfileResources`). Ack: `PackageConfigReport` for that profile. */
export const PackagesResource = lazySchema(() => z.strictObject({ ...base, type: z.literal("profiles.resource"), key: z.string().max(200), resource: z.string().max(200), enabled: z.boolean() }))
export const PackageConfigReport = lazySchema(() => z.strictObject({
  directory: z.string(),
  packages: z.array(z.strictObject({
    key: z.string(), name: z.string(), source: scope,
    resources: z.array(z.strictObject({ id: z.string(), kind: z.enum(["skills", "commands", "agents", "themes", "tools", "extensions"]), name: z.string(), enabled: z.boolean() })),
  })),
}))
export type PackageConfigReport = z.infer<typeof PackageConfigReport>
