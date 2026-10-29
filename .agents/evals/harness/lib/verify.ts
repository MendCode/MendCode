import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { runCheck } from "./check"
import type { CheckResult, Task } from "./types"
import { createWorkspace, git, removeKitTree } from "./workspace"

export type TaskVerification = {
  taskId: string
  /** Static problems: missing pieces, hints about the checker inside what the agent can see. */
  lint: string[]
  startCheck?: CheckResult
  solvedCheck?: CheckResult
  patchApplied?: boolean
  /** True only when the starting repo fails the check AND the reference patch makes it pass. */
  ok: boolean
}

const LEAK_PATTERN = /check\.sh|CHECK_DIR|PRISTINE|SCRATCH|overlay|hidden test|expected-ms|solution\.patch/i

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** Static checks of the task folder: what the agent sees must not talk about the checker. */
export function lintTask(task: Task): string[] {
  const problems: string[] = []
  if (!existsSync(task.solutionPatch)) problems.push("missing solution.patch")
  if (task.prompt.length === 0) problems.push("prompt.md is empty")
  if (LEAK_PATTERN.test(task.prompt)) problems.push("prompt.md mentions the checker")
  if (!existsSync(path.join(task.repoDir, "package.json"))) problems.push("repo/ has no package.json")
  for (const file of walk(task.repoDir)) {
    const relative = path.relative(task.repoDir, file)
    if (relative.split(path.sep).includes("node_modules")) {
      problems.push(`repo/${relative} is a dependency; tasks must not need any`)
      continue
    }
    const text = readFileSync(file, "utf8")
    if (LEAK_PATTERN.test(text)) problems.push(`repo/${relative} mentions the checker`)
  }
  if (existsSync(task.solutionPatch)) {
    const patch = readFileSync(task.solutionPatch, "utf8")
    for (const line of patch.split("\n")) {
      if (/^(diff --git|\+\+\+ |--- )/.test(line) && /(^|\s|[ab]\/)check(\/|\.sh)/.test(line)) problems.push(`solution.patch touches the checker: ${line}`)
    }
  }
  return problems
}

/** Proves one task end to end: the starting repo fails its check and the reference patch passes it. */
export async function verifyTask(task: Task): Promise<TaskVerification> {
  const lint = lintTask(task)
  const result: TaskVerification = { taskId: task.id, lint, ok: false }
  if (lint.some((problem) => problem.startsWith("missing solution.patch"))) return result
  const workspace = await createWorkspace(task)
  try {
    result.startCheck = await runCheck(task, workspace.cwd)
    const applied = await git(workspace.cwd, ["apply", "--whitespace=nowarn", task.solutionPatch])
    result.patchApplied = applied.exitCode === 0
    if (result.patchApplied) result.solvedCheck = await runCheck(task, workspace.cwd)
    result.ok = lint.length === 0 && result.startCheck.exitCode !== 0 && !result.startCheck.timedOut && result.patchApplied && result.solvedCheck?.exitCode === 0
  } finally {
    removeKitTree(workspace.root)
  }
  return result
}
