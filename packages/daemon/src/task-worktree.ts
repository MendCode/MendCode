import { existsSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import type { TaskRecord } from "@mendcode/protocol"
import type { ScriptMergePort } from "@mendcode/workflows"

type Worktree = NonNullable<TaskRecord["worktree"]>

/** git without a shell; a failure to start git is a failed result, never a throw. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: code === 0, out: out.trim(), err: err.trim() }
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) }
  }
}

const slug = (taskId: string) => taskId.replace(/^ses_/, "").replace(/[^A-Za-z0-9]+/g, "").slice(-12).toLowerCase() || "task"

/** The branch an isolated child's changes end on. */
export const taskBranch = (taskId: string) => `mend/task-${slug(taskId)}`

/** The lines an isolated child's result ends with: where its work is and that nothing was merged. */
export function worktreeFooter(worktree: Worktree): string {
  const size = worktree.files === undefined ? "" : ` · ${worktree.files} file${worktree.files === 1 ? "" : "s"} +${worktree.insertions ?? 0} -${worktree.deletions ?? 0}`
  const review = worktree.branch ? `review: git diff ${worktree.base.slice(0, 12)} ${worktree.branch}` : "its changes could not be committed; review them in the worktree"
  return `\n\n[worktree] ${worktree.path}${worktree.branch ? ` · branch ${worktree.branch}` : ""}${worktree.commit ? ` @ ${worktree.commit}` : ""}${size} · not merged; ${review}`
}

/**
 * Per-task worktrees (`task` with `isolation: "worktree"`, full tier). A child gets a detached worktree of its parent
 * checkout's HEAD under the data directory (uncommitted changes of the checkout are not in it), at the same subfolder the
 * parent works in. When a generation ends its changes are committed on `mend/task-<id>` with the workflow merge port, the
 * same way a script's worktree agent is summarized. Nothing is merged and nothing is removed: the worktree stays for review.
 */
export function createTaskWorktrees(options: { dir: string; merge: ScriptMergePort }) {
  return {
    async create(directory: string, taskId: string): Promise<{ directory: string; worktree: Worktree }> {
      const top = await git(directory, ["rev-parse", "--show-toplevel"])
      if (!top.ok) throw new Error("isolation: \"worktree\" needs a git checkout")
      const base = await git(top.out, ["rev-parse", "HEAD"])
      if (!base.ok) throw new Error("isolation: \"worktree\" needs a commit to start from")
      const root = path.join(options.dir, "tasks", "worktrees", slug(taskId))
      if (existsSync(root)) throw new Error("a worktree for this task already exists")
      mkdirSync(path.dirname(root), { recursive: true })
      const added = await git(top.out, ["worktree", "add", "--detach", root, base.out])
      if (!added.ok) throw new Error(`could not create the worktree: ${added.err.slice(-300)}`)
      const real = realpathSync(root)
      const inside = path.relative(realpathSync(top.out), realpathSync(directory))
      const work = inside && !inside.startsWith("..") && existsSync(path.join(real, inside)) ? path.join(real, inside) : real
      return { directory: work, worktree: { path: real, base: base.out } }
    },
    /** Commits what the child left on its branch and measures it; the record unchanged when git cannot. */
    async settle(task: TaskRecord): Promise<Worktree | undefined> {
      if (!task.worktree) return undefined
      const summary = await options.merge.summarize({ workflowId: "task", taskId: task.taskId, workspace: task.worktree.path, branch: taskBranch(task.taskId), message: `task ${task.agent}: ${task.description}`.slice(0, 200), base: task.worktree.base }).catch(() => undefined)
      return summary ? { ...task.worktree, branch: summary.branch, commit: summary.commit, files: summary.files, insertions: summary.insertions, deletions: summary.deletions, changed: summary.changed } : task.worktree
    },
  }
}
export type TaskWorktrees = ReturnType<typeof createTaskWorktrees>
