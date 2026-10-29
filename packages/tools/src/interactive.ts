/** What the model sees of one interactive process (a command running on a pseudo-terminal). */
export type InteractiveInfo = {
  id: string
  command: string
  cwd: string
  status: "running" | "exited" | "killed"
  exitCode?: number
  startedAt: number
  endedAt?: number
  cols: number
  rows: number
  /** Why a session was killed: by the agent, the idle timeout, the lifetime cap, or cleanup (session deleted, daemon stopping). */
  killedBy?: "agent" | "idle" | "lifetime" | "cleanup"
}

/** New output since the last read, capped. `dropped` counts characters that scrolled out of the bounded buffer unread; `remaining` is still waiting for the next read. */
export type InteractiveRead = { session: InteractiveInfo; output: string; dropped: number; remaining: number }

export type InteractiveSignal = "INT" | "TERM" | "HUP" | "QUIT" | "KILL" | "EOF"

export type InteractiveResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** A session's view of the registry: it only sees and controls the processes it started. */
export type InteractivePort = {
  start(input: { command: string; cwd: string; shell?: string; environment?: Readonly<NodeJS.ProcessEnv>; sandbox?: import("./sandbox").SandboxPolicy; policy?: import("./shell-policy").ShellPolicy; cols?: number; rows?: number }): InteractiveResult<{ session: InteractiveInfo }>
  write(id: string, data: string): InteractiveResult<{ session: InteractiveInfo }>
  /** Waits for output to arrive and settle (or the exit) for at most `waitMs`, then returns at most `maxChars` of what is unread; undefined for an unknown id. */
  read(id: string, options: { waitMs: number; maxChars: number; signal: AbortSignal }): Promise<InteractiveRead | undefined>
  resize(id: string, cols: number, rows: number): InteractiveResult<{ session: InteractiveInfo }>
  signal(id: string, signal: InteractiveSignal): InteractiveResult<{ session: InteractiveInfo }>
  kill(id: string): InteractiveInfo | undefined
  list(): InteractiveInfo[]
}

export const INTERACTIVE_LIMITS = {
  /** Running sessions across all chat sessions (a small machine must stay responsive). */
  maxRunning: 8,
  /** Running sessions one chat session may own. */
  maxPerSession: 4,
  /** Output kept per session; older output scrolls out unread. */
  maxBufferChars: 256_000,
  /** Characters one `read` returns. */
  defaultReadChars: 10_000,
  maxReadChars: 50_000,
  /** One `write` may carry this much input. */
  maxWriteChars: 16_384,
  /** No tool call touched a session for this long: it is stopped. */
  idleMs: 15 * 60 * 1_000,
  /** A session still running after this long is stopped. */
  maxLifetimeMs: 2 * 60 * 60 * 1_000,
  /** Finished sessions kept readable; the oldest are forgotten first. */
  maxFinished: 16,
  minSize: 1,
  maxSize: 1_000,
} as const
