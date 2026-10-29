/** Shared shapes of the evaluation kit. A `null` metric means "this harness cannot report it", never zero. */

export type Usage = {
  /** All prompt tokens billed across the model calls, cached ones included. */
  inputTokens: number | null
  /** Prompt tokens served from the provider's cache. */
  cachedReadTokens: number | null
  /** Prompt tokens written to a cache (only some providers report it). */
  cacheWriteTokens: number | null
  /** Completion tokens, reasoning included (OpenAI semantics). */
  outputTokens: number | null
  /** The reasoning part of `outputTokens`, when reported separately. */
  reasoningTokens: number | null
  modelCalls: number | null
  toolCalls: number | null
  failedToolCalls: number | null
  compactions: number | null
  /** Duration of the turn as the harness's own events report it (not every harness has one). */
  turnMs: number | null
}

export const USAGE_KEYS = ["inputTokens", "cachedReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "modelCalls", "toolCalls", "failedToolCalls", "compactions", "turnMs"] as const satisfies readonly (keyof Usage)[]

export function emptyUsage(): Usage {
  return { inputTokens: null, cachedReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, modelCalls: null, toolCalls: null, failedToolCalls: null, compactions: null, turnMs: null }
}

export type RunResult = {
  /** Exit code of the harness process; null when it was killed or never started. */
  exitCode: number | null
  timedOut: boolean
  /** Raw event stream of the run, absolute path; null when none was captured. */
  transcriptPath: string | null
  usage: Usage
  /** Wall time of the harness invocation itself (process start to exit), in milliseconds. */
  agentMs: number
  /** Human-readable remarks about what could not be measured or went wrong. */
  notes: string[]
}

export type TaskMeta = { category: string; expectedSteps: number; timeoutSeconds: number }

export type Task = {
  id: string
  dir: string
  repoDir: string
  prompt: string
  meta: TaskMeta
  checkScript: string
  checkDir: string
  solutionPatch: string
}

export type PrepareContext = {
  task: Task
  /** Directory for this run's artifacts (transcripts, logs). Exists. */
  runDir: string
  effort: string
  timeoutMs: number
}

export type AdapterOptions = {
  /** Mendcode: root of dedicated data directories (one subdirectory per run). */
  dataDir?: string
  /** Directory that holds an existing `auth.json` (and `models_cache.json`) to link into the isolated home, read-only. */
  authFrom?: string
  /** Mendcode: executable that starts the product CLI, as an argv prefix. Default: `bun <repo>/apps/cli/src/entry.ts`. */
  mendcodeCommand?: string[]
  /** Mendcode: argv prefix that starts the daemon. Default: `bun <repo>/packages/daemon/src/main.ts`. */
  daemonCommand?: string[]
  /** Mendcode: the tier the data dir runs at, with that tier's prompt mode. Default balanced (prompt mode focus). */
  tier?: "minimalist" | "balanced" | "full"
  /** Mendcode: daemon engine. `native` for real runs; `faux` only for kit tests (no provider, no model flag). */
  engine?: "native" | "faux" | "claude"
  /** Claude Code executable (the `claude-code` adapter and the mendcode adapter's `claude` engine). Default `claude` from PATH. */
  claudeBin?: string
  /** Codex: executable. Default `codex` from PATH. */
  codexBin?: string
  /** Fake adapter: which tasks it solves (`all`, `none` or a comma list of ids) and how it behaves. */
  fakeSolve?: string
  fakeMode?: "normal" | "hang" | "crash"
}

export interface HarnessAdapter {
  readonly name: string
  /** Builds the isolated state for ONE run (home, data dir, auth links). Must not start a model call. */
  prepare(context: PrepareContext): Promise<void>
  run(prompt: string, cwd: string, model: string): Promise<RunResult>
  /** Stops anything `run` started and removes the isolated state. Safe to call twice. */
  cleanup(): Promise<void>
  /** Free-form facts for the manifest (versions, flags); may spawn only `--version`-style probes. */
  describe(): Promise<Record<string, string>>
}

export type DiffStats = { filesChanged: number; insertions: number; deletions: number }

export type CheckResult = { exitCode: number | null; timedOut: boolean; durationMs: number; logTail: string }

export type RunRecord = {
  harness: string
  model: string
  effort: string
  taskId: string
  category: string
  repeat: number
  startedAt: string
  /** Wall time of `adapter.run` as seen by the runner. */
  wallMs: number
  /** Wall time of the harness invocation as measured by the adapter. */
  agentMs: number
  timedOut: boolean
  exitCode: number | null
  solved: boolean
  /** `solved`, `failed` (check red), `timeout` or `error` (the harness itself failed before producing work). */
  outcome: "solved" | "failed" | "timeout" | "error"
  check: CheckResult
  usage: Usage
  diff: DiffStats
  transcript: string | null
  notes: string[]
}
