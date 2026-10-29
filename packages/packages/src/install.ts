import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { compatibilityProblem } from "@mendcode/protocol/wire"
import { PACKAGE_NAME, packagesRoot, scopeBase, type ExtensionSource } from "./layers"
import { extensionsProblem, INSTALL_RECORD_FILE, packageContents, readManifest, type PackageContents, type PackageManifest } from "./manifest"
import { moveToTrash, restoreFromTrash } from "./trash"

export const MAX_PACKAGE_FILES = 2_000
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
/** Never copied from a source: version control and installed dependencies are not part of a package. */
const SKIPPED = new Set([".git", "node_modules", INSTALL_RECORD_FILE])

/** Files a package must never carry: credentials, keys, local databases. Checked by name, before anything is installed. */
const SECRET_FILES: RegExp[] = [
  /^\.env(\..+)?$/,
  /^auth\.json$/,
  /^credentials(\..+)?$/i,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|keystore|kdbx)$/i,
  /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i,
]
const SECRET_ALLOWED = /^\.env\.(example|sample|template)$/

export type PackageSource = { kind: "local"; dir: string } | { kind: "git"; url: string; ref?: string } | { kind: "npm"; name: string; version: string; integrity?: string }

export class PackageError extends Error {
  constructor(message: string) {
    super(`[PACKAGES]: ${message}`)
  }
}

/** `remove` named a package that is not installed: the daemon answers `target_mismatch`, not a refusal of the request itself. */
export class PackageNotInstalledError extends PackageError {}

const NPM_NAME = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_TARBALL_BYTES = 30 * 1024 * 1024
const NPM_TIMEOUT_MS = 120_000

/** Registry and git sources the daemon can reach. Both default to the real thing; tests pass local fakes. */
export type PackageFetchers = {
  /** Downloads `name@version` into `dest` as a tarball and returns its path. Default: `npm pack` (scripts never run). */
  npmPack?(input: { name: string; version: string; dest: string }): Promise<string>
  /** GETs a small text document such as a catalog index; rejects past `limit` bytes. Default: `fetch`, no redirects. */
  text?(url: string, limit: number): Promise<string>
}

/** Whether a spec names an exact, reproducible artifact: an exact npm version or a full git commit. Local folders are not pinned. */
export function isPinnedSpec(spec: string): boolean {
  const [base = "", ref] = spec.trim().split("#", 2)
  if (base.startsWith("npm:")) return EXACT_VERSION.test(base.slice(base.lastIndexOf("@") + 1))
  return /^(github:|git:|https?:|ssh:|git@)/.test(base) && COMMIT.test(ref ?? "")
}

/** `npm:name@1.2.3` or `npm:@scope/name@1.2.3`, optionally `#sha512-…` to require that tarball digest. Ranges and tags are refused: a package is pinned. */
function parseNpm(base: string, integrity: string | undefined): PackageSource {
  const body = base.slice("npm:".length)
  const at = body.lastIndexOf("@")
  const name = at > 0 ? body.slice(0, at) : body
  const version = at > 0 ? body.slice(at + 1) : ""
  if (!NPM_NAME.test(name) || name.length > 214) throw new PackageError(`invalid npm package name "${name}"`)
  if (!EXACT_VERSION.test(version)) throw new PackageError(`npm packages are pinned: use npm:${name}@<exact version> (got "${version || "no version"}")`)
  if (integrity !== undefined && !INTEGRITY.test(integrity)) throw new PackageError("npm integrity must be sha512-<base64> as npm prints it")
  return { kind: "npm", name, version, ...(integrity ? { integrity } : {}) }
}

