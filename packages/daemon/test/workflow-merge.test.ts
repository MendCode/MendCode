import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWorkflowMerge } from "../src/workflow-merge"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-merge-")))
  dirs.push(dir)
  return dir
}
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}

/** A repository with one commit and `n` detached worktrees (what a workflow's worktree agents get). */
function fixture(n: number) {
  const repo = tempDir(), data = tempDir()
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(path.join(repo, "shared.txt"), "line one\nline two\nline three\n")
  writeFileSync(path.join(repo, "keep.txt"), "keep\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "base")
  const trees = Array.from({ length: n }, (_, i) => {
    const dir = path.join(tempDir(), `wt${i}`)
    git(repo, "worktree", "add", "-q", "--detach", dir, "HEAD")
    return dir
  })
  return { repo, data, trees, merge: createWorkflowMerge({ dir: data }) }
}

describe("script worktree results on real git", () => {
  test("a worktree agent's changes are committed on a branch and summarized; a worktree that changed nothing still has a branch", async () => {
    const { trees, merge, repo } = fixture(2)
    writeFileSync(path.join(trees[0]!, "a.txt"), "alpha\nbeta\n")
    writeFileSync(path.join(trees[0]!, "keep.txt"), "kept and changed\n")
    const summary = await merge.summarize({ workflowId: "wfl_abc123", taskId: "c1", workspace: trees[0]! })
    expect(summary).toMatchObject({ branch: "mend/wf-abc123-c1", files: 2, insertions: 3, deletions: 1 })
    expect(summary!.changed.sort()).toEqual(["a.txt", "keep.txt"])
    expect(git(trees[0]!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("mend/wf-abc123-c1")
    const untouched = await merge.summarize({ workflowId: "wfl_abc123", taskId: "c2", workspace: trees[1]! })
    expect(untouched).toMatchObject({ files: 0, insertions: 0, deletions: 0 })
    // The user's checkout was never touched.
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(await merge.summarize({ workflowId: "wfl_abc123", taskId: "c3", workspace: path.join(repo, "nowhere") })).toBeUndefined()
  })

  test("prepare merges the branches into an integration worktree and leaves the user's checkout alone; apply merges it once asked", async () => {
    const { trees, merge, repo, data } = fixture(2)
    writeFileSync(path.join(trees[0]!, "a.txt"), "from a\n")
    writeFileSync(path.join(trees[1]!, "b.txt"), "from b\n")
    const a = (await merge.summarize({ workflowId: "wfl_m1", taskId: "ta", workspace: trees[0]! }))!
    const b = (await merge.summarize({ workflowId: "wfl_m1", taskId: "tb", workspace: trees[1]! }))!
    const prepared = await merge.prepare({ directory: repo, workflowId: "wfl_m1", workspaces: [{ workspace: trees[0]!, branch: a.branch }, { workspace: trees[1]!, branch: b.branch }], message: "migrate" })
    expect(prepared).toMatchObject({ ok: true, value: { branch: "mend/merge-m1", files: 2, insertions: 2, deletions: 0, merged: [a.branch, b.branch] } })
    const worktree = (prepared as unknown as { value: { worktree: string } }).value.worktree
    expect(worktree.startsWith(path.join(data, "workflows", "merge"))).toBe(true)
    expect(readFileSync(path.join(worktree, "b.txt"), "utf8")).toBe("from b\n")
    expect(existsSync(path.join(repo, "a.txt"))).toBe(false)
    expect(git(repo, "log", "--oneline").split("\n")).toHaveLength(1)
    // Preparing again is a no-op over the same branches (what a resumed run does).
    expect(await merge.prepare({ directory: repo, workflowId: "wfl_m1", workspaces: [{ workspace: trees[0]!, branch: a.branch }, { workspace: trees[1]!, branch: b.branch }], message: "migrate" })).toMatchObject({ ok: true })

    const applied = await merge.apply({ directory: repo, branch: "mend/merge-m1" })
    expect(applied).toMatchObject({ ok: true, value: { into: "main" } })
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("from a\n")
    expect(readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("from b\n")
  })

  test("a conflict is reported with its files and kept in the integration worktree; resolving it there lets prepare continue", async () => {
    const { trees, merge, repo } = fixture(2)
    writeFileSync(path.join(trees[0]!, "shared.txt"), "line one\nCHANGED BY A\nline three\n")
    writeFileSync(path.join(trees[1]!, "shared.txt"), "line one\nCHANGED BY B\nline three\n")
    const a = (await merge.summarize({ workflowId: "wfl_c1", taskId: "ta", workspace: trees[0]! }))!
    const b = (await merge.summarize({ workflowId: "wfl_c1", taskId: "tb", workspace: trees[1]! }))!
    const input = { directory: repo, workflowId: "wfl_c1", workspaces: [{ workspace: trees[0]!, branch: a.branch }, { workspace: trees[1]!, branch: b.branch }], message: "both" }
    const first = await merge.prepare(input)
    const message = (first as { message: string }).message
    expect(first).toMatchObject({ ok: false, conflict: true })
    expect(message).toContain("shared.txt")
    const worktree = /integration worktree (\S+), branch/.exec(message)![1]!
    expect(readFileSync(path.join(worktree, "shared.txt"), "utf8")).toContain("<<<<<<<")
    // Still unresolved: still a conflict, and nothing reached the user's checkout.
    expect(await merge.prepare(input)).toMatchObject({ ok: false, conflict: true })
    expect(readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("line one\nline two\nline three\n")
    writeFileSync(path.join(worktree, "shared.txt"), "line one\nCHANGED BY A AND B\nline three\n")
    git(worktree, "add", "shared.txt")
    const resumed = await merge.prepare(input)
    expect(resumed).toMatchObject({ ok: true, value: { merged: [a.branch, b.branch], files: 1 } })
    expect((await merge.apply({ directory: repo, branch: "mend/merge-c1" })).ok).toBe(true)
    expect(readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("line one\nCHANGED BY A AND B\nline three\n")
  })

  test("apply refuses a checkout with uncommitted changes and undoes a merge that conflicts with the user's own commits", async () => {
    const { trees, merge, repo } = fixture(1)
    writeFileSync(path.join(trees[0]!, "shared.txt"), "line one\nFROM AGENT\nline three\n")
    const a = (await merge.summarize({ workflowId: "wfl_d1", taskId: "ta", workspace: trees[0]! }))!
    const prepared = await merge.prepare({ directory: repo, workflowId: "wfl_d1", workspaces: [{ workspace: trees[0]!, branch: a.branch }], message: "x" })
    expect(prepared.ok).toBe(true)
    writeFileSync(path.join(repo, "keep.txt"), "dirty\n")
    expect(await merge.apply({ directory: repo, branch: "mend/merge-d1" })).toMatchObject({ ok: false, message: expect.stringContaining("uncommitted changes") })
    git(repo, "checkout", "--", "keep.txt")
    writeFileSync(path.join(repo, "shared.txt"), "line one\nFROM USER\nline three\n")
    git(repo, "commit", "-aqm", "user change")
    const result = await merge.apply({ directory: repo, branch: "mend/merge-d1" })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("your checkout is unchanged") })
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("line one\nFROM USER\nline three\n")
    expect(await merge.apply({ directory: repo, branch: "mend/merge-nope" })).toMatchObject({ ok: false })
  })
})
