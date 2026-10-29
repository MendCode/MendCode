import { existsSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import type { MergeOutcome, ScriptMergePort, WorktreeSummary } from "@mendcode/workflows"

type Git = { ok: boolean; out: string; err: string }

/** git without a shell. A failure to start git is a failed result, never a throw. */
async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<Git> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...env } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: code === 0, out: out.trim(), err: err.trim() }
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) }
  }
}

/** A commit identity only when the repository has none, so a fresh machine can still record the merge. */
async function identity(cwd: string): Promise<Record<string, string>> {
  return (await git(cwd, ["config", "user.email"])).out ? {} : { GIT_AUTHOR_NAME: "MendCode workflow", GIT_AUTHOR_EMAIL: "workflow@mendcode.invalid", GIT_COMMITTER_NAME: "MendCode workflow", GIT_COMMITTER_EMAIL: "workflow@mendcode.invalid" }
}

const slug = (text: string) => text.replace(/^wfl_/, "").replace(/[^A-Za-z0-9]+/g, "").slice(-10) || "run"

async function numstat(cwd: string, range: string[]): Promise<Pick<WorktreeSummary, "files" | "insertions" | "deletions" | "changed">> {
  const rows = (await git(cwd, ["diff", "--numstat", ...range])).out.split("\n").filter(Boolean).map((line) => line.split("\t"))
  const count = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0)
  return { files: rows.length, insertions: rows.reduce((sum, row) => sum + count(row[0]), 0), deletions: rows.reduce((sum, row) => sum + count(row[1]), 0), changed: rows.slice(0, 20).map((row) => (row[2] ?? "").slice(0, 200)) }
}

/**
 * The git side of script worktree results. Nothing here writes to the user's checkout except `apply`, which a script only
 * reaches after the user approved it: worktree agents' changes are committed on branches of their own worktrees, `prepare`
 * merges those branches into a scratch integration worktree under the data directory, and a conflict stays there to be resolved.
 */
export function createWorkflowMerge(options: { dir: string }): ScriptMergePort {
  const root = path.join(options.dir, "workflows", "merge")
  return {
    async summarize({ workflowId, taskId, workspace, branch: named, message, base: start }) {
      const top = await git(workspace, ["rev-parse", "--show-toplevel"])
      if (!top.ok || realpathSync(top.out) !== realpathSync(workspace)) return undefined
      const base = start ?? (await git(workspace, ["rev-parse", "HEAD"])).out
      const branch = named ?? `mend/wf-${slug(workflowId)}-${slug(taskId)}`
      if (!(await git(workspace, ["checkout", "-q", "-B", branch])).ok) return undefined
      await git(workspace, ["add", "-A"])
      if (!(await git(workspace, ["diff", "--cached", "--quiet"])).ok) {
        const committed = await git(workspace, ["commit", "-q", "-m", message ?? `workflow ${slug(workflowId)}: ${taskId}`], await identity(workspace))
        if (!committed.ok) return undefined
      }
      const commit = (await git(workspace, ["rev-parse", "--short", "HEAD"])).out
      return { branch, commit, ...(await numstat(workspace, [base, "HEAD"])) }
    },

    async prepare({ directory, workflowId, workspaces, message }): Promise<MergeOutcome> {
      const top = await git(directory, ["rev-parse", "--show-toplevel"])
      if (!top.ok) return { ok: false, message: `${directory} is not a git checkout` }
      if (workspaces.some((entry) => !entry.branch)) return { ok: false, message: "a worktree result has no branch: its agent changed nothing it could commit, or git failed in it" }
      const branch = `mend/merge-${slug(workflowId)}`
      const target = path.join(root, slug(workflowId))
      if (!existsSync(target)) {
        mkdirSync(root, { recursive: true })
        const added = await git(top.out, ["worktree", "add", "--detach", target, "HEAD"])
        if (!added.ok) return { ok: false, message: `could not create the integration worktree: ${added.err.slice(-300)}` }
        const switched = await git(target, ["checkout", "-q", "-B", branch])
        if (!switched.ok) return { ok: false, message: `could not create ${branch}: ${switched.err.slice(-300)}` }
      }
      const env = await identity(target)
      const unresolved = async () => (await git(target, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean)
      const conflict = async (): Promise<MergeOutcome> => {
        const files = await unresolved()
        return { ok: false, conflict: true, message: `merge conflict in ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""} (integration worktree ${target}, branch ${branch})` }
      }
      // A resumed run: the user may have resolved a merge left in progress.
      if ((await git(target, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok) {
        if ((await unresolved()).length) return conflict()
        const concluded = await git(target, ["commit", "--no-edit", "-q"], env)
        if (!concluded.ok) return { ok: false, message: `could not conclude the resolved merge: ${concluded.err.slice(-300)}` }
      }
      const merged: string[] = []
      for (const entry of workspaces) {
        const name = entry.branch!
        if ((await git(target, ["merge-base", "--is-ancestor", name, "HEAD"])).ok) {
          merged.push(name)
          continue
        }
        const result = await git(target, ["merge", "--no-ff", "--no-edit", "-m", `${message}: ${name}`, name], env)
        if (!result.ok) {
          if ((await unresolved()).length) return conflict()
          await git(target, ["merge", "--abort"])
          return { ok: false, message: `could not merge ${name}: ${result.err.slice(-300) || result.out.slice(-300)}` }
        }
        merged.push(name)
      }
      const head = (await git(directory, ["rev-parse", "HEAD"])).out
      const base = (await git(target, ["merge-base", "HEAD", head])).out || head
      return { ok: true, value: { branch, worktree: target, base: base.slice(0, 10), commit: (await git(target, ["rev-parse", "--short", "HEAD"])).out, merged, ...(await numstat(target, [base, "HEAD"])) } }
    },

    async apply({ directory, branch }): Promise<MergeOutcome> {
      if (!(await git(directory, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).ok) return { ok: false, message: `${branch} no longer exists` }
      const dirty = (await git(directory, ["status", "--porcelain", "--untracked-files=no"])).out
      if (dirty) return { ok: false, message: `your checkout has uncommitted changes; commit or stash them, then merge ${branch} yourself (git merge ${branch})` }
      const result = await git(directory, ["merge", "--no-edit", branch], await identity(directory))
      if (!result.ok) {
        await git(directory, ["merge", "--abort"])
        return { ok: false, message: `merging ${branch} into your checkout failed and was undone (${(result.err || result.out).split("\n")[0]?.slice(0, 200)}); your checkout is unchanged. Merge it yourself: git merge ${branch}` }
      }
      return { ok: true, value: { head: (await git(directory, ["rev-parse", "--short", "HEAD"])).out, into: (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])).out } }
    },
  }
}
