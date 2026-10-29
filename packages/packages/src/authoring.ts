import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { PackageAuthorMetadata, type PackageAuthoringReport, type PackageDeleteLocalReport } from "@mendcode/protocol"
import { exportPathsFor, PACKAGE_SELECTIONS, redactSecrets, type PackageSelection } from "@mendcode/protocol/wire"
import { auditPackageTree, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, PackageError } from "./install"
import { extensionsProblem, MANIFEST_FILE, packageContents, packageManifestSchema } from "./manifest"
import { moveToTrash } from "./trash"

export const LOCAL_PACKAGE_DIR = "package-local"
const STATE_FILE = "package-authoring.json"
const stateSchema = z.strictObject({ version: z.literal(0), metadata: PackageAuthorMetadata, selection: z.array(z.enum(PACKAGE_SELECTIONS)), artifacts: z.array(z.string()).optional() })
const SETTINGS: PackageSelection[] = ["models", "focus", "budget", "memory", "permissions", "tuiProfile", "worktreePolicy"]

function safePath(root: string, relative: string) {
  const parts = relative.split(path.sep)
  let full = root
  for (const part of parts) {
    full = path.join(full, part)
    if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new PackageError(`${relative}: links are not allowed in authoring paths`)
  }
  return full
}
function projectRoot(directory: string) {
  const root = realpathSync(directory)
  return { directory: root, source: safePath(root, ".mendcode") }
}
function json(file: string) {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size > 1024 * 1024) throw new PackageError(`invalid or oversized authoring JSON: ${path.basename(file)}`)
  try { return JSON.parse(readFileSync(file, "utf8")) as unknown }
  catch { throw new PackageError(`invalid authoring JSON: ${path.basename(file)}`) }
}
function readState(source: string): z.infer<typeof stateSchema> {
  const file = safePath(source, STATE_FILE)
  if (!existsSync(file)) return { version: 0 as const, metadata: {} as PackageAuthorMetadata, selection: [...PACKAGE_SELECTIONS] }
  const parsed = stateSchema.safeParse(json(file))
  if (!parsed.success) throw new PackageError("invalid package authoring metadata")
  return parsed.data
}
function write(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
function selection(include: string[] | undefined, exclude: string[] | undefined, previous: PackageSelection[]) {
  if (include === undefined && exclude === undefined) return previous
  const targets = [...include ?? [], ...exclude ?? []]
  const unknown = targets.filter((item) => item !== "all" && !PACKAGE_SELECTIONS.includes(item as PackageSelection))
  if (unknown.length) throw new PackageError(`unknown package include/exclude target: ${unknown.join(", ")}`)
  const wanted = !include?.length || include.includes("all") ? PACKAGE_SELECTIONS : include
  return PACKAGE_SELECTIONS.filter((item) => wanted.includes(item) && !exclude?.includes("all") && !exclude?.includes(item))
}
function secretSafe(text: string, relative: string) {
  if (redactSecrets(text).count) throw new PackageError(`${relative}: contains credentials; use secret references before exporting`)
}

/** Exports only selected project configuration, never providers, databases, history or installed packages. */
export function authorLocalPackage(input: { directory: string; action: "create" | "update"; metadata?: PackageAuthorMetadata; include?: string[]; exclude?: string[]; settings?: Partial<Record<PackageSelection, unknown>>; now?: () => number }): PackageAuthoringReport {
  const { directory, source } = projectRoot(input.directory)
  const previous = readState(source)
  const metadata = PackageAuthorMetadata.safeParse({ ...previous.metadata, ...input.metadata })
  if (!metadata.success) throw new PackageError("invalid package metadata")
  const chosen = selection(input.include, input.exclude, previous.selection)
  const reselection = input.include !== undefined || input.exclude !== undefined
  const savedFiles = !reselection && previous.artifacts ? new Set(previous.artifacts) : undefined
  const value = metadata.data
  const manifest = packageManifestSchema.parse({
    name: value.id ?? "local", version: value.version ?? "0.1.0", description: value.description ?? value.title ?? path.basename(directory),
    title: value.title ?? path.basename(directory), kind: value.kind ?? "bundle", channel: value.channel ?? "local",
    compatibility: { ...(value.compatMendcode ? { mendcode: value.compatMendcode } : {}), runtimePack: value.compatRuntimePack ?? "^0" },
    distribution: { source: { type: value.sourceType ?? "local", ...(value.sourceURL !== undefined ? { url: value.sourceURL } : {}) }, trust: { signatureRequired: false } },
  })
  secretSafe(JSON.stringify(manifest), MANIFEST_FILE)
  const files: Array<{ relative: string; bytes: Buffer }> = []
  let bytes = 0
  const collect = (relative: string) => {
    const full = safePath(source, relative)
    const info = lstatSync(full, { throwIfNoEntry: false })
    if (!info) return
    if (info.isDirectory()) {
      for (const name of readdirSync(full).sort()) {
        if ([".git", "node_modules", ".mendcode-install.json"].includes(name)) continue
        collect(path.join(relative, name))
      }
      return
    }
    if (!info.isFile()) throw new PackageError(`${relative}: authoring requires regular files`)
    const portable = relative.split(path.sep).join("/")
    if (savedFiles && !savedFiles.has(portable)) return
    bytes += info.size
    if (files.length >= MAX_PACKAGE_FILES - 2 || bytes > MAX_PACKAGE_BYTES - 64 * 1024) throw new PackageError("selected package exceeds the file/byte limit")
    const content = readFileSync(full)
    // MCP literal env/header credentials do not become shareable just because their keys are innocuous.
    if (relative === "mcp.json" || relative.startsWith(`mcp${path.sep}`)) {
      const check = (item: unknown): void => {
        if (!item || typeof item !== "object") return
        for (const [key, val] of Object.entries(item)) {
          if (["env", "headers"].includes(key) && val && typeof val === "object") {
            if (Object.values(val).some((entry) => typeof entry !== "string" || !/^(\$\{[^}]+\}|\{env:[^}]+\})$/.test(entry))) throw new PackageError(`${relative}: env/headers must use secret references`)
          } else if (/^(clientSecret|apiKey|password|token)$/i.test(key) && val) throw new PackageError(`${relative}: literal credentials cannot be exported`)
          else check(val)
        }
      }
      check(json(full))
    }
    secretSafe(content.toString("utf8"), relative)
    files.push({ relative: portable, bytes: content })
  }
  // What each selection copies comes from the one table of package kinds, the same one the loaders and `package check` use.
  for (const kind of chosen) for (const relative of exportPathsFor(kind)) collect(relative)
  const snapshotSettings = Object.fromEntries(SETTINGS.filter((key) => chosen.includes(key) && input.settings?.[key] !== undefined).map((key) => [key, input.settings![key]]))
  secretSafe(JSON.stringify(snapshotSettings), "runtime-pack.json")
  mkdirSync(source, { recursive: true })
  const target = safePath(source, LOCAL_PACKAGE_DIR)
  if (existsSync(target) && !lstatSync(target).isDirectory()) throw new PackageError("local package target must be a folder")
  const stage = mkdtempSync(path.join(source, ".package-stage-"))
  const backup = existsSync(target) ? safePath(source, path.join("package-backups", randomUUID())) : undefined
  const stateFile = safePath(source, STATE_FILE)
  const temporaryState = path.join(source, `.package-state-${randomUUID()}.tmp`)
  try {
    for (const file of files) {
      const dest = path.join(stage, file.relative)
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, file.bytes, { mode: 0o600 })
    }
    manifest.extensions = packageContents(stage).extensions > 0
    write(path.join(stage, MANIFEST_FILE), manifest)
    write(path.join(stage, "runtime-pack.json"), { version: 0, name: manifest.name, metadata: value, selection: chosen, artifacts: files.map((file) => file.relative), settings: snapshotSettings, createdAt: (input.now ?? Date.now)(), secretsIncluded: false, signed: false })
    const problems = auditPackageTree(stage)
    const mismatch = extensionsProblem({ manifest, dir: stage })
    if (problems.length || mismatch) throw new PackageError([...(mismatch ? [mismatch] : []), ...problems].join("; "))
    write(temporaryState, { version: 0, metadata: value, selection: chosen, ...(reselection || previous.artifacts ? { artifacts: files.map((file) => file.relative) } : {}) })
    if (backup) { mkdirSync(path.dirname(backup), { recursive: true }); renameSync(target, backup) }
    try {
      renameSync(stage, target)
      renameSync(temporaryState, stateFile)
    } catch (error) {
      if (existsSync(target)) renameSync(target, `${stage}-failed`)
      if (backup) renameSync(backup, target)
      throw error
    }
    return { action: input.action, directory, packagePath: path.relative(directory, target), manifestPath: path.relative(directory, path.join(target, MANIFEST_FILE)), metadataPath: path.relative(directory, stateFile), ...(backup ? { backupPath: path.relative(directory, backup) } : {}), name: manifest.name, version: manifest.version, title: manifest.title!, selection: chosen, artifacts: files.map((file) => file.relative), settings: Object.keys(snapshotSettings) as PackageSelection[], secretsIncluded: false, activated: false, signed: false, warnings: [] }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(temporaryState, { force: true })
  }
}

/** Retires the generated snapshot to local Trash; original artifacts and installed copies remain untouched. */
export function deleteLocalPackage(directory: string): PackageDeleteLocalReport {
  const { directory: root, source } = projectRoot(directory)
  const state = readState(source)
  const target = safePath(source, LOCAL_PACKAGE_DIR)
  const trash = existsSync(target) ? moveToTrash({ base: source, source: target, label: "package-local" }) : undefined
  const stateFile = safePath(source, STATE_FILE)
  const temporary = path.join(source, `.package-state-${randomUUID()}.tmp`)
  try {
    if (existsSync(stateFile)) {
      write(temporary, { version: 0, metadata: state.metadata, selection: [...PACKAGE_SELECTIONS] })
      renameSync(temporary, stateFile)
    }
  } catch (error) { if (trash) renameSync(trash, target); throw error }
  finally { rmSync(temporary, { force: true }) }
  return { action: "delete-local", directory: root, removed: trash ? [path.relative(root, target)] : [], ...(trash ? { trashPath: path.relative(root, trash) } : {}), selectionCleared: true, localArtifactsTouched: false, secretsIncluded: false }
}
