/**
 * Variables Claude Code puts in the shells of its own tool calls, or on its own process (and so on every child of it). Read from the
 * Claude Code 2.1.314 binary: its shell environment (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
 * `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_INVOKED_SKILLS`), what it sets
 * on itself at start (`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`), and
 * `CLAUDE_CODE_SSE_PORT`, the IDE window a terminal belongs to, which Claude Code itself removes before it starts a detached process.
 * A daemon started from such a shell (an agent ran `mendcode session list` or `mendcode daemon restart`) would hand them to every
 * command and program its sessions start, and a Claude Code opened anywhere below would take itself for that session's child:
 * `CLAUDE_CODE_CHILD_SESSION` turns its transcript saving off. Settings a user exports on purpose (`ANTHROPIC_API_KEY`,
 * `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, cache lifetimes, `CLAUDE_CONFIG_DIR`…) are not in the list.
 */
export const HOST_SESSION_ENV = [
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT",
] as const

/**
 * Names a user may also set, dropped only with the value Claude Code gives them: `AI_AGENT` names Claude Code (`claude-code_<version>_agent`),
 * and in a shell carrying `CLAUDECODE` the `GIT_EDITOR=true` it forces (a commit without `-m` would end empty) and the `TRACEPARENT` of that
 * one tool call's span.
 */
const OWNED_VALUE_ENV = ["AI_AGENT", "GIT_EDITOR", "TRACEPARENT"] as const

/** Every name this module can drop: the only names a log line about it may carry. */
export const DROPPABLE_ENV: ReadonlySet<string> = new Set([...HOST_SESSION_ENV, ...OWNED_VALUE_ENV])

/** The names in `environment` that came from a Claude Code session, in a stable order. */
export function hostSessionEnvNames(environment: NodeJS.ProcessEnv): string[] {
  const fromClaudeShell = environment.CLAUDECODE === "1"
  const owned = (name: (typeof OWNED_VALUE_ENV)[number]) => {
    const value = environment[name]
    if (value === undefined) return false
    if (name === "AI_AGENT") return /^claude-code[_/]/.test(value)
    if (name === "GIT_EDITOR") return fromClaudeShell && value === "true"
    return fromClaudeShell
  }
  return [...HOST_SESSION_ENV.filter((name) => environment[name] !== undefined), ...OWNED_VALUE_ENV.filter(owned)]
}

/** Removes them from `environment` in place; returns the names that were set. */
export function dropHostSessionEnv(environment: NodeJS.ProcessEnv): string[] {
  const dropped = hostSessionEnvNames(environment)
  for (const name of dropped) delete environment[name]
  return dropped
}

/** A copy of `environment` without them, for a daemon this process starts. */
export function withoutHostSessionEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment }
  dropHostSessionEnv(copy)
  return copy
}

/** The flag a launcher passes so the daemon it started logs what was dropped on its behalf; names only, never values. */
export const DROPPED_ENV_FLAG = "--dropped-env"

/** `--dropped-env A,B` for the names dropped; nothing when none were. */
export function droppedEnvArgs(names: readonly string[]): string[] {
  return names.length ? [DROPPED_ENV_FLAG, names.join(",")] : []
}

/** The names of a `--dropped-env` value that this module could have dropped; anything else in it is ignored. */
export function parseDroppedEnv(value: string | undefined): string[] {
  return value ? value.split(",").filter((name) => DROPPABLE_ENV.has(name)) : []
}

/** The log line naming what was dropped (names only); undefined when nothing was. */
export function droppedEnvLog(names: readonly string[]): string | undefined {
  return names.length ? `[ENV]: dropped inherited Claude Code session variables: ${names.join(", ")}` : undefined
}

/** This program's arguments as the system started it: a compiled binary's `process.argv[1]` is its bundled entry, not an argument. */
export function ownArguments(argv: readonly string[] = process.argv, main: string = Bun.main): string[] {
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main) ? argv.slice(2) : argv.slice(1)
}

/**
 * Deleting a variable from `process.env` does not reach a child started without an explicit `env`: Bun 1.3 hands it the environment the
 * process started with (measured on 1.3.13 with `Bun.spawn` and `node:child_process`). So a process about to run a daemon restarts in
 * place (`execve`: same pid, terminal and file descriptors) without them, before it starts anything. `log` gets the line first, since the
 * restarted process has nothing left to report. Returns only when there was nothing to drop or the restart cannot be done (Windows, a C
 * library not found, the system refused); the caller then drops them from `process.env`, which every child given that environment honours.
 */
export async function restartWithoutHostSessionEnv(input: { args?: readonly string[]; log?: (line: string) => void; exec?: () => Promise<((file: string, args: readonly string[], env: Record<string, string | undefined>) => void) | undefined> } = {}): Promise<void> {
  const names = hostSessionEnvNames(process.env)
  if (!names.length) return
  const exec = await (input.exec ?? (async () => (await import("./self-exec")).selfExec()))()
  if (!exec) return
  input.log?.(droppedEnvLog(names)!)
  exec(process.execPath, input.args ?? ownArguments(), withoutHostSessionEnv(process.env))
}
