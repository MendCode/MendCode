import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAdapter, type HarnessName } from "../adapters"
import { runCheck } from "./check"
import type { AdapterOptions, HarnessAdapter, RunRecord, Task } from "./types"
import { emptyUsage } from "./types"
import { collectDiff, createWorkspace, removeKitTree } from "./workspace"

export type RunOptions = {
  outDir: string
  effort: string
  /** Multiplies every task's `timeoutSeconds`. */
  timeoutScale: number
  adapterOptions: AdapterOptions
  keepWork: boolean
  /** Skip runs whose `result.json` already exists. */
  resume: boolean
  /** Test seam: replaces adapter construction. */
  adapterFactory?: (name: HarnessName, options: AdapterOptions) => Promise<HarnessAdapter>
  log?: (line: string) => void
}

export const runDirFor = (outDir: string, model: string, harness: string, taskId: string, repeat: number) => path.join(outDir, model.replace(/[^\w.-]/g, "_"), harness, taskId, `r${repeat}`)

function classify(input: { timedOut: boolean; exitCode: number | null; solved: boolean; producedWork: boolean; hadUsage: boolean }): RunRecord["outcome"] {
  if (input.solved) return "solved"
  if (input.timedOut) return "timeout"
  // The harness itself broke (did not start, crashed, no events) before changing anything.
  if (input.exitCode === null || (input.exitCode !== 0 && !input.producedWork && !input.hadUsage)) return "error"
  return "failed"
}

/** One run: fresh workspace and isolated harness state, the agent, then the hidden check from outside. Always writes `result.json`. */
export async function runOne(input: { harness: HarnessName; model: string; task: Task; repeat: number }, options: RunOptions): Promise<RunRecord> {
  const { harness, model, task, repeat } = input
  const runDir = runDirFor(options.outDir, model, harness, task.id, repeat)
  mkdirSync(runDir, { recursive: true })
  const resultPath = path.join(runDir, "result.json")
  if (options.resume && existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, "utf8")) as RunRecord

  const timeoutMs = Math.round(task.meta.timeoutSeconds * options.timeoutScale * 1000)
  const startedAt = new Date().toISOString()
  const workspace = await createWorkspace(task)
  const factory = options.adapterFactory ?? createAdapter
  const adapter = await factory(harness, options.adapterOptions)
  writeFileSync(path.join(runDir, "prompt.md"), `${task.prompt}\n`)
  let record: RunRecord
  try {
    await adapter.prepare({ task, runDir, effort: options.effort, timeoutMs })
    const wallStart = Date.now()
    let result
    try {
      result = await adapter.run(task.prompt, workspace.cwd, model)
    } catch (error) {
      result = { exitCode: null, timedOut: false, transcriptPath: null, usage: emptyUsage(), agentMs: 0, notes: [`adapter threw: ${error instanceof Error ? error.message : String(error)}`] }
    }
    const wallMs = Date.now() - wallStart
    const diff = await collectDiff(workspace, path.join(runDir, "work.diff"))
    const check = await runCheck(task, workspace.cwd, { logPath: path.join(runDir, "check.log") })
    const solved = check.exitCode === 0 && !check.timedOut
    let transcript: string | null = null
    if (result.transcriptPath && existsSync(result.transcriptPath)) {
      transcript = path.relative(options.outDir, result.transcriptPath)
      if (!path.resolve(result.transcriptPath).startsWith(path.resolve(runDir))) {
        const copy = path.join(runDir, "transcript.jsonl")
        copyFileSync(result.transcriptPath, copy)
        transcript = path.relative(options.outDir, copy)
      }
    }
    record = {
      harness, model, effort: options.effort, taskId: task.id, category: task.meta.category, repeat, startedAt,
      wallMs, agentMs: result.agentMs, timedOut: result.timedOut, exitCode: result.exitCode, solved,
      outcome: classify({ timedOut: result.timedOut, exitCode: result.exitCode, solved, producedWork: diff.filesChanged > 0, hadUsage: result.usage.inputTokens !== null }),
      check, usage: result.usage, diff, transcript, notes: result.notes,
    }
  } finally {
    await adapter.cleanup()
    if (!options.keepWork) removeKitTree(workspace.root)
  }
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export function describeRun(record: RunRecord): string {
  const u = record.usage
  const tokens = u.inputTokens === null ? "tokens n/a" : `in=${u.inputTokens} (cached ${u.cachedReadTokens ?? "n/a"}) out=${u.outputTokens ?? "n/a"}`
  return `[${record.harness}/${record.model}] ${record.taskId} r${record.repeat} ${record.outcome.toUpperCase()} ${(record.wallMs / 1000).toFixed(1)}s ${tokens} tools=${u.toolCalls ?? "n/a"}`
}

export async function runMatrix(input: { harnesses: HarnessName[]; models: string[]; tasks: Task[]; repeat: number }, options: RunOptions): Promise<RunRecord[]> {
  const records: RunRecord[] = []
  const log = options.log ?? (() => {})
  for (const model of input.models) {
    for (const harness of input.harnesses) {
      for (const task of input.tasks) {
        for (let repeat = 1; repeat <= input.repeat; repeat++) {
          const record = await runOne({ harness, model, task, repeat }, options)
          records.push(record)
          log(describeRun(record))
        }
      }
    }
  }
  return records
}
