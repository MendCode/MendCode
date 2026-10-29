import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach } from "bun:test"
import { loadTask } from "../lib/tasks"
import type { Task } from "../lib/types"
import { createWorkspace, git, makeTempDir, removeKitTree, type Workspace } from "../lib/workspace"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** A kit-owned temp directory that is removed after the current test. */
export function tempDir(label: string): string {
  const dir = makeTempDir(label)
  cleanups.push(() => removeKitTree(dir))
  return dir
}

/** A fresh workspace of the task, with the reference patch applied when `solved` is true. */
export async function workspaceOf(taskId: string, options: { solved: boolean }): Promise<{ task: Task; workspace: Workspace }> {
  const task = loadTask(taskId)
  const workspace = await createWorkspace(task)
  cleanups.push(() => removeKitTree(workspace.root))
  if (options.solved) {
    const applied = await git(workspace.cwd, ["apply", "--whitespace=nowarn", task.solutionPatch])
    if (applied.exitCode !== 0) throw new Error(`${taskId}: solution.patch does not apply`)
  }
  return { task, workspace }
}

export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

/** Rewrites every file under `dir` whose path matches `where`, using `change` on its text. */
export function rewriteFiles(dir: string, where: RegExp, change: (text: string) => string): number {
  let changed = 0
  for (const file of filesUnder(dir)) {
    if (!where.test(file)) continue
    const before = readFileSync(file, "utf8")
    const after = change(before)
    if (after !== before) {
      writeFileSync(file, after)
      changed++
    }
  }
  return changed
}
