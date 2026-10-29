import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { modelContextOf, REASONING_EFFORTS, type ModelChoice, type ModelInfo, type ReasoningEffort, type Settings } from "@mendcode/protocol"

/** Claude Code's user settings, where `effortLevel` names the level its sessions run at when none is asked for. */
export const CLAUDE_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "settings.json")

const isEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)

/**
 * Claude Code models, by the CLI's own aliases so they always mean the latest of each family. They appear in the
 * catalog only when `claude --version` works, and a session that picks one runs on Claude Code (`engine: "claude"`).
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-fable", name: "Claude Fable · Claude Code", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 200_000, engine: "claude" },
  { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 200_000, engine: "claude" },
  { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 200_000, engine: "claude" },
  { id: "claude-haiku", name: "Claude Haiku · Claude Code", efforts: [], contextWindow: 200_000, engine: "claude" },
]

/**
 * `CLAUDE_MODELS` carrying the user's own Claude Code effort (`effortLevel` in its settings) as default, so the footer names the
 * level a session really runs at, as it does for a Codex model. Re-read only when the file changes; without a level the model supports,
 * the models carry none and Claude Code decides.
 */
export function createClaudeModelCatalog(file = CLAUDE_SETTINGS) {
  let cached: { mtimeMs: number; models: ModelInfo[] } | undefined
  return function list(): ModelInfo[] {
    try {
      const { mtimeMs } = statSync(file)
      if (cached?.mtimeMs !== mtimeMs) {
        const level = (JSON.parse(readFileSync(file, "utf8")) as { effortLevel?: unknown } | null)?.effortLevel
        cached = { mtimeMs, models: CLAUDE_MODELS.map((model) => (isEffort(level) && model.efforts.includes(level) ? { ...model, defaultEffort: level } : model)) }
      }
      return cached.models
    } catch {
      return CLAUDE_MODELS
    }
  }
}

/**
 * What `claude --model` takes: `claude-opus` → `opus` (its alias for the newest of the family); a full id
 * (`claude-haiku-5-5`, `claude-haiku-4-5-20251001`) is passed as it is, so the session runs exactly that model.
 */
export function claudeAlias(choice: ModelChoice): { model: string; effort?: ModelChoice["effort"] } {
  const model = /^claude-[a-z]+$/.test(choice.model) ? choice.model.slice("claude-".length) : choice.model
  return { model, ...(choice.effort ? { effort: choice.effort } : {}) }
}

/**
 * `CLAUDE_CODE_SUBAGENT_MODEL` for a Claude Code process, which its Agent tool's sub-agents run on: the `subagent` role when
 * it names a Claude Code model; else, with `cheap_subagents`, Sonnet under an Opus or Fable session. Nothing when the
 * daemon's own environment already sets it, or a session on Sonnet or Haiku keeps its sub-agents on its own model.
 */
export function claudeSubagentEnv(input: { model: string | undefined; subagent: ModelChoice | undefined; cheap: boolean; inherited?: string | undefined }): Record<string, string> | undefined {
  if (input.inherited) return undefined
  if (input.subagent?.model.startsWith("claude-")) return { CLAUDE_CODE_SUBAGENT_MODEL: claudeAlias(input.subagent).model }
  return input.cheap && /opus|fable/i.test(input.model ?? "") ? { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } : undefined
}

/** Where Claude Code compacts under `claude_compact` when no absolute MendCode point is set: a 1M window re-read on every call is what spends a plan. */
export const CLAUDE_COMPACT_WINDOW = 200_000

/**
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for a Claude Code process: the absolute compaction point MendCode's own models use
 * (`MENDCODE_COMPACT_AT_TOKENS`, the model's `modelContext.compactAt`, `compactAtTokens`, `compaction.token_limit`), else
 * `CLAUDE_COMPACT_WINDOW`. Claude Code compacts a summary's room before that window. Nothing with the feature off, or when the
 * daemon's own environment already sets the variable.
 */
export function claudeCompactEnv(input: { model: string | undefined; settings: Pick<Settings, "compactAtTokens" | "compaction" | "modelContext">; on: boolean; environment?: NodeJS.ProcessEnv }): Record<string, string> | undefined {
  const environment = input.environment ?? process.env
  if (!input.on || environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return undefined
  const info = CLAUDE_MODELS.find((model) => model.id === input.model || model.id === `claude-${input.model}`)
  const fromEnvironment = Number(environment.MENDCODE_COMPACT_AT_TOKENS)
  const tokens = (fromEnvironment > 0 ? fromEnvironment : undefined) ?? modelContextOf(input.settings, info)?.compactAt ?? input.settings.compactAtTokens ?? input.settings.compaction?.token_limit ?? CLAUDE_COMPACT_WINDOW
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(tokens)) }
}

export type ClaudeDetection = {
  /** Whether Claude Code answered its probe; false until it has. Synchronous, for the catalog's `list()`. */
  installed(): boolean
  /** Resolves once the answer to "is Claude Code here" is current: waits for a probe in flight, and asks again when a negative answer is older than `recheckMs`. Never throws. */
  refresh(): Promise<void>
}

/**
 * Whether the user's `claude` is installed, learned from a probe that takes a moment. The probe starts with the daemon, and a
 * request that arrives before it ends waits for it, so a report never omits the Claude Code models only because it was asked first.
 * A negative answer (the probe timed out on a busy machine, `claude` was not on the path yet) is asked again later instead of
 * holding until the next restart; a positive one stays.
 */
export function createClaudeDetection(input: { probe: () => Promise<{ ok: boolean }>; now?: () => number; recheckMs?: number }): ClaudeDetection {
  const now = input.now ?? Date.now
  const recheckMs = input.recheckMs ?? 10_000
  let installed = false
  let askedAt: number | undefined
  let pending: Promise<void> | undefined
  const refresh = () => {
    if (pending) return pending
    if (installed || (askedAt !== undefined && now() - askedAt < recheckMs)) return Promise.resolve()
    pending = input.probe().then((probe) => { installed = probe.ok }, () => { installed = false }).finally(() => { askedAt = now(); pending = undefined })
    return pending
  }
  return { installed: () => installed, refresh }
}

/** Whether the user's `claude` answers `--version` like Claude Code, within two seconds. Never throws. */
export async function probeClaude(bin = "claude"): Promise<{ ok: true; version: string } | { ok: false }> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => proc.kill(), 2_000)
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    const version = text.trim()
    return code === 0 && /claude code/i.test(version) ? { ok: true, version } : { ok: false }
  } catch {
    return { ok: false }
  }
}
