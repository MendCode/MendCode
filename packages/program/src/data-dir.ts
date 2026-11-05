import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** Where MendCode keeps its data by default: `~/.mendcode`. */
export const DATA_DIR_NAME = ".mendcode"
/** The name the data directory had before (`~/.mendcode-v2`); a link of that name keeps old paths working after the move. */
export const LEGACY_DATA_DIR_NAME = ".mendcode-v2"
/** Where data that `~/.mendcode` held from MendCode v1 is set aside, never deleted. */
export const V1_ASIDE_NAME = ".mendcode-v1"

export const defaultDataDir = (home = homedir()) => path.join(home, DATA_DIR_NAME)

/** `MENDCODE_<name>`, else the older `MENDCODE_V2_<name>`: every setting variable keeps answering to its old spelling. */
export function mendEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[`MENDCODE_${name}`]
  return value !== undefined && value !== "" ? value : env[`MENDCODE_V2_${name}`] || undefined
}

/** The data directory a variable names (`MENDCODE_DIR`, else `MENDCODE_V2_DIR`), or undefined. */
export const dataDirFromEnv = (env: Readonly<Record<string, string | undefined>>) => mendEnv(env, "DIR")

/** The data directory: an explicit one (`--dir`), else the variable, else `~/.mendcode`. */
export const resolveDataDir = (explicit: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env, home?: string) =>
  path.resolve(explicit ?? dataDirFromEnv(env) ?? defaultDataDir(home))

export type DataDirMove =
  | { moved: false; reason: "nothing to move" | "already moved" | "both hold data" | "daemon still running" | "failed"; detail?: string }
  | { moved: true; v1Aside?: string }

const isDir = (file: string) => { try { return lstatSync(file).isDirectory() } catch { return false } }
const isLink = (file: string) => { try { return lstatSync(file).isSymbolicLink() } catch { return false } }
const holdsDaemonData = (dir: string) => existsSync(path.join(dir, "mendd.db"))
const isEmptyDir = (dir: string) => { try { return readdirSync(dir).length === 0 } catch { return false } }

/** The default directory to use now: the old one only while its data is still really there (a move that could not happen yet). */
export function defaultDataDirNow(home = homedir()) {
  const oldDir = path.join(home, LEGACY_DATA_DIR_NAME), newDir = path.join(home, DATA_DIR_NAME)
  return isDir(oldDir) && !(isDir(newDir) && holdsDaemonData(newDir)) ? oldDir : newDir
}

const real = (dir: string) => { try { return realpathSync(dir) } catch { return path.resolve(dir) } }
/** Whether two paths name the same directory once links are followed (`~/.mendcode-v2` and `~/.mendcode` after the move). */
export const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b) || real(a) === real(b)

/** Whether `dir` is the default data directory under either name (`~/.mendcode`, or `~/.mendcode-v2` before or after the move). */
export function isDefaultDataDir(dir: string, home = homedir()) {
  const actual = real(dir)
  return [path.join(home, DATA_DIR_NAME), path.join(home, LEGACY_DATA_DIR_NAME)].some((candidate) => real(candidate) === actual || path.resolve(candidate) === path.resolve(dir))
}

/**
 * MendCode v1 kept OpenCode's and its own XDG folders as links into `~/.mendcode` (`~/.config/opencode` → `~/.mendcode`,
 * `~/.local/share/opencode` → `~/.mendcode/data`, ...). Once v1's folder is set aside those links follow it there, so OpenCode
 * keeps its data and never reads or writes MendCode's new folder. Links pointing anywhere else are left as they are.
 */
