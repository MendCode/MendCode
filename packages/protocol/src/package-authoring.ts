import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { PACKAGE_SELECTIONS } from "./package-authoring-data"
import { lazySchema, lazyValue } from "./lazy"
import { activationProblems } from "./activation-data"

export const PackageAuthorMetadata = lazySchema(() => z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(500).optional(),
  version: z.string().min(1).max(40).optional(),
  kind: z.string().min(1).max(64).optional(),
  channel: z.string().min(1).max(64).optional(),
  sourceType: z.string().min(1).max(64).optional(),
  sourceURL: z.string().max(500).optional(),
  compatMendcode: z.string().min(1).max(100).optional(),
  compatRuntimePack: z.string().min(1).max(100).optional(),
}))
export type PackageAuthorMetadata = z.infer<typeof PackageAuthorMetadata>
export const PackageAuthorManifest = lazySchema(() => z.strictObject({
  /** Names only, never values. Static hints are not permission to read the environment. */
  environment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(32).optional(),
  title: z.string().max(200).optional(), kind: z.string().max(64).optional(), channel: z.string().max(64).optional(),
  /**
   * `mendcode`: the app versions it runs on (`>=0.0.1`, `^0.2`); `api`: the lowest extension API version it needs. Both are checked
   * when the package is enabled. A `mendcode` that is not a version range (older manifests say `v2`) is a label and is not enforced;
   * `package check` reports it.
   */
  compatibility: z.strictObject({
    mendcode: z.string().max(100).optional(),
    api: z.number().int().min(1).max(1000).optional(),
    runtimePack: z.string().max(100).optional(),
  }).optional(),
  /** The look and keys the package brings as one reversible overlay (docs/packages.md). */
  activate: z.unknown().superRefine((value, ctx) => { for (const problem of activationProblems(value)) ctx.addIssue({ code: "custom", message: problem }) }).optional(),
  distribution: z.strictObject({
    source: z.strictObject({ type: z.string().max(64), url: z.string().max(500).optional() }),
    trust: z.strictObject({ signatureRequired: z.literal(false) }),
  }).optional(),
}))
const selection = z.enum(PACKAGE_SELECTIONS)
const targets = lazySchema(() => z.array(z.union([selection, z.literal("all")])).max(64))
const base = { id: CommandId, clientId: ClientId, directory: z.string().min(1).max(4096) }
const author = lazyValue(() => ({ ...base, metadata: PackageAuthorMetadata.optional(), include: targets.optional(), exclude: targets.optional() }))
export const PackagesCreate = lazySchema(() => z.strictObject({ ...author(), type: z.literal("packages.create") }))
export const PackagesUpdate = lazySchema(() => z.strictObject({ ...author(), type: z.literal("packages.update") }))
export const PackagesDeleteLocal = lazySchema(() => z.strictObject({ ...base, type: z.literal("packages.delete-local") }))
export const PackageAuthoringReport = lazySchema(() => z.strictObject({
  action: z.enum(["create", "update"]), directory: z.string(), packagePath: z.string(), manifestPath: z.string(), metadataPath: z.string(),
  backupPath: z.string().optional(), name: z.string(), version: z.string(), title: z.string(),
  selection: z.array(selection), artifacts: z.array(z.string()), settings: z.array(selection),
  secretsIncluded: z.literal(false), activated: z.literal(false), signed: z.literal(false), warnings: z.array(z.string()),
}))
export type PackageAuthoringReport = z.infer<typeof PackageAuthoringReport>
export const PackageDeleteLocalReport = lazySchema(() => z.strictObject({
  action: z.literal("delete-local"), directory: z.string(), removed: z.array(z.string()), trashPath: z.string().optional(),
  selectionCleared: z.literal(true), localArtifactsTouched: z.literal(false), secretsIncluded: z.literal(false),
}))
export type PackageDeleteLocalReport = z.infer<typeof PackageDeleteLocalReport>
