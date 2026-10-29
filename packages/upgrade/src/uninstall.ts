import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { UNINSTALL_USAGE, type UninstallCommand } from "./uninstall-args"
import { INSTALL_RECEIPT, parseInstallReceipt } from "./install-receipt"

export type UninstallTarget = { path: string; kind: "config" | "data" | "cache" | "state" | "binary" | "unknown"; action: "trash" | "keep" | "split" | "blocked"; bytes: number; reason?: string; fingerprint: string }
export type UninstallPlan = { dataDir: string; owned: boolean; daemon: "inactive" | "active" | "unverified"; pid?: number; targets: UninstallTarget[]; blockers: string[]; fatal: boolean }
export type UninstallDeps = {
  home: string
  env: Record<string, string | undefined>
  platform: string
  defaultDir: string
  runningBinary?: string
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  confirm?(plan: UninstallPlan): Promise<boolean>
  review?(plan: UninstallPlan, dryRun: boolean): Promise<void>
  /** Local fakes use their own pid probe; production never sends a terminating signal. */
  alive?(pid: number): boolean
  move?(source: string, destination: string): void
}

const GROUPS: Record<string, UninstallTarget["kind"]> = {
  "mendd.db": "data", "mendd.db-wal": "data", "mendd.db-shm": "data",
  blobs: "data", goals: "data", reviews: "data", asides: "data", scratchpads: "data", "loop-worktrees": "data", "extensions-data": "data", keys: "data",
  "providers.json": "config", "acp-agents.json": "config", "remote.json": "config", "remote-tokens.json": "config",
  "AGENTS.md": "config", "keybindings.json": "config", "prompt-context.json": "config", "upgrade.json": "config", "mcp.json": "config",
  tui: "config", agents: "config", commands: "config", extensions: "config", themes: "config", skills: "config", tools: "config", packages: "config", recipes: "config", pets: "config",
  builtin: "cache", "pets-cache": "cache", lsp: "cache", codegraph: "cache", diagnostics: "cache",
  "mendd.sock": "state", "mendd.endpoint": "state",
}
const RECEIPT = INSTALL_RECEIPT
const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
const canonical = (file: string): string => {
  if (existsSync(file)) return realpathSync(file)
  const parent = path.dirname(file)
  return parent === file ? file : path.join(canonical(parent), path.basename(file))
}

function guardPath(dir: string, home: string) {
  const protectedDirs = [home, path.parse(home).root, path.join(home, ".mendcode"), path.join(home, ".codex"),
    ...["share", "state"].map((kind) => path.join(home, ".local", kind, "mendcode")),
    path.join(home, ".config", "mendcode"), path.join(home, ".cache", "mendcode"), path.join(home, "Code", "MendCode")]
  const physical = canonical(dir)
  if (protectedDirs.some((file, index) => {
    const protectedPath = canonical(file)
    return within(physical, protectedPath) || index > 1 && within(protectedPath, physical)
  })) throw new Error("data directory overlaps a protected home, v1 or Codex path")
  return physical
}

function guardDirectory(dir: string, home: string) {
  const physical = guardPath(dir, home)
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error("data directory must be a real directory")
  return physical
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

function daemonState(dir: string, probe: (pid: number) => boolean): Pick<UninstallPlan, "daemon" | "pid"> {
  const lock = path.join(dir, "mendd.lock")
  if (existsSync(lock)) {
    if (lstatSync(lock).isSymbolicLink()) return { daemon: "unverified" }
    const text = readFileSync(lock, "utf8").trim()
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) return { daemon: "unverified" }
    const pid = Number(text)
    if (probe(pid)) return { daemon: "active", pid }
    return { daemon: "inactive" }
  }
  return { daemon: existsSync(path.join(dir, "mendd.sock")) || existsSync(path.join(dir, "mendd.endpoint")) ? "unverified" : "inactive" }
}

/** No symlink traversal, including descendants. The hash covers identity/metadata, never prints contents. */
function inspect(file: string) {
  const hash = createHash("sha256")
  let bytes = 0
  const walk = (current: string) => {
    const stat = lstatSync(current)
    hash.update(`${current}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}\n`)
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) walk(path.join(current, name))
    else if (stat.isFile()) bytes += stat.size
  }
  walk(file)
  return { bytes, fingerprint: hash.digest("hex") }
}