export function repointLinks(home: string, from: string, to: string): string[] {
  const moved: string[] = []
  for (const base of [".config", ".cache", path.join(".local", "share"), path.join(".local", "state")]) {
    for (const name of ["mendcode", "opencode"]) {
      const link = path.join(home, base, name)
      if (!isLink(link)) continue
      const target = path.resolve(path.dirname(link), readlinkSync(link))
      const relative = path.relative(from, target)
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue
      unlinkSync(link)
      symlinkSync(path.join(to, relative), link)
      moved.push(link)
    }
  }
  return moved
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** Whether `pid` runs a detached daemon (`mendcode __daemon`), not a terminal that hosts one in its own process (solo mode). */
function isStandaloneDaemon(pid: number) {
  let command = ""
  try { command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString() } catch { return false }
  return /\s__daemon(\s|$)/.test(command) || /packages\/daemon\/src\/main\.ts/.test(command)
}

/**
 * Stops the detached daemon that holds `dir` (its pid in `mendd.lock`) with SIGTERM, the graceful stop of `--restart-daemon`
 * (running turns end as interrupted and resume), and waits for it to exit. True when nothing holds the directory any more.
 * A terminal that hosts its daemon is someone's open screen: it is left alone (false), and the move waits for a later start.
 */
export async function stopStandaloneDaemon(dir: string, timeoutMs = 8_000) {
  let pid: number
  try { pid = Number(readFileSync(path.join(dir, "mendd.lock"), "utf8")) } catch { return true }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false
  if (!alive(pid)) return true
  if (!isStandaloneDaemon(pid)) return false
  try { process.kill(pid, "SIGTERM") } catch { return !alive(pid) }
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return false
}

/** A free name beside `base`: `.mendcode-v1`, then `.mendcode-v1-2`, … */
function freeName(base: string) {
  if (!existsSync(base) && !isLink(base)) return base
  for (let i = 2; ; i++) if (!existsSync(`${base}-${i}`) && !isLink(`${base}-${i}`)) return `${base}-${i}`
}

/**
 * Moves the data of an earlier version from `~/.mendcode-v2` to `~/.mendcode` once, and leaves `~/.mendcode-v2` as a link to it,
 * so paths saved before the move (a service definition, settings, an older terminal still open) keep reaching the same files.
 * Only the default location moves: a directory named by `--dir` or a variable is the user's choice and stays.
 *
 * `~/.mendcode` from MendCode v1 (no daemon database in it) is renamed to `~/.mendcode-v1`, never deleted. When both hold a
 * daemon database nothing moves and the new one is used. `stopDaemon` stops a daemon of the earlier version that holds the old
 * directory; when it cannot, nothing moves this time and the caller keeps using the old directory.
 */
export async function moveLegacyDataDir(input: {
  home?: string
  stopDaemon(dir: string): Promise<boolean>
  /** Runs while nothing holds the old directory, before it moves (stopping a user service, so it does not restart on the old path). */
  beforeMove?(oldDir: string): Promise<void> | void
  /** Runs after the move with both paths (pointing a user service at the new one). */
  afterMove?(oldDir: string, newDir: string): Promise<void> | void
  platform?: NodeJS.Platform
}): Promise<DataDirMove> {
  const home = input.home ?? homedir()
  const oldDir = path.join(home, LEGACY_DATA_DIR_NAME), newDir = path.join(home, DATA_DIR_NAME)
  if (isLink(oldDir)) return { moved: false, reason: "already moved" }
  if (!isDir(oldDir)) return { moved: false, reason: "nothing to move" }
  if (isDir(newDir) && holdsDaemonData(newDir)) return { moved: false, reason: "both hold data" }
  try {
    await input.beforeMove?.(oldDir)
    if (existsSync(path.join(oldDir, "mendd.lock")) && !await input.stopDaemon(oldDir)) return { moved: false, reason: "daemon still running" }
    let v1Aside: string | undefined
    if (isLink(newDir) || existsSync(newDir)) {
      if (isDir(newDir) && isEmptyDir(newDir)) rmdirSync(newDir)
      else { v1Aside = freeName(path.join(home, V1_ASIDE_NAME)); renameSync(newDir, v1Aside) }
    }
    if (v1Aside) repointLinks(home, newDir, v1Aside)
    renameSync(oldDir, newDir)
    // A junction needs no privilege on Windows; elsewhere a relative link survives a moved home.
    if ((input.platform ?? process.platform) === "win32") symlinkSync(newDir, oldDir, "junction")
    else symlinkSync(DATA_DIR_NAME, oldDir)
    await input.afterMove?.(oldDir, newDir)
    return { moved: true, ...(v1Aside ? { v1Aside } : {}) }
  } catch (error) {
    return { moved: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) }
  }
}
