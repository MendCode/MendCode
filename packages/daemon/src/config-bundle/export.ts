import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs"
import path from "node:path"
import { EXECUTABLE_PACKAGE_PATHS, findSecrets, PACKAGE_KINDS, redactSecrets } from "@mendcode/protocol/wire"
import { auditPackageTree, PACKAGE_NAME, readManifest, INSTALL_RECORD_FILE } from "@mendcode/packages"
import { redactSettings } from "../settings-tool"
import { BUNDLE_FORMAT, BUNDLE_VERSION, BundleManifest, ConfigBundleError, MAX_REASON, MAX_WARNING, manifestHash, MAX_BUNDLE_BYTES, MAX_BUNDLE_ENTRIES, sha256, type Bundle, type BundleEntry, type BundleExclusion, type BundlePackage, type BundleSettings } from "./bundle"
import { APPROVAL_PROFILE_KEYS, classifyEntry, classifySetting, nativeBinary, type ImportAction, type MatrixColumn } from "./classify"

/** One row of the inventory: a data-directory entry (or package, or settings key) and where it falls in the matrix. */
export type InventoryRow = { item: string; kind: "file" | "folder" | "link" | "package" | "setting" | "profile-key"; column: MatrixColumn; exported: boolean; action: ImportAction | "settings" | "pending-approval"; reason: string; files?: number; bytes?: number }

export type ExportInput = {
  dataDir: string
  /** The daemon's saved settings (`settings.get`). */
  settings: Record<string, unknown>
  home: string
  platform: string
  arch: string
  now: number
  mendcodeVersion?: string | undefined
  buildId?: string | undefined
  /** Paths (or folders, e.g. `packages/seda`) whose possible-credential findings the user reviewed: exported anyway, and said so. */
  allowFlagged?: readonly string[] | undefined
}

/** Entries every package layer treats as code that runs on its own once the package is enabled. */
const AUTO_RUN = new Set<string>([...EXECUTABLE_PACKAGE_PATHS, ...PACKAGE_KINDS.filter((kind) => kind.executable).flatMap((kind) => ("exportPaths" in kind ? kind.exportPaths : []).map((entry) => entry.split("/")[0]!))])
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|\.netrc|\.npmrc)$/i
const MAX_TEXT_SCAN = 8 * 1024 * 1024

