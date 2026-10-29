#!/usr/bin/env bun
/**
 * Authoring helper for reference solutions.
 *   bun make-patch.ts init <task> <dir>   copies tasks/<task>/repo into <dir> (must not exist) as a git repo at the starting state
 *   bun make-patch.ts write <task> <dir>  writes tasks/<task>/solution.patch from the changes made in <dir>
 */
import { cpSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadTask } from "./lib/tasks"
import { git } from "./lib/workspace"

const [command, taskId, dirArg] = process.argv.slice(2)
if (!command || !taskId || !dirArg) {
  console.error("usage: bun make-patch.ts init|write <task> <dir>")
  process.exit(64)
}
const task = loadTask(taskId)
const dir = path.resolve(dirArg)

if (command === "init") {
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  cpSync(task.repoDir, dir, { recursive: true })
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) await git(dir, args)
  console.log(`ready: edit files in ${dir}`)
} else if (command === "write") {
  await git(dir, ["add", "-A"])
  const diff = await git(dir, ["diff", "--cached", "--binary", "HEAD"])
  if (diff.output.trim() === "") throw new Error("no changes to write")
  writeFileSync(task.solutionPatch, diff.output)
  console.log(`wrote ${task.solutionPatch} (${diff.output.split("\n").length} lines)`)
} else {
  console.error("unknown command")
  process.exit(64)
}
