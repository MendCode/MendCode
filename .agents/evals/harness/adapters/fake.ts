import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { git } from "../lib/workspace"
import type { AdapterOptions, HarnessAdapter, PrepareContext, RunResult, Usage } from "../lib/types"

function hash(text: string): number {
  let value = 2166136261
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0
  return value
}

/** Deterministic synthetic usage so the whole pipeline (runner, parsers, report) can be exercised offline. */
export function syntheticUsage(taskId: string, model: string): Usage {
  const seed = hash(`${taskId}:${model}`)
  const input = 8_000 + (seed % 9_000)
  const cached = Math.floor(input * (0.4 + ((seed >> 8) % 40) / 100))
  return {
    inputTokens: input,
    cachedReadTokens: cached,
    cacheWriteTokens: null,
    outputTokens: 400 + (seed % 700),
    reasoningTokens: 100 + (seed % 200),
    modelCalls: 3 + (seed % 4),
    toolCalls: 4 + (seed % 9),
    failedToolCalls: seed % 3,
    compactions: seed % 7 === 0 ? 1 : 0,
    turnMs: 2_000 + (seed % 5_000),
  }
}

/**
 * No model, no network, no real harness. `solve` applies the task's reference `solution.patch`; `none` changes nothing.
 * Modes: `normal`, `hang` (sleeps past the timeout, like a stuck harness) and `crash` (exits 1 without work).
 */
export function createFakeAdapter(options: AdapterOptions): HarnessAdapter {
  let context: PrepareContext | undefined
  const solveSpec = options.fakeSolve ?? "all"

  const solves = (taskId: string) => solveSpec === "all" || (solveSpec !== "none" && solveSpec.split(",").map((id) => id.trim()).includes(taskId))

  return {
    name: "fake",
    async prepare(next) {
      context = next
    },
    async run(prompt, cwd, model): Promise<RunResult> {
      if (!context) throw new Error("[FAKE]: prepare() was not called")
      const started = Date.now()
      const notes = ["fake adapter: synthetic usage, no model was called"]
      const transcriptPath = path.join(context.runDir, "transcript.jsonl")
      writeFileSync(transcriptPath, `${JSON.stringify({ type: "fake.prompt", chars: prompt.length, model })}\n`)
      const mode = options.fakeMode ?? "normal"
      if (mode === "hang") {
        await new Promise((resolve) => setTimeout(resolve, context!.timeoutMs + 50))
        return { exitCode: null, timedOut: true, transcriptPath, usage: syntheticUsage(context.task.id, model), agentMs: Date.now() - started, notes }
      }
      if (mode === "crash") return { exitCode: 1, timedOut: false, transcriptPath, usage: { ...syntheticUsage(context.task.id, model), inputTokens: null, outputTokens: null, cachedReadTokens: null }, agentMs: Date.now() - started, notes: [...notes, "fake crash"] }
      if (solves(context.task.id)) {
        if (!existsSync(context.task.solutionPatch)) throw new Error(`[FAKE]: ${context.task.id} has no solution.patch`)
        const applied = await git(cwd, ["apply", "--whitespace=nowarn", context.task.solutionPatch])
        if (applied.exitCode !== 0) notes.push("solution.patch did not apply")
      }
      return { exitCode: 0, timedOut: false, transcriptPath, usage: syntheticUsage(context.task.id, model), agentMs: Date.now() - started, notes }
    },
    async cleanup() {},
    async describe() {
      return { adapter: "fake", solve: solveSpec, mode: options.fakeMode ?? "normal" }
    },
  }
}