/** A local folder (resolved against `cwd`), npm (`npm:name@x.y.z`), or git: `github:owner/repo`, `git:<url>`, `https://…`, `git@…`, each with an optional `#ref` (a full commit pins it). */
export function parsePackageSource(spec: string, cwd: string): PackageSource {
  const trimmed = spec.trim()
  if (!trimmed) throw new PackageError("empty package source")
  const [base, ref] = trimmed.split("#", 2) as [string, string | undefined]
  if (base.startsWith("npm:")) return parseNpm(base, ref)
  const withRef = (url: string): PackageSource => {
    if (url.startsWith("-")) throw new PackageError("git url cannot start with a dash")
    return { kind: "git", url, ...(ref ? { ref } : {}) }
  }
  if (base.startsWith("github:")) {
    const repo = base.slice("github:".length)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new PackageError(`github source must be github:owner/repo, got "${spec}"`)
    return withRef(`https://github.com/${repo}.git`)
  }
  if (base.startsWith("git:")) return withRef(base.slice("git:".length))
  if (/^(https?|ssh|git):\/\//.test(base) || /^[\w.-]+@[\w.-]+:/.test(base)) return withRef(base)
  const dir = path.resolve(cwd, trimmed)
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new PackageError(`no folder at ${dir}`)
  return { kind: "local", dir }
}

/** Walks a staged package: refuses links, secrets and oversize trees. Returns the problems found (empty = fine). */
export function auditPackageTree(root: string, options: { skipSourceFiles?: boolean } = {}): string[] {
  const problems: string[] = []
  let files = 0
  let bytes = 0
  const walk = (dir: string) => {
    // readdir order is the filesystem's (hash order on ext4): sorted, the refusal lists the same files in the same order everywhere.
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (options.skipSourceFiles && SKIPPED.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isSymbolicLink()) problems.push(`${rel}: links are not allowed in a package`)
      else if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files++
        bytes += lstatSync(full).size
        if (SECRET_FILES.some((pattern) => pattern.test(entry.name)) && !SECRET_ALLOWED.test(entry.name)) problems.push(`${rel}: looks like a secret or a local database`)
      }
      if (problems.length >= 20) return
    }
  }
  walk(root)
  if (files > MAX_PACKAGE_FILES) problems.push(`${files} files; a package holds at most ${MAX_PACKAGE_FILES}`)
  if (bytes > MAX_PACKAGE_BYTES) problems.push(`${Math.round(bytes / 1024 / 1024)} MB; a package holds at most ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`)
  return problems
}


async function run(argv: string[], cwd: string, timeoutMs: number, label: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (code !== 0) throw new PackageError(`${label} failed: ${(err || out).trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`)
  return out
}