/** Read a copy so opening a WAL database cannot create sidecars in the reviewed installation. */
function databaseCopy(dir: string) {
  const temporary = mkdtempSync(path.join(tmpdir(), "mend-uninstall-review-"))
  let db: Database | undefined
  try {
    const file = path.join(dir, "mendd.db")
    if (!lstatSync(file).isFile()) throw new Error("database is not a regular file")
    for (const suffix of ["", "-wal"]) {
      const source = `${file}${suffix}`
      if (!existsSync(source)) continue
      if (!lstatSync(source).isFile()) throw new Error("database sidecar is not a regular file")
      copyFileSync(source, path.join(temporary, `mendd.db${suffix}`))
    }
    db = new Database(path.join(temporary, "mendd.db"), { readonly: true })
    const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value
    if (version !== "1") throw new Error("unrecognized v2 schema")
    db.query("SELECT id, directory, last_seq FROM sessions LIMIT 0").all()
    db.query("SELECT session_id, seq, payload FROM events LIMIT 0").all()
    db.query("SELECT id, payload FROM settings LIMIT 0").all()
    return db.serialize()
  } finally {
    db?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
}

function retainedDatabase(bytes: Uint8Array, command: UninstallCommand) {
  const temporary = mkdtempSync(path.join(tmpdir(), "mend-uninstall-retain-"))
  const file = path.join(temporary, "mendd.db")
  writeFileSync(file, bytes, { mode: 0o600 })
  const db = new Database(file)
  try {
    db.run("PRAGMA journal_mode = DELETE")
    if (!command.keepData) {
      db.run("PRAGMA foreign_keys = OFF")
      const tables = db.query<{ name: string; type: string }, []>("PRAGMA table_list").all()
      db.transaction(() => {
        for (const table of tables) if ((table.type === "table" || table.type === "virtual") && !table.name.startsWith("sqlite_") && !["meta", "settings"].includes(table.name)) db.run(`DELETE FROM "${table.name.replaceAll('"', '""')}"`)
      })()
      db.run("VACUUM")
    } else if (!command.keepConfig) db.run("DELETE FROM settings")
    return db.serialize()
  } finally { db.close(); rmSync(temporary, { recursive: true, force: true }) }
}

export function collectUninstallPlan(command: UninstallCommand, deps: UninstallDeps): UninstallPlan {
  const dataDir = guardDirectory(path.resolve(command.dir ?? deps.env.MENDCODE_V2_DIR ?? deps.defaultDir), deps.home)
  const plan: UninstallPlan = { dataDir, owned: false, ...daemonState(dataDir, deps.alive ?? alive), targets: [], blockers: [], fatal: false }
  if (plan.daemon !== "inactive") {
    plan.blockers.push(plan.daemon === "active" ? `Active daemon (pid ${plan.pid}); stop it before uninstalling` : "Daemon ownership unverified; inspect the lock/socket before uninstalling")
    plan.fatal = true
  }
  if (existsSync(path.join(dataDir, "mendd.db"))) {
    try { databaseCopy(dataDir); plan.owned = true } catch { plan.blockers.push("Database ownership unverified; data/config files left alone") }
  }
  const add = (file: string, kind: UninstallTarget["kind"], action: UninstallTarget["action"], reason?: string) => {
    if (!existsSync(file)) {
      try { lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    }
    const symlink = lstatSync(file).isSymbolicLink()
    const target = { path: file, kind, action: symlink ? "blocked" as const : action, ...inspect(file), ...(symlink ? { reason: "Symlink left alone" } : reason ? { reason } : {}) }
    const previous = plan.targets.findIndex((entry) => entry.path === file)
    if (previous < 0) plan.targets.push(target)
    else plan.targets[previous] = target
  }
  if (existsSync(dataDir)) for (const name of readdirSync(dataDir).sort()) {
    if (name === "mendd.lock" || name === "bin") continue
    const kind = GROUPS[name] ?? "unknown"
    let action: UninstallTarget["action"] = !plan.owned || kind === "unknown" ? "keep" : kind === "config" && command.keepConfig || kind === "data" && command.keepData ? "keep" : "trash"
    let reason = !plan.owned ? "Ownership unverified" : kind === "unknown" ? "Unrecognized file" : undefined
    if (plan.owned && ["mendd.db", "mendd.db-wal", "mendd.db-shm"].includes(name)) {
      const split = command.keepConfig !== command.keepData
      action = split ? (name === "mendd.db" ? "split" : "trash") : command.keepData ? "keep" : "trash"
      if (split && name === "mendd.db") reason = command.keepConfig ? "Keep settings; remove session data" : "Keep session data; reset settings"
    }
    add(path.join(dataDir, name), kind, action, reason)
  }
  const bin = path.join(dataDir, "bin")
  if (existsSync(bin)) {
    if (lstatSync(bin).isSymbolicLink() || !plan.owned) add(bin, "binary", "blocked", "Managed binary ownership unverified")
    else for (const name of readdirSync(bin).sort()) add(path.join(bin, name), "binary", ["mendcode-next", "mendcode-next.exe", "mendcode-next.prev", "mendcode-next.new", "mendcode-next.exe.prev", "mendcode-next.exe.new"].includes(name) ? "trash" : "keep", "Managed bin directory")
  }
  const installDir = guardPath(path.resolve(deps.env.MENDCODE_INSTALL_DIR ?? (deps.platform === "win32" ? path.join(deps.env.LOCALAPPDATA ?? path.join(deps.home, "AppData", "Local"), "Programs", "mendcode") : path.join(deps.home, ".local", "bin"))), deps.home)
  const installedBinary = (binary: string) => {
    if (!existsSync(binary) || plan.targets.some((target) => target.path === binary && target.action === "trash")) return
    guardPath(binary, deps.home)
    const receipt = path.join(path.dirname(binary), RECEIPT)
    let owned = false
    if (existsSync(receipt) && lstatSync(receipt).isFile() && lstatSync(binary).isFile()) {
      const expected = parseInstallReceipt(readFileSync(receipt, "utf8"))
      owned = expected?.binary === path.basename(binary) && expected.sha256 === createHash("sha256").update(readFileSync(binary)).digest("hex")
    }
    add(binary, "binary", owned ? "trash" : "blocked", owned ? "Verified installation receipt" : "No matching installation receipt")
    if (owned) add(receipt, "binary", "trash")
  }
  installedBinary(path.join(installDir, deps.platform === "win32" ? "mendcode.exe" : "mendcode"))
  if (deps.runningBinary) installedBinary(canonical(path.resolve(deps.runningBinary)))
  const wrapper = path.join(guardPath(path.resolve(deps.env.MENDCODE_NEXT_BIN_DIR ?? path.join(deps.home, ".local", "bin")), deps.home), "mendcode-next")
  if (existsSync(wrapper)) {
    const owned = lstatSync(wrapper).isFile() && /^#!\/bin\/sh\n# mendcode-next dev wrapper\nexec (?:env MENDCODE_PROGRAM=mendcode-next )?bun "[^"\n]+\/apps\/cli\/src\/entry\.ts" "\$@"\n$/.test(readFileSync(wrapper, "utf8"))
    add(wrapper, "binary", owned ? "trash" : "blocked", owned ? "Development wrapper" : "Development wrapper ownership unverified")
  }
  for (const target of plan.targets) if (target.action === "blocked") plan.blockers.push(`Left alone: ${target.path} (${target.reason})`)
  if (deps.platform === "win32" && plan.targets.some((target) => target.kind === "binary" && target.action === "trash" && target.path.endsWith(".exe"))) plan.blockers.push("Windows user PATH ownership is unrecorded; review it manually")
  return plan
}

function trashRoot(deps: UninstallDeps) {
  return deps.platform === "darwin" ? path.join(deps.home, ".Trash") : deps.platform === "win32" ? path.join(deps.env.LOCALAPPDATA ?? path.join(deps.home, "AppData", "Local"), "MendCodeV2", "Trash") : path.join(deps.env.XDG_DATA_HOME ?? path.join(deps.home, ".local", "share"), "Trash", "files")
}

export async function executeUninstall(plan: UninstallPlan, command: UninstallCommand, deps: UninstallDeps) {
  if (plan.fatal) throw new Error(plan.blockers[0])
  const targets = plan.targets.filter((target) => target.action === "trash" || target.action === "split")
  if (!targets.length) return undefined
  guardDirectory(plan.dataDir, deps.home)
  const state = daemonState(plan.dataDir, deps.alive ?? alive)
  if (state.daemon !== "inactive") throw new Error("Daemon ownership changed; stop the daemon and review again")
  // The daemon's writer lock is held until all moves and the retained DB have completed.
  const { acquireWriterLock } = await import("@mendcode/store")
  const lock = existsSync(plan.dataDir) ? acquireWriterLock(path.join(plan.dataDir, "mendd.lock")) : undefined
  const moved: { source: string; destination: string }[] = []
  const moveFile = deps.move ?? renameSync
  let retained = false
  const trash = path.join(trashRoot(deps), `mendcode-v2-${Date.now()}-${randomUUID()}`)
  try {
    guardPath(trash, deps.home)
    if (targets.some((target) => within(target.path, canonical(trash)))) throw new Error("Trash overlaps an uninstall target")
    guardDirectory(plan.dataDir, deps.home)
    const snapshot = plan.owned ? databaseCopy(plan.dataDir) : undefined
    for (const target of targets) if (inspect(target.path).fingerprint !== target.fingerprint) throw new Error("Uninstall targets changed; run --dry-run again")
    const split = targets.find((target) => target.action === "split")
    const replacement = split && snapshot ? retainedDatabase(snapshot, command) : undefined
    mkdirSync(trash, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(trash, "restore.json"), JSON.stringify({ dataDir: plan.dataDir, targets: targets.map(({ path, kind, action }) => ({ path, kind, action })) }, null, 2) + "\n", { mode: 0o600 })
    const staged = path.join(trash, "retained.new")
    if (replacement) writeFileSync(staged, replacement, { flag: "wx", mode: 0o600 })
    for (const [index, target] of targets.entries()) {
      if (inspect(target.path).fingerprint !== target.fingerprint) throw new Error("Uninstall targets changed; run --dry-run again")
      const destination = path.join(trash, `${index}-${path.basename(target.path)}`)
      moveFile(target.path, destination)
      moved.push({ source: target.path, destination })
    }
    if (split && replacement) {
      renameSync(staged, split.path)
      retained = true
    }
    return trash
  } catch (error) {
    try {
      if (retained) renameSync(path.join(plan.dataDir, "mendd.db"), path.join(trash, "retained.db"))
      for (const move of moved.reverse()) renameSync(move.destination, move.source)
    } catch { throw new Error(`Rollback incomplete; recover original files from ${trash}`) }
    throw error
  } finally { lock?.release() }
}

export function uninstallText(plan: UninstallPlan) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  const lines = ["Uninstall MendCode", `Data directory: ${clean(plan.dataDir)}`, `Daemon: ${plan.daemon}${plan.pid ? ` (pid ${plan.pid})` : ""}`]
  for (const target of plan.targets) lines.push(`${target.action}\t${target.kind}\t${clean(target.path)}\t${target.bytes} B${target.reason ? ` · ${clean(target.reason)}` : ""}`)
  for (const blocker of plan.blockers) lines.push(`blocked: ${clean(blocker)}`)
  return lines.join("\n") + "\n"
}

export async function runUninstallCommand(command: UninstallCommand, deps: UninstallDeps) {
  if (command.help) { deps.out.write(`${UNINSTALL_USAGE}\n`); return 0 }
  const emit = (kind: string, data: object) => deps.out.write(`${JSON.stringify({ schema: "mendcode-next.cli.v1", kind, command: "uninstall", ...data })}\n`)
  try {
    const plan = collectUninstallPlan(command, deps)
    if (command.json) emit("plan", { data: plan })
    else deps.out.write(uninstallText(plan))
    if (command.dryRun) {
      await deps.review?.(plan, true)
      if (!command.json) deps.out.write("Dry run: no changes made\n")
      return 0
    }
    if (plan.fatal) { await deps.review?.(plan, false); return 1 }
    if (!plan.targets.some((target) => target.action === "trash" || target.action === "split")) return plan.blockers.length ? 1 : 0
    if (!command.force) {
      if (!deps.confirm) {
        if (command.json) emit("error", { error: { code: "needs_input", message: "Confirmation required; review --dry-run then use --force" } })
        else deps.err.write("Confirmation required; review --dry-run then use --force\n")
        return 4
      }
      if (!await deps.confirm(plan)) { if (command.json) emit("result", { data: { status: "cancelled" } }); else deps.out.write("Cancelled\n"); return 2 }
    }
    const trash = await executeUninstall(plan, command, deps)
    const status = plan.blockers.length ? "partial" : "uninstalled"
    if (command.json) emit("result", { data: { status, ...(trash ? { trash } : {}), blockers: plan.blockers } })
    else deps.out.write(`${status === "partial" ? "Partial uninstall" : "Uninstalled"}${trash ? ` · Trash: ${trash}` : ""}\n`)
    return plan.blockers.length ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (command.json) emit("error", { error: { code: "uninstall_failed", message } })
    else deps.err.write(`error: ${message}\n`)
    return 1
  }
}
