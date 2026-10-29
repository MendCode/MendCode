import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * The daemon finds `gh`, `git`, `claude` and the other programs it starts through its own `PATH`, which is whatever started it:
 * a terminal, `env -i`, launchd (`/usr/bin:/bin:/usr/sbin:/sbin`) or systemd. Started with a short one, every PR review watch
 * paused on "gh is not installed or not on PATH" while `gh` sat in /opt/homebrew/bin (seen live). So at start the daemon adds the
 * usual install folders that exist on this machine, then the `PATH` of the user's login shell. Only `PATH` is read from that
 * shell: no other variable, token or secret is copied. The folders it already had stay first, in their order.
 */

const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
const PLATFORM_DIRS: Record<string, string[]> = {
  darwin: ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"],
  linux: ["/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/local/sbin", "/snap/bin"],
}
/** Printed before the shell's `PATH`, so what a profile prints is not read as part of it. */
const MARKER = "__MENDCODE_PATH__"
export const SHELL_PATH_TIMEOUT_MS = 5000

/** `current` with each folder of `more` that it lacks appended; empty and relative entries are dropped. */
export function mergePath(current: string | undefined, more: readonly string[]): string {
  const entries: string[] = []
  for (const entry of [...(current ?? "").split(":"), ...more]) if (path.isAbsolute(entry) && !entries.includes(entry)) entries.push(entry)
  return entries.join(":")
}

/** The usual install folders of this platform (Homebrew, /usr/local, ~/.local/bin, the system ones) that exist. */
export function knownToolDirs({ platform = process.platform, home = homedir(), exists = existsSync }: { platform?: string; home?: string; exists?: (dir: string) => boolean } = {}): string[] {
  const user = platform === "linux" ? [path.join(home, ".local", "bin"), path.join(home, ".linuxbrew", "bin")] : [path.join(home, ".local", "bin")]
  return [...(PLATFORM_DIRS[platform] ?? []), ...user, ...SYSTEM_DIRS].filter((dir) => exists(dir))
}

/** The folders of the `PATH` a login shell prints after `MARKER`; undefined when the output has none. */
export function parseShellPath(output: string): string[] | undefined {
  const at = output.lastIndexOf(MARKER)
  if (at < 0) return undefined
  const line = output.slice(at + MARKER.length).split("\n")[0]!.trim()
  const entries = line.split(":").filter((entry) => path.isAbsolute(entry))
  return entries.length ? entries : undefined
}

/** The user's login shell's `PATH` (`$SHELL -l -i -c`, as an editor reads it), or undefined when it fails or takes too long. */
export async function loginShellPath({ shell = process.env.SHELL, timeoutMs = SHELL_PATH_TIMEOUT_MS, environment = process.env }: { shell?: string | undefined; timeoutMs?: number; environment?: NodeJS.ProcessEnv } = {}): Promise<string[] | undefined> {
  if (!shell || !path.isAbsolute(shell) || process.platform === "win32") return undefined
  try {
    const child = Bun.spawn([shell, "-l", "-i", "-c", `printf '%s%s\\n' '${MARKER}' "$PATH"`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...environment, TERM: "dumb" } })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    try {
      const output = await new Response(child.stdout).text()
      return await child.exited === 0 ? parseShellPath(output.slice(-64 * 1024)) : undefined
    } finally { clearTimeout(timer) }
  } catch { return undefined }
}

/**
 * Completes `environment.PATH` in place: the known folders at once, the login shell's in the background (a slow profile must not
 * hold the daemon's start). Resolves with the final `PATH` once the shell answered or gave up.
 */
export function completeToolPath(environment: NodeJS.ProcessEnv, options: { platform?: string; home?: string; exists?: (dir: string) => boolean; shellPath?: () => Promise<string[] | undefined> } = {}): Promise<string> {
  if ((options.platform ?? process.platform) === "win32") return Promise.resolve(environment.PATH ?? "")
  environment.PATH = mergePath(environment.PATH, knownToolDirs(options))
  return (options.shellPath ?? (() => loginShellPath({ shell: environment.SHELL, environment })))().catch(() => undefined).then((dirs) => {
    if (dirs) environment.PATH = mergePath(environment.PATH, dirs)
    return environment.PATH ?? ""
  })
}
