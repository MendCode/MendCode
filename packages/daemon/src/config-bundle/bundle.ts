import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { z } from "zod"

/** The one file a personal configuration travels in: a manifest of every entry with its sha256, then the entries' bytes. */
export const BUNDLE_FORMAT = "mendcode-config-bundle"
export const BUNDLE_VERSION = 1
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
export const MAX_BUNDLE_ENTRIES = 10_000

export class ConfigBundleError extends Error {
  constructor(message: string) { super(`[CONFIG-BUNDLE]: ${message}`) }
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** JSON with object keys sorted at every level: the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** A data-directory-relative path with `/` separators that cannot leave the folder it is joined to. */
export function portablePathProblem(relative: string): string | undefined {
  if (!relative || relative.length > 512) return "empty or longer than 512 characters"
  if (relative.includes("\\") || relative.includes("\0")) return "backslash or NUL"
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return "absolute"
  if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) return "empty, . or .. segment"
  return undefined
}
const PortablePath = z.string().superRefine((value, ctx) => {
  const problem = portablePathProblem(value)
  if (problem) ctx.addIssue({ code: "custom", message: `unsafe path ${JSON.stringify(value.slice(0, 80))}: ${problem}` })
})
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const Column = z.enum(["exportable", "omitted", "machine", "approval", "not-portable"])

export const BundleEntry = z.strictObject({
  path: PortablePath,
  /** What a conflict is decided for: `skills/<name>`, `commands/<file>`, `packages/<name>`, or the file itself. */
  unit: PortablePath,
  action: z.enum(["write", "quarantine", "mcp-pending", "package", "tui-profile", "activation"]),
  sha256: Hex64,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
  /** Text that names this machine: its home folder, macOS-only places or tools. */
  hostHints: z.array(z.string().max(200)).max(20).optional(),
})
export type BundleEntry = z.infer<typeof BundleEntry>

export const BundlePackage = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  version: z.string().max(64).optional(),
  enabled: z.boolean(),
  /** `skills/foo`, `commands/bar`: the package's own resources switched off. */
  disabledResources: z.array(z.string().max(200)).max(500),
  /** Top-level entries that run code on their own once enabled (tools, hooks, MCP, extensions, workflows, status line). */
  autoRuns: z.array(z.string().max(100)).max(50),
  /** sha256 over every file's path and sha256 (the install record excluded). */
  treeSha256: Hex64,
  files: z.number().int().nonnegative(),
})
export type BundlePackage = z.infer<typeof BundlePackage>

export const MAX_REASON = 1000
export const MAX_WARNING = 1000
export const BundleExclusion = z.strictObject({ path: z.string().max(600), column: Column, reason: z.string().max(MAX_REASON) })
export type BundleExclusion = z.infer<typeof BundleExclusion>

export const BundleSettings = z.strictObject({
  /** Applied by an import through `settings.set`. */
  portable: z.record(z.string(), z.unknown()),
  /** Shown and left for the native approval on the target; credential-like values hidden. */
  approval: z.record(z.string(), z.unknown()),
  /** Folders, shells and schedules of the source machine; shown, never applied. */
  machine: z.record(z.string(), z.unknown()),
  /** Keys whose value held credential-like text: the bundle has `[hidden]` in its place. */
  withheld: z.array(z.string()),
})
export type BundleSettings = z.infer<typeof BundleSettings>

export const BundleManifest = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  createdAt: z.number().int().nonnegative(),
  source: z.strictObject({
    platform: z.string().max(32), arch: z.string().max(32), home: z.string().max(512), dataDir: z.string().max(1024),
    mendcodeVersion: z.string().max(64).optional(), buildId: z.string().max(64).optional(),
  }),
  entries: z.array(BundleEntry).max(MAX_BUNDLE_ENTRIES),
  packages: z.array(BundlePackage).max(200),
  settings: BundleSettings,
  excluded: z.array(BundleExclusion).max(5000),
  warnings: z.array(z.string().max(MAX_WARNING)).max(2000),
})
export type BundleManifest = z.infer<typeof BundleManifest>

const BundleFile = z.strictObject({
  manifest: BundleManifest,
  manifestSha256: Hex64,
  /** path -> base64 bytes, one per entry. */
  files: z.record(z.string(), z.string()),
})
export type Bundle = z.infer<typeof BundleFile>

export function manifestHash(manifest: BundleManifest) {
  return sha256(canonicalJson(manifest))
}

export function serializeBundle(bundle: Bundle): string {
  return `${JSON.stringify(bundle)}\n`
}

/**
 * Reads and checks a bundle: its size, its shape, the manifest's own hash and every entry's bytes against the sha256 the
 * manifest lists. Any mismatch refuses the whole bundle: nothing of a damaged or edited file is used.
 */
export function readBundle(file: string): Bundle {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile()) throw new ConfigBundleError(`${file}: not a regular file`)
  if (info.size > MAX_BUNDLE_BYTES) throw new ConfigBundleError(`${file}: ${info.size} bytes; a bundle holds at most ${MAX_BUNDLE_BYTES}`)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, "utf8")) } catch { throw new ConfigBundleError(`${file}: not valid JSON`) }
  return parseBundle(raw)
}

export function parseBundle(raw: unknown): Bundle {
  const format = (raw as { manifest?: { format?: unknown; version?: unknown } } | null)?.manifest
  if (format?.format !== BUNDLE_FORMAT) throw new ConfigBundleError("not a MendCode configuration bundle")
  if (format.version !== BUNDLE_VERSION) throw new ConfigBundleError(`bundle version ${String(format.version)} is not supported; this MendCode reads version ${BUNDLE_VERSION}`)
  const parsed = BundleFile.safeParse(raw)
  if (!parsed.success) throw new ConfigBundleError(`invalid bundle: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  const bundle = parsed.data
  if (manifestHash(bundle.manifest) !== bundle.manifestSha256) throw new ConfigBundleError("manifest hash does not match: the bundle was changed after export")
  const paths = new Set<string>()
  for (const entry of bundle.manifest.entries) {
    if (paths.has(entry.path)) throw new ConfigBundleError(`${entry.path}: listed twice`)
    paths.add(entry.path)
    const data = bundle.files[entry.path]
    if (data === undefined) throw new ConfigBundleError(`${entry.path}: listed in the manifest but missing`)
    const bytes = Buffer.from(data, "base64")
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new ConfigBundleError(`${entry.path}: content does not match its sha256`)
  }
  const extra = Object.keys(bundle.files).filter((key) => !paths.has(key))
  if (extra.length) throw new ConfigBundleError(`files not in the manifest: ${extra.slice(0, 5).join(", ")}`)
  return bundle
}

export const entryBytes = (bundle: Bundle, entry: Pick<BundleEntry, "path">) => Buffer.from(bundle.files[entry.path]!, "base64")
