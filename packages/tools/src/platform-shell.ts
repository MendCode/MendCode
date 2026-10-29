import { spawn } from "node:child_process"
import { withShellPrefix, type ShellPolicy } from "./shell-policy"

/**
 * Which shell runs the model's commands, and how. POSIX hosts keep `/bin/sh -c`; Windows prefers PowerShell 7
 * (`pwsh`), then Windows PowerShell, then `%ComSpec%`. A `shell` setting that names bash/zsh (Git Bash, WSL
 * wrappers) keeps the `-c` convention. Pure except for `killProcessTree`, so tests exercise every branch on any host.
 */
export type ShellFamily = "posix" | "powershell" | "cmd"

const POWERSHELL = new Set(["pwsh", "powershell"])

export function shellFamily(shell: string): ShellFamily {
  const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase().replace(/\.exe$/, "")
  if (POWERSHELL.has(name)) return "powershell"
  if (name === "cmd") return "cmd"
  return "posix"
}

export type DefaultShellInput = { platform?: string; env?: Record<string, string | undefined>; which?: (name: string) => string | null }

export function defaultShell({ platform = process.platform, env = process.env, which = (name: string) => Bun.which(name) }: DefaultShellInput = {}): string {
  if (platform !== "win32") return "/bin/sh"
  return which("pwsh") ?? which("powershell") ?? env.ComSpec ?? env.COMSPEC ?? "cmd.exe"
}

/** PowerShell reports 0 or 1 for a script block; the wrapper restores a native command's own exit code. */
const POWERSHELL_PRELUDE = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"
const POWERSHELL_EPILOGUE = "if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }"

/** The argv that runs `command` in `shell`. */
export function shellArgv({ shell, command: raw, interactive = false, policy }: { shell: string; command: string; interactive?: boolean; policy?: ShellPolicy | undefined }): string[] {
  const family = shellFamily(shell)
  const command = withShellPrefix(raw, policy)
  // A terminal session must stay interactive, so it gets neither -NonInteractive nor the exit-code wrapper.
  if (family === "powershell" && interactive) return [shell, "-NoLogo", "-NoProfile", "-Command", command]
  if (family === "powershell") return [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${POWERSHELL_PRELUDE}\n${command}\n${POWERSHELL_EPILOGUE}`]
  if (family === "cmd") return [shell, "/d", "/s", "/c", `"${command}"`]
  return [shell, ...(policy?.login ? ["-l"] : []), "-c", command]
}

/** Spawn options every shell launch shares: no console window on Windows, and cmd.exe gets its line verbatim. */
export function shellSpawnOptions({ shell, platform = process.platform }: { shell: string; platform?: string }) {
  return {
    detached: platform !== "win32",
    windowsHide: true,
    ...(platform === "win32" && shellFamily(shell) === "cmd" ? { windowsVerbatimArguments: true } : {}),
  }
}

/**
 * Whether `pid` can be the target of a signal this process sends on purpose: a whole number above 1 that is neither this process
 * nor its parent. `kill(0)` and `kill(-1)` reach this process's group and every process the user owns, `kill(1)` is init, and the
 * parent is the shell or terminal that started us, so none of them is ever a "child to stop"; `NaN`, `undefined` and fractions are
 * what an unparsed pid file or a failed spawn leaves behind and must not turn into one of those numbers.
 */
export function isSignalablePid(pid: unknown, { self = process.pid, parent = process.ppid }: { self?: number; parent?: number } = {}): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid !== self && pid !== parent
}

/**
 * Stops a command and everything it started. POSIX signals the process group (children are spawned `detached`, so the group is
 * the one the child leads and never ours); Windows has no groups, so `taskkill /T` walks the tree. `taskkill` runs from an
 * argument array and is never awaited. A pid that cannot be a spawned child (see `isSignalablePid`) signals nothing.
 */
export function killProcessTree({ pid, signal, fallback, platform = process.platform, self, parent }: { pid: number | undefined; signal: NodeJS.Signals; fallback(signal: NodeJS.Signals): void; platform?: string; self?: number; parent?: number }) {
  if (!isSignalablePid(pid, { ...(self !== undefined ? { self } : {}), ...(parent !== undefined ? { parent } : {}) })) return
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGTERM" ? [] : ["/F"])], { stdio: "ignore", windowsHide: true })
      killer.on("error", () => fallback(signal))
      killer.unref()
    } catch {
      fallback(signal)
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    fallback(signal)
  }
}
