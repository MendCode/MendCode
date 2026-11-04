import { readFileSync } from "node:fs"
import path from "node:path"
import { defaultDataDirNow, isDefaultDataDir, sameDir } from "./data-dir"

/**
 * The pid in `mendd.lock` is a bare number that outlives a daemon killed uncleanly, and pids are reused. So before anything is
 * signalled the process behind it is checked: alive, running a MendCode daemon (`mendcode __daemon ...`, or the daemon's source
 * entry), and serving the data directory being restarted. Anything else is a stale lock and nobody is signalled.
 * (An identity written into the lock itself is a format change shared with the store and the upgrade; this reads what the OS shows.)
 */

export type LockOwner =
  /** No lock file, or it holds no usable pid. */
  | { state: "none"; detail: string }
  /** The lock names a pid that no longer exists: a leftover. */
  | { state: "gone"; pid: number; detail: string }
  /** A live MendCode daemon that serves the directory. */
  | { state: "daemon"; pid: number; detail: string }
  /** A live process that is not that daemon: a recycled pid, another directory's daemon, a terminal that hosts its own, or one whose command line cannot be read. */
  | { state: "foreign"; pid: number; detail: string; /** The command line names MendCode but is no daemon: a terminal that hosts its own (solo mode). Worth waiting for, never worth signalling. */ mendcode?: true }

export type OwnerProbe = {
  /** Whether the pid exists (default: signal 0). */
  alive?(pid: number): boolean
  /** The process's command line, arguments separated by spaces; undefined when it cannot be read (default: /proc on Linux, `ps` elsewhere). */
  commandOf?(pid: number): string | undefined
  self?: number
  parent?: number
  /** The platform the default `commandOf` reads (tests). */
  platform?: string
}

export function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** The command line of `pid` (`/proc/<pid>/cmdline` on Linux, `ps` elsewhere, none on Windows); undefined when unreadable or the process is gone. */
export function processCommand(pid: number, platform: string = process.platform): string | undefined {
  try {
    if (platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") || undefined
    if (platform === "win32") return undefined
    const child = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { PATH: "/usr/bin:/bin" } })
    return child.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

/** Whether `command` starts a MendCode daemon: the `__daemon` entry of the binary, or the daemon's own source file. */
export const isDaemonCommand = (command: string) => /(^|\s)__daemon(\s|$)/.test(command) || /packages\/daemon\/src\/main\.ts(\s|$)/.test(command)

/** The `--dir` of a daemon command line: from the flag up to the next ` --flag` (a directory name may hold spaces); undefined when it has none. */
export function daemonDirOf(command: string): string | undefined {
  const match = /(?:^|\s)--dir(?:=|\s+)(.+?)(?=\s--[a-z]|$)/.exec(command)
  return match?.[1]?.trim()
}

/** Whether the daemon behind `command` serves `dir`. A daemon started without `--dir` serves the default directory. */
function servesDir({ command, dir }: { command: string; dir: string }) {
  const own = daemonDirOf(command)
  if (own === undefined) return isDefaultDataDir(dir) || sameDir(defaultDataDirNow(), dir)
  return sameDir(own, dir)
}

/** Who `<dir>/mendd.lock` names: see {@link LockOwner}. Never signals anything. */
export function inspectLockOwner({ dir, probe = {} }: { dir: string; probe?: OwnerProbe }): LockOwner {
  let text: string
  try { text = readFileSync(path.join(dir, "mendd.lock"), "utf8") } catch { return { state: "none", detail: "no lock file" } }
  const pid = Number(text)
  const { self = process.pid, parent = process.ppid, alive = pidAlive, commandOf = (target: number) => processCommand(target, probe.platform) } = probe
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "none", detail: `the lock holds ${JSON.stringify(text.trim().slice(0, 20))}, not a process id` }
  if (!alive(pid)) return { state: "gone", pid, detail: `process ${pid} no longer exists` }
  if (pid === self || pid === parent) return { state: "foreign", pid, detail: `process ${pid} is this command or the terminal that started it` }
  const command = commandOf(pid)
  if (command === undefined) return { state: "foreign", pid, detail: `process ${pid} is running but its command line cannot be read on this system, so it cannot be confirmed as a MendCode daemon` }
  const shown = command.length > 120 ? `${command.slice(0, 117)}...` : command
  if (!isDaemonCommand(command)) return { state: "foreign", pid, detail: `process ${pid} is not a MendCode daemon (${shown})`, ...(/mendcode/i.test(command) ? { mendcode: true as const } : {}) }
  if (!servesDir({ command, dir })) return { state: "foreign", pid, detail: `process ${pid} is a MendCode daemon for ${daemonDirOf(command) ?? "another directory"}, not ${dir}` }
  return { state: "daemon", pid, detail: `process ${pid}` }
}
