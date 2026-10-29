#!/usr/bin/env bun
/**
 * Runs the harness evaluation: the same tasks, model, effort, sandbox and timeouts through MendCode's native engine
 * and/or the official Codex CLI, then checks every result from outside.
 *
 *   bun .agents/evals/harness/run.ts --harness mendcode|codex|fake[,..] --model <id>[,..] --tasks <ids|all> --repeat N --out <dir> [--effort medium]
 *
 * Extra options: --data-dir <dir>      mendcode: dedicated empty directory for the product's state (never ~/.mendcode*)
 *                --auth-from <dir>     directory holding an existing auth.json to link, read-only, into the isolated home
 *                --timeout-scale <x>   multiplies each task's timeoutSeconds (default 1)
 *                --resume              skip runs whose result.json already exists
 *                --keep-work           keep each run's working directory (for debugging)
 *                --dry-run             print the plan and exit
 *                --codex-bin <path>    codex executable (default: codex from PATH)
 *                --mendcode-bin <cmd>  product CLI argv prefix, space separated (default: bun apps/cli/src/entry.ts)
 *                --daemon-bin <cmd>    daemon argv prefix, space separated (default: bun packages/daemon/src/main.ts)
 *                --fake-solve <ids>    fake adapter only: all | none | comma list (default all)
 *                --fake-mode <mode>    fake adapter only: normal | hang | crash
 *                --engine <name>       mendcode only: native (default) or faux (kit tests; no model flag, no credentials)
 *                --tier <name>         mendcode only: minimalist | balanced | full with that tier's prompt mode (default balanced, focus)
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { HARNESS_NAMES, createAdapter, isHarnessName, type HarnessName } from "./adapters"
import { intFlag, listFlag, parseArgs, rejectUnknown, requiredFlag, stringFlag } from "./lib/args"
import { runMatrix } from "./lib/runner"
import { selectTasks } from "./lib/tasks"
import type { AdapterOptions } from "./lib/types"

const KNOWN = ["harness", "model", "tasks", "repeat", "out", "effort", "data-dir", "auth-from", "timeout-scale", "resume", "keep-work", "dry-run", "codex-bin", "mendcode-bin", "daemon-bin", "fake-solve", "fake-mode", "engine", "tier"]
const TIERS = ["minimalist", "balanced", "full"] as const

export function parseRunArgs(argv: string[]) {
  const args = parseArgs(argv, ["resume", "keep-work", "dry-run"])
  rejectUnknown(args, KNOWN)
  const harnesses = listFlag(args, "harness") ?? []
  if (harnesses.length === 0) throw new Error("--harness is required")
  for (const harness of harnesses) if (!isHarnessName(harness)) throw new Error(`unknown harness ${harness}; choose ${HARNESS_NAMES.join(", ")}`)
  const models = listFlag(args, "model") ?? []
  if (models.length === 0) throw new Error("--model is required")
  const engine = stringFlag(args, "engine")
  if (engine !== undefined && engine !== "native" && engine !== "faux" && engine !== "claude") throw new Error("--engine must be native, faux or claude")
  const fakeMode = stringFlag(args, "fake-mode")
  if (fakeMode !== undefined && !["normal", "hang", "crash"].includes(fakeMode)) throw new Error("--fake-mode must be normal, hang or crash")
  const tier = stringFlag(args, "tier")
  if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) throw new Error(`--tier must be ${TIERS.join(", ")}`)
  const split = (value: string | undefined) => (value === undefined ? undefined : value.split(/\s+/).filter(Boolean))
  const adapterOptions: AdapterOptions = {
    ...(stringFlag(args, "data-dir") ? { dataDir: path.resolve(stringFlag(args, "data-dir")!) } : {}),
    ...(stringFlag(args, "auth-from") ? { authFrom: path.resolve(stringFlag(args, "auth-from")!) } : {}),
    ...(split(stringFlag(args, "mendcode-bin")) ? { mendcodeCommand: split(stringFlag(args, "mendcode-bin"))! } : {}),
    ...(split(stringFlag(args, "daemon-bin")) ? { daemonCommand: split(stringFlag(args, "daemon-bin"))! } : {}),
    ...(engine ? { engine: engine as "native" | "faux" | "claude" } : {}),
    ...(tier ? { tier: tier as (typeof TIERS)[number] } : {}),
    ...(stringFlag(args, "codex-bin") ? { codexBin: stringFlag(args, "codex-bin")! } : {}),
    ...(stringFlag(args, "fake-solve") ? { fakeSolve: stringFlag(args, "fake-solve")! } : {}),
    ...(fakeMode ? { fakeMode: fakeMode as "normal" | "hang" | "crash" } : {}),
  }
  const scale = Number(stringFlag(args, "timeout-scale") ?? "1")
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("--timeout-scale must be a positive number")
  return {
    harnesses: harnesses as HarnessName[],
    models,
    taskSpec: requiredFlag(args, "tasks"),
    repeat: intFlag(args, "repeat", 1),
    outDir: path.resolve(requiredFlag(args, "out")),
    effort: stringFlag(args, "effort") ?? "medium",
    timeoutScale: scale,
    resume: args.flags.has("resume"),
    keepWork: args.flags.has("keep-work"),
    dryRun: args.flags.has("dry-run"),
    adapterOptions,
  }
}

async function main() {
  const parsed = parseRunArgs(process.argv.slice(2))
  const tasks = selectTasks(parsed.taskSpec)
  const total = parsed.harnesses.length * parsed.models.length * tasks.length * parsed.repeat
  console.log(`plan: ${parsed.harnesses.join(",")} x ${parsed.models.join(",")} x ${tasks.length} tasks x ${parsed.repeat} repeats = ${total} runs, effort ${parsed.effort}, out ${parsed.outDir}`)
  if (parsed.dryRun) {
    for (const task of tasks) console.log(`  ${task.id.padEnd(26)} ${task.meta.category.padEnd(11)} timeout ${Math.round(task.meta.timeoutSeconds * parsed.timeoutScale)}s`)
    return
  }
  mkdirSync(parsed.outDir, { recursive: true })
  const descriptions: Record<string, Record<string, string>> = {}
  for (const harness of parsed.harnesses) descriptions[harness] = await (await createAdapter(harness, parsed.adapterOptions)).describe()
  writeFileSync(
    path.join(parsed.outDir, "manifest.json"),
    `${JSON.stringify({ startedAt: new Date().toISOString(), argv: process.argv.slice(2).filter((token, index, all) => all[index - 1] !== "--auth-from"), bun: Bun.version, platform: process.platform, harnesses: descriptions, tasks: tasks.map((task) => task.id), repeat: parsed.repeat, effort: parsed.effort }, null, 2)}\n`,
  )
  const records = await runMatrix({ harnesses: parsed.harnesses, models: parsed.models, tasks, repeat: parsed.repeat }, { ...parsed, log: (line) => console.log(line) })
  const solved = records.filter((record) => record.solved).length
  console.log(`done: ${solved}/${records.length} solved. Report: bun ${path.join(import.meta.dir, "report.ts")} --out ${parsed.outDir}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(64)
  })
}
