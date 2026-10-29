import type { PermissionConfig } from "./permissions"

/**
 * "Always allow" from an approval prompt: the rule a pending request would save. Pure and zod-free, so the daemon (which
 * writes the rule) and the terminal (which labels the choice) derive the same one from the request's permission context.
 */
export type ApprovalRule = { permission: string; pattern: string }
export type ApprovalRuleOffer = { label: string; rules: ApprovalRule[] }
export type ApprovalRuleLevel = "project" | "user"

/** Permissions that guard something else (a directory boundary, a repeat loop): never saved as a blanket allow. */
const GUARDS = new Set(["external_directory", "doom_loop"])
/** Programs that run what they are given or change what comes after them: `<head> *` would allow anything. */
const OPEN_ENDED = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "eval", "exec", "source", ".", "sudo", "doas", "su", "env", "xargs", "nohup", "time", "timeout", "command", "builtin", "nice", "watch", "find",
  "rm", "dd", "mkfs", "chmod", "chown", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "curl", "wget", "node", "deno", "python", "python3", "ruby", "perl", "php", "npx", "bunx", "pnpx", "osascript", "open", "awk", "sed", "tee", "kill", "pkill", "killall",
  "rg", "fd", "fdfind", "parallel", "tar", "zip", "busybox", "stdbuf", "flock", "chroot", "unshare", "setsid", "ionice", "taskset", "tmux", "screen", "expect", "script", "strace", "ltrace", "gdb", "lldb",
  "vim", "vi", "nvim", "view", "ex", "ed", "emacs", "nano", "less", "more", "man", "tsx", "ts-node", "lua", "luajit", "Rscript", "R", "java", "jshell", "swift", "tclsh", "pwsh", "powershell", "gawk", "mawk", "nawk", "pkexec", "runuser", "at", "batch", "xterm", "cmd",
])
/** Interpreters named with a version (`python3.12`, `ruby3.2`, `nodejs`): the same as the unversioned program. */
const VERSIONED_INTERPRETER = /^(?:python|pypy|ruby|perl|php|node|nodejs|lua|luajit|tclsh|bash|zsh|sh|dash|ksh)[\d.]*$/i
/** Git subcommands that run what they are given, or rewrite config that makes later git commands run something: never a blanket allow. */
const GIT_OPEN_ENDED = new Set(["config", "rebase", "bisect", "submodule", "filter-branch", "difftool", "mergetool", "daemon", "instaweb", "credential", "hook", "fast-import", "send-email", "request-pull"])
/** Programs whose first word is a subcommand: the prefix keeps it (`git status *`, not `git *`). */
const SUBCOMMANDS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "gh", "make", "pip", "pip3", "uv", "poetry", "brew", "systemctl", "terraform", "helm", "dotnet", "gradle", "mvn",
])
/** Subcommands that run a named script or program: the prefix keeps the name too (`pnpm run test *`). */
const RUNNERS = new Set(["run", "exec", "dlx", "x", "r", "create"])
const PLAIN_WORD = /^[A-Za-z][\w:.-]*$/
const DYNAMIC = /[`$]|<\(|>\(|[\r\n]/
const MAX_SEGMENTS = 4

/** The prefix rule of one simple command, or undefined when it must not become a blanket allow. */
function prefixOf(command: string): string | undefined {
  if (DYNAMIC.test(command)) return undefined
  const words = command.trim().split(/\s+/).filter(Boolean)
  const head = words[0]
  if (!head || !/^[A-Za-z][\w.+-]*$/.test(head) || OPEN_ENDED.has(head) || VERSIONED_INTERPRETER.test(head)) return undefined
  if (!SUBCOMMANDS.has(head)) return `${head} *`
  const sub = words[1]
  if (!sub || !PLAIN_WORD.test(sub) || (head === "git" && GIT_OPEN_ENDED.has(sub))) return undefined
  if (!RUNNERS.has(sub)) return `${head} ${sub} *`
  const target = words[2]
  return target && PLAIN_WORD.test(target) ? `${head} ${sub} ${target} *` : undefined
}

/**
 * What "always allow" would save for a pending approval, or undefined when none is safe: a command prefix for `bash`
 * (every command of a pipeline must have one), the whole tool for a file-changing tool, nothing for other commands.
 */
export function approvalRuleOffer(input: { name: string; permission?: "read" | "write" | "execute" | undefined; patterns: readonly string[] }): ApprovalRuleOffer | undefined {
  const { name } = input
  if (!name || GUARDS.has(name)) return undefined
  if (name === "bash") {
    if (!input.patterns.length || input.patterns.length > MAX_SEGMENTS) return undefined
    const prefixes: string[] = []
    for (const pattern of input.patterns) {
      const prefix = prefixOf(pattern)
      if (!prefix) return undefined
      if (!prefixes.includes(prefix)) prefixes.push(prefix)
    }
    return { label: prefixes.map((prefix) => `\`${prefix}\``).join(" and "), rules: prefixes.map((pattern) => ({ permission: "bash", pattern })) }
  }
  if (input.permission === "execute") return undefined
  return { label: name === "edit" ? "edits" : `\`${name}\``, rules: [{ permission: name, pattern: "*" }] }
}

/** `config` with `rules` allowed. A new pattern goes last (the last match wins) and a blanket `ask` or `deny` of the tool is replaced for that pattern only. */
export function withApprovalRules(config: PermissionConfig | undefined, rules: readonly ApprovalRule[]): PermissionConfig {
  type Action = "ask" | "allow" | "deny"
  const next: Record<string, Action | Record<string, Action>> = typeof config === "string" ? { "*": config } : structuredClone(config ?? {})
  for (const { permission, pattern } of rules) {
    const current = next[permission]
    if (current === "allow") continue
    const record: Record<string, Action> = typeof current === "string" ? { "*": current } : { ...(current ?? {}) }
    delete record[pattern]
    record[pattern] = "allow"
    next[permission] = record
  }
  return next
}
