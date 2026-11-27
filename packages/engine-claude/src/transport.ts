/** JSONL over the stdio of one `claude` process. stderr is kept as a short tail for error messages. */
export type ClaudeTransport = {
  write(line: string): void
  lines: AsyncIterable<string>
  close(): void
  exited: Promise<number>
  /** The operating-system process id, when there is a real process behind this transport. */
  pid?: number | undefined
  stderrTail(): string
}

const STDERR_TAIL = 4_000

/**
 * What `claudeCacheTtl` adds to the Claude Code process: with `promptCacheTtl: "1h"`, the two variables Claude Code documents
 * (code.claude.com/docs/en/prompt-caching, "Choose the TTL yourself"; v2.1.242 or later) for the main conversation and for
 * everything else (sub-agents, workflows, compaction). Nothing at `5m`: Claude Code keeps its own defaults, which on a
 * subscription already give the main conversation an hour.
 */
export function claudeCacheEnv(settings: { claudeCacheTtl?: boolean | undefined; promptCacheTtl?: "5m" | "1h" | undefined }): Record<string, string> | undefined {
  if (settings.claudeCacheTtl !== true || settings.promptCacheTtl !== "1h") return undefined
  return { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" }
}

/** The longest wait a Claude Code timer accepts (a 32-bit setTimeout), about 24.8 days: past it the timer fires at once. */
export const CLAUDE_MAX_TIMEOUT_MS = 2_147_483_647

/**
 * `BASH_MAX_TIMEOUT_MS` for the Claude Code process: how long its Bash may run in the background before it stops it ("stopped after
 * reaching its background time limit"). With no `processLimits.lifetimeMinutes` it is the largest value Claude Code takes, so a command
 * runs until it ends or is stopped; with one, that many minutes. Nothing when the user already set the variable in the daemon's
 * environment. `BASH_DEFAULT_TIMEOUT_MS` is left alone: a foreground command keeps its default.
 */
export function claudeBackgroundEnv(options: { lifetimeMinutes?: number | undefined; inherited?: string | undefined }): Record<string, string> | undefined {
  if (options.inherited) return undefined
  const minutes = options.lifetimeMinutes
  const ms = minutes !== undefined && minutes > 0 ? Math.min(Math.round(minutes * 60_000), CLAUDE_MAX_TIMEOUT_MS) : CLAUDE_MAX_TIMEOUT_MS
  return { BASH_MAX_TIMEOUT_MS: String(ms) }
}

/** The child's environment: the daemon's own, with `extra` on top. Undefined (inherit) when there is nothing to add. */
export function claudeProcessEnv(extra: Record<string, string> | undefined, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> | undefined {
  return extra && Object.keys(extra).length ? { ...base, ...extra } : undefined
}

export function spawnClaude(options: { bin: string; args: string[]; cwd: string; env?: Record<string, string> | undefined }): ClaudeTransport {
  const env = claudeProcessEnv(options.env)
  const proc = Bun.spawn([options.bin, ...options.args], { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) })
  let tail = ""
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL)
  })().catch(() => {})
  // The text of an unfinished line is kept as chunks and joined once its newline arrives: appending to one string and searching it
  // again at every read copied a long line (a tool result with an image) once per chunk, about 30 MB of peak RSS for a 2 MB line.
  async function* lines() {
    const decoder = new TextDecoder()
    let pending: string[] = []
    for await (const chunk of proc.stdout) {
      let text = decoder.decode(chunk, { stream: true })
      let newline = text.indexOf("\n")
      while (newline >= 0) {
        const line = pending.length ? pending.join("") + text.slice(0, newline) : text.slice(0, newline)
        pending = []
        text = text.slice(newline + 1)
        if (line.trim()) yield line
        newline = text.indexOf("\n")
      }
      if (text) pending.push(text)
    }
  }
  return {
    write(line) {
      proc.stdin.write(`${line}\n`)
      proc.stdin.flush()
    },
    lines: lines(),
    close: () => proc.kill(),
    exited: proc.exited,
    pid: proc.pid,
    stderrTail: () => tail.trim(),
  }
}
