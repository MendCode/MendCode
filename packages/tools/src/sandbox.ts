import { existsSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * OS sandbox for the commands the agent runs (`shell`, background tasks, `shell_session`): macOS Seatbelt
 * (`sandbox-exec`) or Linux bubblewrap (`bwrap`). Reads stay open; writes are confined to the project (workspace-write)
 * or refused (read-only); the network is off unless allowed. It sits under the permission rules, never in place of them.
 * Pure and spawn-free: it only turns an argv into a wrapped argv. Landlock needs a native helper and is not used.
 */
export const SANDBOX_MODES = ["off", "read-only", "workspace-write"] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]
export const SANDBOX_NETWORKS = ["off", "on"] as const
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number]

/** The `sandbox` setting. Unset or `off` runs commands unconfined, as before. */
export type SandboxConfig = { mode?: SandboxMode | undefined; network?: SandboxNetwork | undefined; writableRoots?: readonly string[] | undefined }

export type SandboxPolicy = {
  mode: Exclude<SandboxMode, "off">
  network: boolean
  /** Real paths writable by the command (empty in read-only). */
  writable: string[]
  /** Real paths that stay read-only even inside a writable root: they would run later outside the sandbox. */
  protect: string[]
}

export type SandboxBackend = { name: "seatbelt" | "bwrap"; binary: string }

/** Paths under a writable root that a command could use to get code run later without the sandbox. */
const PROTECTED_IN_ROOT = [".git/hooks", ".git/config", ".mendcode"] as const
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"] as const
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/run/current-system/sw/bin/bwrap"] as const

function real(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

export function sandboxBackend({ platform = process.platform, exists = existsSync }: { platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): SandboxBackend | undefined {
  if (platform === "darwin") return exists("/usr/bin/sandbox-exec") ? { name: "seatbelt", binary: "/usr/bin/sandbox-exec" } : undefined
  if (platform === "linux") {
    const found = [...BWRAP_CANDIDATES, ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "bwrap"))].find((file) => exists(file))
    return found ? { name: "bwrap", binary: found } : undefined
  }
  return undefined
}

/** The policy a session's commands run under, or undefined when the sandbox is off. */
export function sandboxPolicy({ config, cwd, temp: tempRoots = [os.tmpdir(), ...TEMP_ROOTS] }: { config: SandboxConfig | undefined; cwd: string; /** Temp directories writable in workspace-write; tests pass none. */ temp?: readonly string[] }): SandboxPolicy | undefined {
  const mode = config?.mode ?? "off"
  if (mode === "off") return undefined
  const network = config?.network === "on"
  if (mode === "read-only") return { mode, network, writable: [], protect: [] }
  const extra = (config?.writableRoots ?? []).filter((root) => path.isAbsolute(root)).map(real)
  const temp = tempRoots.filter((dir) => existsSync(dir)).map(real)
  const roots = [...new Set([real(cwd), ...extra])]
  const protect = roots.flatMap((root) => PROTECTED_IN_ROOT.map((child) => path.join(root, child)))
  return { mode, network, writable: [...new Set([...roots, ...temp])], protect }
}

export function describeSandbox(policy: Pick<SandboxPolicy, "mode" | "network">): string {
  return `${policy.mode}, network ${policy.network ? "on" : "off"}`
}

function seatbeltString(value: string): string {
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error("path has control characters")
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Seatbelt rules: everything allowed, then writes denied except the roots, then the protected paths denied again (last match wins). */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)", '(allow file-write* (subpath "/dev"))']
  if (policy.writable.length) lines.push(`(allow file-write* ${policy.writable.map((root) => `(subpath ${seatbeltString(root)})`).join(" ")})`)
  if (policy.protect.length) lines.push(`(deny file-write* ${policy.protect.map((root) => `(subpath ${seatbeltString(root)})`).join(" ")})`)
  if (!policy.network) lines.push("(deny network*)")
  return lines.join("\n")
}

export function bwrapArguments({ policy, interactive = false, exists = existsSync }: { policy: SandboxPolicy; interactive?: boolean; exists?: (file: string) => boolean }): string[] {
  const args = ["--die-with-parent", "--unshare-user", "--unshare-pid", ...(policy.network ? [] : ["--unshare-net"]), ...(interactive ? [] : ["--new-session"]), "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
  for (const root of policy.writable) if (exists(root)) args.push("--bind", root, root)
  for (const root of policy.protect) if (exists(root)) args.push("--ro-bind", root, root)
  return args
}

export type SandboxedCommand = { ok: true; argv: string[] } | { ok: false; error: string }

/** `argv` wrapped for the platform's sandbox. Fails closed: with a policy and no usable backend nothing is returned to run. */
export function sandboxCommand({ argv, policy, interactive, backend: given }: { argv: string[]; policy: SandboxPolicy | undefined; interactive?: boolean; /** Tests: `null` means this system has none; omitted detects it. */ backend?: SandboxBackend | null }): SandboxedCommand {
  const backend = given === undefined ? sandboxBackend() : given
  if (!policy) return { ok: true, argv }
  if (!backend) return { ok: false, error: `sandbox ${policy.mode} is on but this system has no sandbox backend (macOS sandbox-exec or Linux bwrap). Run /sandbox off to run commands unconfined.` }
  try {
    if (backend.name === "seatbelt") return { ok: true, argv: [backend.binary, "-p", seatbeltProfile(policy), ...argv] }
    return { ok: true, argv: [backend.binary, ...bwrapArguments({ policy, ...(interactive ? { interactive } : {}) }), "--", ...argv] }
  } catch (error) {
    return { ok: false, error: `sandbox ${policy.mode}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const BLOCKED = /operation not permitted|read-only file system|could not resolve host|network is unreachable|temporary failure in name resolution|\b(?:EPERM|EROFS|ENETUNREACH|EAI_AGAIN|ENOTFOUND)\b/i

/** A short note for a failed command whose output looks like a sandbox refusal; empty otherwise. */
export function sandboxHint({ output, policy }: { output: string; policy: Pick<SandboxPolicy, "mode" | "network"> }): string {
  return BLOCKED.test(output) ? `[sandbox ${describeSandbox(policy)}: this may be the sandbox. The user can change it with /sandbox]` : ""
}
