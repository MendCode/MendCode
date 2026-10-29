#!/usr/bin/env bun
/**
 * Proves every task: the starting repo FAILS its check and the reference solution.patch PASSES it.
 *   bun .agents/evals/harness/verify-tasks.ts [--tasks id,id|all] [--verbose]
 * No model, harness or network is involved. Exit 0 only when every selected task is proven.
 */
import { parseArgs, rejectUnknown, stringFlag } from "./lib/args"
import { selectTasks } from "./lib/tasks"
import { verifyTask } from "./lib/verify"

const args = parseArgs(process.argv.slice(2), ["verbose"])
rejectUnknown(args, ["tasks", "verbose"])
const tasks = selectTasks(stringFlag(args, "tasks") ?? "all")
const verbose = args.flags.has("verbose")

let failures = 0
for (const task of tasks) {
  const started = Date.now()
  const outcome = await verifyTask(task)
  const status = (check: { exitCode: number | null } | undefined) => (check === undefined ? "-" : check.exitCode === 0 ? "pass" : "fail")
  const line = `${outcome.ok ? "OK  " : "FAIL"} ${task.id.padEnd(24)} start=${status(outcome.startCheck).padEnd(4)} (want fail)  solution=${status(outcome.solvedCheck).padEnd(4)} (want pass)  ${((Date.now() - started) / 1000).toFixed(1)}s`
  console.log(line)
  if (!outcome.ok) {
    failures++
    for (const problem of outcome.lint) console.log(`     lint: ${problem}`)
    if (outcome.patchApplied === false) console.log("     solution.patch does not apply to repo/")
  }
  if (verbose || !outcome.ok) {
    if (outcome.startCheck && outcome.startCheck.exitCode === 0) console.log("     the starting repo already passes its check")
    if (outcome.solvedCheck && outcome.solvedCheck.exitCode !== 0) console.log(`     solved tree output:\n${outcome.solvedCheck.logTail.split("\n").map((row) => `       ${row}`).join("\n")}`)
    if (verbose && outcome.startCheck) console.log(`     start tree output:\n${outcome.startCheck.logTail.split("\n").slice(-12).map((row) => `       ${row}`).join("\n")}`)
  }
}
console.log(failures === 0 ? `all ${tasks.length} tasks proven` : `${failures} of ${tasks.length} tasks NOT proven`)
process.exit(failures === 0 ? 0 : 1)