/** Text in a file that names the machine it was written on: its home folder, macOS-only places and tools, other OS paths. */
export function hostHints(text: string, home: string): string[] {
  const hints = new Set<string>()
  if (home && home !== "/" && text.includes(home)) hints.add(`home folder ${home}`)
  const checks: Array<[RegExp, string]> = [
    [/\/Users\/[A-Za-z0-9._-]+/, "macOS home path (/Users/…)"], [/\/home\/[A-Za-z0-9._-]+/, "Linux home path (/home/…)"], [/[A-Za-z]:\\\\?[A-Za-z]/, "Windows path"],
    [/Library\/Application Support|~\/Library\//, "macOS Library folder"], [/\b(osascript|pbcopy|pbpaste|afplay|launchctl|defaults write|open -a)\b/, "macOS-only command"],
    [/\/opt\/homebrew|\/usr\/local\/Cellar/, "Homebrew path"], [/\.app\/Contents/, "macOS app bundle"], [/\bsystemctl\b|\/proc\//, "Linux-only command"],
  ]
  for (const [pattern, label] of checks) if (pattern.test(text)) hints.add(label)
  return [...hints].slice(0, 6)
}

const unitOf = (relative: string) => relative.split("/").slice(0, 2).join("/")

type Collected = { entries: BundleEntry[]; files: Record<string, string>; bytes: number; allowFlagged: readonly string[]; flaggedIncluded: string[] }

/** Where the secret scanner fired in a text, by kind and line: never the matched text itself. */
export function flaggedLines(text: string): string[] {
  const out: string[] = []
  for (const finding of findSecrets(text)) {
    const at = text.indexOf(finding.value)
    out.push(`${finding.kind} at line ${at < 0 ? "?" : text.slice(0, at).split("\n").length}`)
  }
  return out.slice(0, 5)
}
const allowed = (relative: string, allow: readonly string[]) => allow.some((entry) => relative === entry || relative.startsWith(`${entry}/`))

/** The first four bytes and the exec bit of a file, for telling a native binary or a script apart. */
function probe(full: string, mode: number) {
  const head = Buffer.alloc(4)
  const descriptor = openSync(full, "r")
  try { readSync(descriptor, head, 0, 4, 0) } finally { closeSync(descriptor) }
  return { head, executable: (mode & 0o111) !== 0 }
}

function readHead(full: string) {
  const bytes = readFileSync(full)
  return { bytes, head: bytes.subarray(0, 4) }
}

/** One file of an exported entry: refused when it is a secret, a native binary or holds credential-like text; otherwise listed with its hash. */
function addFile(input: { full: string; relative: string; action: BundleEntry["action"]; home: string; into: Collected; excluded: BundleExclusion[] }): boolean {
  const info = lstatSync(input.full)
  if (SECRET_NAME.test(path.basename(input.relative))) { input.excluded.push({ path: input.relative, column: "approval", reason: "looks like a credential file" }); return false }
  const { bytes, head } = readHead(input.full)
  const binary = nativeBinary(head)
  if (binary) { input.excluded.push({ path: input.relative, column: "not-portable", reason: `${binary}: rebuild it on the target` }); return false }
  // A file too big to scan for credentials is not exported unless the user reviewed it.
  if (bytes.byteLength > MAX_TEXT_SCAN && !allowed(input.relative, input.into.allowFlagged)) { input.excluded.push({ path: input.relative, column: "approval", reason: `over ${MAX_TEXT_SCAN / 1024 / 1024} MB, not scanned for credentials: review it and export with --allow-flagged ${input.relative}` }); return false }
  const text = bytes.byteLength <= MAX_TEXT_SCAN ? bytes.toString("utf8") : ""
  if (text && redactSecrets(text).count > 0) {
    const where = flaggedLines(text).join(", ")
    if (!allowed(input.relative, input.into.allowFlagged)) { input.excluded.push({ path: input.relative, column: "approval", reason: `possible credential (${where}): use a secret reference, or review it and export with --allow-flagged ${input.relative}` }); return false }
    input.into.flaggedIncluded.push(`${input.relative}: flagged as a possible credential (${where}); included because --allow-flagged named it`)
  }
  if (input.into.entries.length >= MAX_BUNDLE_ENTRIES || input.into.bytes + bytes.byteLength > MAX_BUNDLE_BYTES * 0.7) throw new ConfigBundleError(`the export exceeds ${MAX_BUNDLE_ENTRIES} files or ${Math.round(MAX_BUNDLE_BYTES * 0.7 / 1024 / 1024)} MB`)
  const hints = text ? hostHints(text, input.home) : []
  input.into.entries.push({ path: input.relative, unit: unitOf(input.relative), action: input.action, sha256: sha256(bytes), bytes: bytes.byteLength, executable: (info.mode & 0o111) !== 0, ...(hints.length ? { hostHints: hints } : {}) })
  input.into.files[input.relative] = bytes.toString("base64")
  input.into.bytes += bytes.byteLength
  return true
}

/** Walks a folder without following links; a link is listed as excluded, never read through. */
function walk(input: { root: string; relative: string; visit: (full: string, relative: string) => void; excluded: BundleExclusion[] }) {
  const full = path.join(input.root, input.relative)
  for (const name of readdirSync(full).sort()) {
    const childRelative = `${input.relative}/${name}`
    const child = path.join(full, name)
    const info = lstatSync(child)
    if (info.isSymbolicLink()) input.excluded.push({ path: childRelative, column: "machine", reason: `link to ${readlinkSync(child)}: links are not exported; recreate it on the target` })
    else if (info.isDirectory()) {
      if (name === ".git" || name === "node_modules") input.excluded.push({ path: childRelative, column: "omitted", reason: "repository or dependency folder" })
      else walk({ ...input, relative: childRelative })
    } else if (info.isFile()) input.visit(child, childRelative)
  }
}

export function packageTreeHash(entries: Array<Pick<BundleEntry, "path" | "sha256">>, name: string) {
  const prefix = `packages/${name}/`
  return sha256(entries.filter((entry) => entry.path.startsWith(prefix) && entry.path !== `${prefix}${INSTALL_RECORD_FILE}`).map((entry) => `${entry.path.slice(prefix.length)}\0${entry.sha256}`).sort().join("\n"))
}

/** sha256 over a package folder's files, the way `packageTreeHash` sees a bundle: the obtained side of a comparison. */
export function installedTreeHash(dir: string): { sha256: string; files: number } | undefined {
  const lines: string[] = []
  let ok = true
  const visit = (relative: string) => {
    for (const name of readdirSync(path.join(dir, relative)).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name
      const info = lstatSync(path.join(dir, childRelative))
      if (info.isSymbolicLink()) { ok = false; continue }
      if (info.isDirectory()) { if (name !== ".git" && name !== "node_modules") visit(childRelative) }
      else if (info.isFile() && childRelative !== INSTALL_RECORD_FILE) lines.push(`${childRelative}\0${sha256(readFileSync(path.join(dir, childRelative)))}`)
    }
  }
  try { visit("") } catch { return undefined }
  return ok ? { sha256: sha256(lines.sort().join("\n")), files: lines.length } : undefined
}

/** The stored profile keys an import leaves for approval (they start things or touch the clipboard), one row each. */
function profileKeyRows(file: string): InventoryRow[] {
  let profile: Record<string, unknown>
  try { profile = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> } catch { return [] }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return []
  return Object.keys(profile).filter((key) => APPROVAL_PROFILE_KEYS.has(key)).sort().map((key) => ({ item: `tui/profile.json#${key}`, kind: "profile-key" as const, column: "approval" as const, exported: true, action: "pending-approval" as const, reason: "starts things, touches the clipboard or the network: set it in /customize on the target" }))
}

/** Splits saved settings into what an import applies, what waits for approval and what describes this machine; credential-like values are hidden. */
export function bundleSettings(settings: Record<string, unknown>): BundleSettings {
  const out: BundleSettings = { portable: {}, approval: {}, machine: {}, withheld: [] }
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue
    const kind = classifySetting(key)
    const hidden = redactSettings(value, key)
    const changed = JSON.stringify(hidden) !== JSON.stringify(value) || redactSecrets(JSON.stringify(value)).count > 0
    if (changed) out.withheld.push(key)
    if (kind === "portable" && !changed) out.portable[key] = value
    else if (kind === "machine") out.machine[key] = hidden
    else out.approval[key] = hidden
  }
  return out
}

/**
 * Reads the data directory without changing anything and builds the bundle: every exported file with its sha256, every
 * package with its state, the settings split by authority, and a visible line for everything left out and why.
 */
export function exportBundle(input: ExportInput): { bundle: Bundle; inventory: InventoryRow[] } {
  const dataDir = path.resolve(input.dataDir)
  const collected: Collected = { entries: [], files: {}, bytes: 0, allowFlagged: input.allowFlagged ?? [], flaggedIncluded: [] }
  const excluded: BundleExclusion[] = []
  const warnings: string[] = []
  const inventory: InventoryRow[] = []
  const packages: BundlePackage[] = []
  const disabledPackages = Array.isArray(input.settings.disabledPackages) ? input.settings.disabledPackages as string[] : []
  const disabledResources = Array.isArray(input.settings.disabledPackageResources) ? input.settings.disabledPackageResources as string[] : []

  for (const name of readdirSync(dataDir).sort()) {
    const full = path.join(dataDir, name)
    const info = lstatSync(full)
    if (info.isSymbolicLink()) {
      const reason = `link to ${readlinkSync(full)}: links are not exported; recreate it on the target`
      excluded.push({ path: name, column: "machine", reason })
      inventory.push({ item: name, kind: "link", column: "machine", exported: false, action: "none", reason })
      continue
    }
    if (info.isSocket() || info.isFIFO()) { excluded.push({ path: name, column: "omitted", reason: "socket of the running daemon" }); inventory.push({ item: name, kind: "file", column: "omitted", exported: false, action: "none", reason: "socket of the running daemon" }); continue }
    if (name === "tui" && info.isDirectory()) {
      for (const child of readdirSync(full).sort()) {
        const relative = `tui/${child}`
        const childFull = path.join(full, child)
        const childInfo = lstatSync(childFull)
        const rule = classifyEntry(relative, childInfo.isFile() ? () => probe(childFull, childInfo.mode) : undefined)
        const kind = childInfo.isDirectory() ? "folder" : childInfo.isSymbolicLink() ? "link" : "file"
        const exported = rule.exported && childInfo.isFile() && addFile({ full: childFull, relative, action: rule.action === "tui-profile" ? "tui-profile" : rule.action === "quarantine" ? "quarantine" : "write", home: input.home, into: collected, excluded })
        if (exported) inventory.push({ item: relative, kind, column: rule.column, exported, action: rule.action, reason: rule.reason })
        else {
          // addFile already listed why a file it refused stays out; anything else is out by its rule.
          const refused = rule.exported && childInfo.isFile() ? excluded.at(-1)! : { path: relative, column: childInfo.isSymbolicLink() ? "machine" as const : rule.column, reason: childInfo.isSymbolicLink() ? "link: not exported" : rule.reason }
          if (refused !== excluded.at(-1)) excluded.push(refused)
          inventory.push({ item: relative, kind, column: refused.column, exported: false, action: "none", reason: refused.reason })
        }
        if (exported && rule.action === "tui-profile") inventory.push(...profileKeyRows(childFull))
      }
      continue
    }
    const rule = classifyEntry(name, info.isFile() ? () => probe(full, info.mode) : undefined)
    if (!rule.exported) {
      excluded.push({ path: name, column: rule.column, reason: rule.reason })
      inventory.push({ item: name, kind: info.isDirectory() ? "folder" : "file", column: rule.column, exported: false, action: "none", reason: rule.reason })
      continue
    }
    if (rule.action === "package") {
      for (const pkgName of readdirSync(full).sort()) {
        const dir = path.join(full, pkgName)
        const pkgInfo = lstatSync(dir)
        if (!pkgInfo.isDirectory() || pkgName.startsWith(".")) continue
        const item = `packages/${pkgName}`
        const refuse = (reason: string, column: MatrixColumn = "not-portable") => {
          excluded.push({ path: item, column, reason })
          inventory.push({ item, kind: "package", column, exported: false, action: "none", reason })
        }
        if (!PACKAGE_NAME.test(pkgName)) { refuse("not a valid package name"); continue }
        const read = readManifest(dir)
        if ("problem" in read) { refuse(`invalid manifest: ${read.problem}`); continue }
        const audit = auditPackageTree(dir)
        if (audit.length) { refuse(`refused by the package audit: ${audit.slice(0, 3).join("; ")}`, "approval"); continue }
        const before = collected.entries.length
        const pkgExcluded: BundleExclusion[] = []
        walk({ root: dataDir, relative: item, excluded: pkgExcluded, visit: (fileFull, relative) => {
          if (relative === `${item}/${INSTALL_RECORD_FILE}`) return
          addFile({ full: fileFull, relative, action: "package", home: input.home, into: collected, excluded: pkgExcluded })
        } })
        if (pkgExcluded.length) {
          // A package travels whole or not at all: a missing file would install a different package under the same name.
          collected.entries.splice(before).forEach((entry) => { delete collected.files[entry.path]; collected.bytes -= entry.bytes })
          refuse(`cannot travel whole: ${pkgExcluded.slice(0, 3).map((entry) => `${entry.path} (${entry.reason})`).join("; ")}`, pkgExcluded[0]!.column)
          continue
        }
        const key = `user:${pkgName}`
        const top = readdirSync(dir)
        const autoRuns = [...top.filter((entry) => AUTO_RUN.has(entry)), ...(read.manifest.extensions && !top.includes("extensions") ? ["extensions"] : [])]
        const pkgEntries = collected.entries.slice(before)
        packages.push({
          name: pkgName, ...(read.manifest.version ? { version: read.manifest.version } : {}), enabled: !disabledPackages.includes(key),
          disabledResources: disabledResources.filter((entry) => entry.startsWith(`${key}/`)).map((entry) => entry.slice(key.length + 1)),
          autoRuns, treeSha256: packageTreeHash(pkgEntries, pkgName), files: pkgEntries.length,
        })
        const hinted = pkgEntries.filter((entry) => entry.hostHints?.length)
        if (hinted.length) warnings.push(`${item}: ${hinted.length} file${hinted.length === 1 ? "" : "s"} name this machine (${[...new Set(hinted.flatMap((entry) => entry.hostHints!))].slice(0, 3).join(", ")})`)
        inventory.push({ item, kind: "package", column: autoRuns.length ? "approval" : "exportable", exported: true, action: autoRuns.length ? "quarantine" : "package", reason: autoRuns.length ? `runs code once enabled (${autoRuns.join(", ")}): copied to quarantine` : `${read.manifest.version ?? ""} ${disabledPackages.includes(key) ? "off" : "on"}; installed with the package installer`.trim(), files: pkgEntries.length, bytes: pkgEntries.reduce((sum, entry) => sum + entry.bytes, 0) })
      }
      continue
    }
    const before = collected.entries.length
    const beforeExcluded = excluded.length
    const action = rule.action === "activation" ? "activation" : rule.action === "mcp-pending" ? "mcp-pending" : rule.action === "quarantine" ? "quarantine" : "write"
    if (info.isDirectory()) walk({ root: dataDir, relative: name, excluded, visit: (fileFull, relative) => void addFile({ full: fileFull, relative, action, home: input.home, into: collected, excluded }) })
    else if (info.isFile()) addFile({ full, relative: name, action, home: input.home, into: collected, excluded })
    const added = collected.entries.slice(before)
    const dropped = excluded.slice(beforeExcluded)
    inventory.push({ item: name, kind: info.isDirectory() ? "folder" : "file", column: added.length ? rule.column : dropped[0]?.column ?? rule.column, exported: added.length > 0, action: added.length ? rule.action : "none", reason: added.length ? `${rule.reason}${dropped.length ? ` (${dropped.length} left out)` : ""}` : dropped[0]?.reason ?? "empty", files: added.length, bytes: added.reduce((sum, entry) => sum + entry.bytes, 0) })
  }

  warnings.push(...collected.flaggedIncluded)
  for (const entry of collected.entries) if (entry.action !== "package" && entry.hostHints?.length) warnings.push(`${entry.path}: names this machine (${entry.hostHints.join(", ")})`)
  const settings = bundleSettings(input.settings)
  for (const key of Object.keys(input.settings).sort()) {
    const kind = classifySetting(key)
    const withheld = settings.withheld.includes(key)
    inventory.push({ item: `settings.${key}`, kind: "setting", column: kind === "portable" && !withheld ? "exportable" : kind === "machine" ? "machine" : "approval", exported: true, action: kind === "portable" && !withheld ? "settings" : kind === "machine" ? "none" : "pending-approval", reason: kind === "portable" ? withheld ? "held credential-like text: value hidden" : "applied with settings.set" : kind === "machine" ? "folders, shells or schedules of this machine: shown, never applied" : "your authority (permissions, models, trust, spend, execution): waits for approval on the target" })
  }
  const clamp = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
  // The export checks its own manifest: a file it writes is always one the import reads.
  const manifest: BundleManifest = BundleManifest.parse({
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: input.now,
    source: { platform: input.platform, arch: input.arch, home: input.home, dataDir, ...(input.mendcodeVersion ? { mendcodeVersion: input.mendcodeVersion } : {}), ...(input.buildId ? { buildId: input.buildId } : {}) },
    entries: collected.entries, packages, settings,
    excluded: excluded.map((entry) => ({ ...entry, path: clamp(entry.path, 600), reason: clamp(entry.reason, MAX_REASON) })),
    warnings: warnings.map((line) => clamp(line, MAX_WARNING)),
  })
  return { bundle: { manifest, manifestSha256: manifestHash(manifest), files: collected.files }, inventory }
}