/** `npm pack name@version`: downloads the registry tarball only. No install, no lifecycle scripts, nothing is executed from the package. */
async function npmPack({ name, version, dest }: { name: string; version: string; dest: string }): Promise<string> {
  const out = await run(["npm", "pack", `${name}@${version}`, "--pack-destination", dest, "--json", "--ignore-scripts", "--no-fund", "--no-audit"], dest, NPM_TIMEOUT_MS, "npm pack", { npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" })
  let filename: unknown
  try { filename = (JSON.parse(out) as Array<{ filename?: unknown }>)[0]?.filename } catch { /* handled below */ }
  if (typeof filename !== "string" || filename !== path.basename(filename)) throw new PackageError("npm pack returned no tarball")
  return path.join(dest, filename)
}

/** Unpacks an npm tarball (`package/…`) into `stage`, refusing links, absolute or escaping paths, and oversize archives before anything is written. */
async function extractTarball({ tarball, stage }: { tarball: string; stage: string }): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer())
  if (bytes.byteLength > MAX_TARBALL_BYTES) throw new PackageError(`tarball is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; at most ${MAX_TARBALL_BYTES / 1024 / 1024} MB`)
  const names = (await run(["tar", "-tzf", tarball], path.dirname(tarball), GIT_TIMEOUT_MS, "tar list")).split("\n").filter(Boolean)
  const kinds = (await run(["tar", "-tvzf", tarball], path.dirname(tarball), GIT_TIMEOUT_MS, "tar list")).split("\n").filter(Boolean)
  if (names.length > MAX_PACKAGE_FILES * 2) throw new PackageError(`tarball holds ${names.length} entries; a package holds at most ${MAX_PACKAGE_FILES} files`)
  const bad = names.find((entry) => entry.startsWith("/") || entry.split("/").includes("..") || !(entry === "package/" || entry.startsWith("package/")))
  if (bad) throw new PackageError(`tarball entry outside package/: ${bad}`)
  if (kinds.some((line) => /^[lh]/.test(line))) throw new PackageError("links are not allowed in a package")
  mkdirSync(stage, { recursive: true })
  await run(["tar", "-xzf", tarball, "-C", stage, "--strip-components=1"], path.dirname(tarball), GIT_TIMEOUT_MS, "tar extract")
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" }
const git = async (args: string[], cwd: string) => (await run(["git", ...args], cwd, GIT_TIMEOUT_MS, `git ${args[0]}`, GIT_ENV)).trim()

/** Fetches exactly one commit by hash (shallow) so a pinned source never follows a moving branch. */
async function fetchCommit({ url, commit, stage }: { url: string; commit: string; stage: string }) {
  mkdirSync(stage, { recursive: true })
  await git(["init", "-q"], stage)
  await git(["remote", "add", "origin", url], stage)
  await git(["fetch", "-q", "--depth", "1", "origin", commit], stage)
  await git(["checkout", "-q", "FETCH_HEAD"], stage)
}

/** Copies, clones or downloads the source into `stage` (which must not exist); returns the commit (git) or tarball digest (npm). */
async function fetchInto(source: PackageSource, stage: string, fetchers: PackageFetchers): Promise<{ commit?: string; integrity?: string }> {
  if (source.kind === "local") {
    cpSync(source.dir, stage, { recursive: true, verbatimSymlinks: true, filter: (from) => !SKIPPED.has(path.basename(from)) || from === source.dir })
    return {}
  }
  if (source.kind === "npm") {
    const scratch = `${stage}-npm`
    mkdirSync(scratch, { recursive: true })
    try {
      const tarball = await (fetchers.npmPack ?? npmPack)({ name: source.name, version: source.version, dest: scratch })
      const integrity = await extractTarball({ tarball, stage })
      if (source.integrity && source.integrity !== integrity) throw new PackageError(`npm ${source.name}@${source.version} digest differs from the pinned one`)
      rmSync(path.join(stage, "node_modules"), { recursive: true, force: true })
      return { integrity }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  if (source.ref && COMMIT.test(source.ref)) await fetchCommit({ url: source.url, commit: source.ref, stage })
  else await git(["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.url, stage], path.dirname(stage))
  const commit = await git(["rev-parse", "HEAD"], stage)
  if (source.ref && COMMIT.test(source.ref) && commit !== source.ref) throw new PackageError("fetched commit differs from the pinned one")
  rmSync(path.join(stage, ".git"), { recursive: true, force: true })
  rmSync(path.join(stage, "node_modules"), { recursive: true, force: true })
  return { commit }
}

export type InstallResult = { name: string; source: ExtensionSource; dir: string; manifest: PackageManifest; contents: PackageContents; replaced: boolean; commit?: string; integrity?: string; pinned: boolean }

/** What the running MendCode is, for `compatibility` checks: its version and the extension API version it speaks. */
export type PackageHost = { appVersion?: string | undefined; apiVersion: number }

/** The one line saying why `manifest` cannot run on `host`, or undefined. */
export const manifestCompatProblem = (manifest: PackageManifest, host: PackageHost) => compatibilityProblem({ compatibility: manifest.compatibility, appVersion: host.appVersion, apiVersion: host.apiVersion })

/**
 * Installs a package into the user's or the project's packages folder. The source is staged next to the
 * destination, audited (manifest, compatibility, links, secrets, size) and only then moved into place. A replaced package is
 * swapped atomically: if either rename fails the previous copy is put back exactly as it was, and once the swap has happened the
 * previous copy goes to the Trash (`packages restore` brings it back). A failed install leaves nothing behind.
 */
export async function installPackage(input: { spec: string; scope: ExtensionSource; userDir: string; directory: string; cwd?: string; replace?: boolean; now?: () => number; expected?: { name: string; version: string; commit?: string; integrity?: string }; fetchers?: PackageFetchers; host?: PackageHost; rename?: (from: string, to: string) => void }): Promise<InstallResult> {
  const rename = input.rename ?? renameSync
  const source = parsePackageSource(input.spec, input.cwd ?? input.directory)
  const root = packagesRoot({ source: input.scope, userDir: input.userDir, directory: input.directory })
  mkdirSync(root, { recursive: true })
  const stage = path.join(root, `.staging-${process.pid}-${Date.now().toString(36)}`)
  try {
    const { commit, integrity } = await fetchInto(source, stage, input.fetchers ?? {})
    if (input.expected?.commit && commit !== input.expected.commit) throw new PackageError("fetched commit differs from the catalog's pinned commit")
    if (input.expected?.integrity && integrity !== input.expected.integrity) throw new PackageError("tarball digest differs from the catalog's pinned digest")
    const problems = auditPackageTree(stage)
    if (problems.length) throw new PackageError(`refused:\n- ${problems.join("\n- ")}`)
    const read = readManifest(stage)
    if ("problem" in read) throw new PackageError(read.problem)
    const { manifest } = read
    if (input.expected && (manifest.name !== input.expected.name || manifest.version !== input.expected.version)) throw new PackageError("catalog name/version differs from staged package manifest")
    const mismatch = extensionsProblem({ manifest, dir: stage })
    if (mismatch) throw new PackageError(mismatch)
    const incompatible = input.host ? manifestCompatProblem(manifest, input.host) : undefined
    if (incompatible) throw new PackageError(`${manifest.name} ${incompatible}`)
    const dest = path.join(root, manifest.name)
    const replaced = existsSync(dest)
    if (replaced && !input.replace) throw new PackageError(`${manifest.name} is already installed (${input.scope}); pass replace to update it`)
    const pinned = source.kind !== "local" && isPinnedSpec(input.spec)
    const record = { source: source.kind === "local" ? source.dir : source.kind === "npm" ? `npm:${source.name}@${source.version}` : `${source.url}${source.ref ? `#${source.ref}` : ""}`, ...(commit ? { commit } : {}), ...(integrity ? { integrity } : {}), ...(pinned ? { pinned } : {}), installedAt: (input.now ?? Date.now)() }
    writeFileSync(path.join(stage, INSTALL_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
    if (replaced) {
      const old = `${stage}-old`
      rename(dest, old)
      try {
        rename(stage, dest)
      } catch (error) {
        // The swap did not complete: whatever is at `dest` is not the new package, and the old one goes back untouched.
        rmSync(dest, { recursive: true, force: true })
        renameSync(old, dest)
        throw error
      }
      try {
        moveToTrash({ base: scopeBase({ source: input.scope, userDir: input.userDir, directory: input.directory }), source: old, label: manifest.name, ...(input.now ? { now: input.now } : {}) })
      } catch {
        rmSync(old, { recursive: true, force: true })
      }
    } else rename(stage, dest)
    return { name: manifest.name, source: input.scope, dir: dest, manifest, contents: packageContents(dest), replaced, pinned, ...(commit ? { commit } : {}), ...(integrity ? { integrity } : {}) }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * Removes an installed package. The folder moves to the scope's Trash (`<data dir>/.Trash` or `<project>/.mendcode/.Trash`, the
 * same one authoring uses) and stays restorable for 30 days; `purge` deletes it for good. Returns false when there was none.
 */
export function removePackage(input: { name: string; scope: ExtensionSource; userDir: string; directory: string; purge?: boolean; now?: () => number; rename?: (from: string, to: string) => void }): boolean {
  if (!PACKAGE_NAME.test(input.name)) return false
  const dir = path.join(packagesRoot({ source: input.scope, userDir: input.userDir, directory: input.directory }), input.name)
  if (!existsSync(dir)) return false
  if (input.purge) rmSync(dir, { recursive: true, force: true })
  else moveToTrash({ base: scopeBase({ source: input.scope, userDir: input.userDir, directory: input.directory }), source: dir, label: input.name, ...(input.now ? { now: input.now } : {}), ...(input.rename ? { rename: input.rename } : {}) })
  return true
}

/** Puts the newest trashed copy of `name` back where it was installed. Throws when there is none or the name is taken. */
export function restorePackage(input: { name: string; scope: ExtensionSource; userDir: string; directory: string }): { dir: string; removedAt: number } {
  if (!PACKAGE_NAME.test(input.name)) throw new PackageError(`invalid package name: ${input.name}`)
  const dir = path.join(packagesRoot({ source: input.scope, userDir: input.userDir, directory: input.directory }), input.name)
  let restored: ReturnType<typeof restoreFromTrash>
  try {
    restored = restoreFromTrash({ base: scopeBase({ source: input.scope, userDir: input.userDir, directory: input.directory }), label: input.name, target: dir })
  } catch (error) {
    throw new PackageError(error instanceof Error ? error.message : "cannot restore")
  }
  if (!restored) throw new PackageError(`nothing to restore: ${input.scope}:${input.name} is not in the Trash (copies are kept 30 days)`)
  return { dir, removedAt: restored.at }
}
