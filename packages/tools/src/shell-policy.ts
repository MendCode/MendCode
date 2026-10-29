/**
 * What the model's shell commands inherit and how they start (settings `shellEnvironment`, `shellCommandPrefix`, `loginShell`).
 * Pure: the engine applies the environment before the permission review sees it, the shell launchers apply the rest.
 */
export type ShellEnvironmentPolicy = {
  inherit?: "all" | "core" | "none" | undefined
  exclude?: readonly string[] | undefined
  includeOnly?: readonly string[] | undefined
  set?: Readonly<Record<string, string>> | undefined
  keepSecrets?: boolean | undefined
}

export type ShellPolicy = {
  /** Text run before the command, in the same shell. */
  prefix?: string | undefined
  /** POSIX shells only: start the shell with `-l`. */
  login?: boolean | undefined
}

const CORE_NAMES = [
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_*", "TERM", "TMPDIR", "TEMP", "TMP", "TZ", "PWD",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA",
]
/** Names that look like credentials; dropped whenever a policy is set, unless `keepSecrets`. */
const SECRET_NAMES = ["*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*", "*CREDENTIAL*"]

function matcher(patterns: readonly string[]) {
  const expressions = patterns.map((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"))
  return (name: string) => expressions.some((expression) => expression.test(name))
}

/** The environment a command gets under `policy`; `base` itself when there is no policy. */
export function applyShellEnvironment(base: NodeJS.ProcessEnv, policy: ShellEnvironmentPolicy | undefined): NodeJS.ProcessEnv {
  if (!policy) return base
  const inherit = policy.inherit ?? "all"
  const core = matcher(CORE_NAMES)
  const only = policy.includeOnly?.length ? matcher(policy.includeOnly) : undefined
  const secret = policy.keepSecrets ? undefined : matcher(SECRET_NAMES)
  const excluded = policy.exclude?.length ? matcher(policy.exclude) : undefined
  const out: NodeJS.ProcessEnv = {}
  if (inherit !== "none") {
    for (const [name, value] of Object.entries(base)) {
      if (value === undefined) continue
      if (inherit === "core" && !core(name)) continue
      if (only && !only(name)) continue
      if (secret?.(name) || excluded?.(name)) continue
      out[name] = value
    }
  }
  for (const [name, value] of Object.entries(policy.set ?? {})) out[name] = value
  return out
}

/** `command` with the policy's prefix in front; unchanged without one. */
export function withShellPrefix(command: string, policy: ShellPolicy | undefined) {
  return policy?.prefix ? `${policy.prefix}\n${command}` : command
}
