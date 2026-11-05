import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { StorageWorktreesReport, type ProjectRestInfo } from "@mendcode/protocol"
import { releaseEmptyCompoundWorkspace } from "../src/compound-workspace"
import { workflowWorktreeHeld } from "../src/workflow-merge"
import { createWorktreeGc } from "../src/worktree-gc"

const DAY = 86_400_000
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function git(directory: string, ...argv: string[]) {
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "user.name=GC Test", "-c", "user.email=gc@example.invalid", "-c", "commit.gpgsign=false", "-C", directory, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${stderr}`)
  return stdout.trimEnd()
}

/** A project with a committed file and an ignored `dist`, plus a data directory the daemon's own worktree roots live in. */
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-gcm-")))
  temporary.push(root)
  const project = path.join(root, "project")
  const dir = path.join(root, "data")
  mkdirSync(project)
  mkdirSync(dir)
  await git(project, "init", "-b", "main")
  writeFileSync(path.join(project, "tracked.txt"), "base\n")
  writeFileSync(path.join(project, ".gitignore"), "dist/\ntarget/\n")
  await git(project, "add", "tracked.txt", ".gitignore")
  await git(project, "commit", "-m", "base")
  const info = { id: "p", worktree: project, vcs: "git", time: { created: 0, updated: 0 }, sandboxes: [] as string[] } as unknown as ProjectRestInfo
  const forgotten: string[] = []
  const occupied = new Set<string>()
  const now = Date.now() + 30 * DAY
  const gc = createWorktreeGc({
    dir,
    projects: () => [info],
    occupied: (directory) => occupied.has(directory),
    lastSession: () => 0,
    forget: (_project, directory) => void forgotten.push(directory),
    now: () => now,
  })
  /** A detached worktree under one of the daemon's roots, like workflow routing and compound make. */
  const detached = async (...parts: string[]) => {
    const target = path.join(dir, ...parts)
    mkdirSync(path.dirname(target), { recursive: true })
    await git(project, "worktree", "add", "--detach", target, "HEAD")
    return target
  }
  return { root, project, dir, info, gc, forgotten, occupied, detached, now }
}

describe("worktrees the daemon makes for loops, workflows and compound runs", () => {
  test("every root is swept: clean detached worktrees whose commit is in the project are removable, others say why they stay", async () => {
    const { gc, detached, project, occupied } = await fixture()
    const compound = await detached("compound-worktrees", "run1")
    const loop = await detached("loop-worktrees", "loop-r1")
    const routing = await detached("workflows", "workspaces", "wfl_a", "task1")
    const merge = await detached("workflows", "merge", "abc")
    const dirty = await detached("compound-worktrees", "run2")
    const ahead = await detached("compound-worktrees", "run3")
    const busy = await detached("loop-worktrees", "loop-r2")
    writeFileSync(path.join(dirty, "work.txt"), "unsaved\n")
    writeFileSync(path.join(ahead, "new.txt"), "new\n")
    await git(ahead, "add", "new.txt")
    await git(ahead, "commit", "-m", "only here")
    occupied.add(busy)

    const report = await gc.report(14)
    expect(StorageWorktreesReport.safeParse(report).success).toBe(true)
    const byDir = new Map(report.worktrees.map((tree) => [tree.directory, tree]))
    for (const [directory, kind] of [[compound, "compound"], [loop, "loop"], [routing, "workflow"], [merge, "merge"]] as const) {
      expect(byDir.get(directory)).toMatchObject({ kind, state: "merged", clean: true, removable: true })
    }
    expect(byDir.get(dirty)).toMatchObject({ removable: false, keep: "uncommitted or untracked changes" })
    expect(byDir.get(ahead)).toMatchObject({ removable: false, keep: "detached HEAD with commits no branch holds" })
    expect(byDir.get(busy)).toMatchObject({ removable: false, keep: "a session, loop or workflow works in it" })

    const dry = await gc.clean({ idleDays: 14, dryRun: true })
    expect(dry.removed).toBe(4)
    expect(existsSync(compound)).toBe(true)

    const real = await gc.clean({ idleDays: 14 })
    expect(real.removed).toBe(4)
    for (const directory of [compound, loop, routing, merge]) expect(existsSync(directory)).toBe(false)
    for (const directory of [dirty, ahead, busy]) expect(existsSync(directory)).toBe(true)
    expect(await git(project, "worktree", "list")).toContain("run3")
  })

  test("a detached commit that a branch holds is safe to remove", async () => {
    const { gc, detached, project } = await fixture()
    const target = await detached("workflows", "workspaces", "wfl_b", "run")
    writeFileSync(path.join(target, "result.txt"), "kept on a branch\n")
    await git(target, "add", "result.txt")
    await git(target, "commit", "-m", "task result")
    expect((await gc.report(14)).worktrees[0]).toMatchObject({ removable: false })
    await git(target, "branch", "mend/wf-kept")
    expect((await gc.report(14)).worktrees[0]).toMatchObject({ state: "merged", removable: true })
    await gc.clean({ idleDays: 14 })
    expect(existsSync(target)).toBe(false)
    expect(await git(project, "branch", "--list", "mend/wf-kept")).toContain("mend/wf-kept")
  })

  test("a worktree of a workflow run that has not finished is held", () => {
    const run = { workflowId: "wfl_abc123", originSessionId: "ses_1", state: "running" }
    const dir = "/data"
    expect(workflowWorktreeHeld({ dir, run, directory: "/data/workflows/workspaces/wfl_abc123/task1" })).toBe(true)
    expect(workflowWorktreeHeld({ dir, run, directory: "/data/workflows/workspaces/ses_1/run" })).toBe(true)
    expect(workflowWorktreeHeld({ dir, run, directory: "/data/workflows/merge/abc123" })).toBe(true)
    expect(workflowWorktreeHeld({ dir, run, directory: "/data/workflows/workspaces/wfl_other/task1" })).toBe(false)
    expect(workflowWorktreeHeld({ dir, run: { ...run, state: "completed" }, directory: "/data/workflows/merge/abc123" })).toBe(false)
  })

  test("a compound workspace that changed nothing is released at the end; a candidate stays", async () => {
    const { project, detached } = await fixture()
    const base = await git(project, "rev-parse", "HEAD")
    const empty = await detached("compound-worktrees", "empty")
    const changed = await detached("compound-worktrees", "changed")
    writeFileSync(path.join(changed, "candidate.txt"), "the candidate\n")
    expect(await releaseEmptyCompoundWorkspace(project, empty, base)).toBe(true)
    expect(existsSync(empty)).toBe(false)
    expect(await releaseEmptyCompoundWorkspace(project, changed, base)).toBe(false)
    expect(existsSync(path.join(changed, "candidate.txt"))).toBe(true)
    await git(changed, "add", "candidate.txt")
    await git(changed, "commit", "-m", "candidate")
    expect(await releaseEmptyCompoundWorkspace(project, changed, base)).toBe(false)
    expect(existsSync(changed)).toBe(true)
  })
})

describe("worktrees MendCode did not make", () => {
  test("they are listed only when asked, and removed only with the external option, clean and merged", async () => {
    const { gc, project, root, forgotten } = await fixture()
    const merged = path.join(root, "ext-merged")
    const dirty = path.join(root, "ext-dirty")
    const unmerged = path.join(root, "ext-unmerged")
    await git(project, "worktree", "add", "-b", "ext/merged", merged)
    await git(project, "worktree", "add", "-b", "ext/dirty", dirty)
    await git(project, "worktree", "add", "-b", "ext/unmerged", unmerged)
    writeFileSync(path.join(dirty, "wip.txt"), "wip\n")
    writeFileSync(path.join(unmerged, "feature.txt"), "feature\n")
    await git(unmerged, "add", "feature.txt")
    await git(unmerged, "commit", "-m", "feature")

    expect((await gc.report(14)).worktrees).toEqual([])
    const listed = await gc.report(14, undefined, { external: true })
    const byName = new Map(listed.worktrees.map((tree) => [path.basename(tree.directory), tree]))
    expect([...byName.keys()].sort()).toEqual(["ext-dirty", "ext-merged", "ext-unmerged"])
    expect(byName.get("ext-merged")).toMatchObject({ kind: "external", removable: true })
    expect(byName.get("ext-dirty")).toMatchObject({ removable: false, keep: "uncommitted or untracked changes" })
    expect(byName.get("ext-unmerged")).toMatchObject({ removable: false, keep: "branch has commits that are not merged" })
    // The project's own checkout is never a candidate.
    expect(listed.worktrees.some((tree) => tree.directory === project)).toBe(false)

    expect((await gc.clean({ idleDays: 14 })).removed).toBe(0)
    expect(existsSync(merged)).toBe(true)
    expect((await gc.clean({ idleDays: 14, external: true, dryRun: true })).removed).toBe(1)
    expect(existsSync(merged)).toBe(true)
    expect((await gc.clean({ idleDays: 14, external: true })).removed).toBe(1)
    expect(existsSync(merged)).toBe(false)
    expect(existsSync(dirty) && existsSync(unmerged)).toBe(true)
    // External worktrees are not in any registry of ours.
    expect(forgotten).toEqual([])
  })

  test("a worktree used recently stays whoever made it", async () => {
    const { gc, project, root, now } = await fixture()
    const recent = path.join(root, "ext-recent")
    await git(project, "worktree", "add", "-b", "ext/recent", recent)
    const fresh = new Date(now - 2 * DAY)
    utimesSync(recent, fresh, fresh)
    utimesSync(path.join(recent, ".git"), fresh, fresh)
    const gitDir = (await git(recent, "rev-parse", "--absolute-git-dir"))
    for (const name of ["HEAD", "index"]) if (existsSync(path.join(gitDir, name))) utimesSync(path.join(gitDir, name), fresh, fresh)
    expect((await gc.report(14, undefined, { external: true })).worktrees[0]).toMatchObject({ removable: false, keep: "used 2 days ago" })
  })
})

describe("disk cap", () => {
  test("over the cap, idle-only worktrees go oldest first until the rest fits; unsafe ones never do", async () => {
    const { gc, detached, dir } = await fixture()
    const old = await detached("compound-worktrees", "old")
    const newer = await detached("compound-worktrees", "newer")
    const dirty = await detached("compound-worktrees", "dirty")
    for (const target of [old, newer, dirty]) writeFileSync(path.join(target, "big.bin"), "x".repeat(200_000))
    // `big.bin` is untracked: commit it away from the check by ignoring nothing; use a tracked copy instead.
    for (const target of [old, newer]) { await git(target, "add", "big.bin"); await git(target, "commit", "-m", "big") ; await git(target, "branch", `keep-${path.basename(target)}`) }
    // Recent use (below the idle window) of both clean ones; `old` was used longer ago.
    const recent = (days: number) => new Date(Date.now() + 30 * DAY - days * DAY)
    for (const [target, days] of [[old, 5], [newer, 2]] as const) {
      utimesSync(target, recent(days), recent(days))
      utimesSync(path.join(target, ".git"), recent(days), recent(days))
      const gitDir = await git(target, "rev-parse", "--absolute-git-dir")
      for (const name of ["HEAD", "index"]) utimesSync(path.join(gitDir, name), recent(days), recent(days))
    }
    const without = await gc.report(14)
    expect(without.worktrees.filter((tree) => tree.removable)).toEqual([])
    const capped = await gc.report(14, undefined, { capBytes: 450_000 })
    expect(capped.capBytes).toBe(450_000)
    expect(capped.managedBytes).toBeGreaterThan(450_000)
    const removable = capped.worktrees.filter((tree) => tree.removable).map((tree) => path.basename(tree.directory))
    expect(removable).toEqual(["old"])
    const result = await gc.clean({ idleDays: 14, capBytes: 450_000 })
    expect(result.removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(newer) && existsSync(dirty)).toBe(true)
    expect(dir).toBeTruthy()
  })
})

describe("heavy ignored output", () => {
  test("idle worktrees lose ignored dist/target; tracked dirs, non-ignored dirs and the worktree itself stay", async () => {
    const { gc, detached, project, now } = await fixture()
    const idle = await detached("compound-worktrees", "idle")
    mkdirSync(path.join(idle, "dist", "install"), { recursive: true })
    writeFileSync(path.join(idle, "dist", "install", "bundle.js"), "x".repeat(40_000))
    mkdirSync(path.join(idle, "target"), { recursive: true })
    writeFileSync(path.join(idle, "target", "debug.bin"), "y".repeat(40_000))
    // `build` is not ignored: it is the user's folder, not output.
    mkdirSync(path.join(idle, "build"), { recursive: true })
    writeFileSync(path.join(idle, "build", "notes.txt"), "mine\n")
    const stale = path.join(project, ".1234abcd-00000000.bun-build")
    const fresh = path.join(project, ".ffff0000-00000000.bun-build")
    writeFileSync(stale, "z".repeat(20_000))
    writeFileSync(fresh, "z".repeat(20_000))
    const old = new Date(now - 3600_000)
    utimesSync(stale, old, old)
    utimesSync(fresh, new Date(now - 30_000), new Date(now - 30_000))

    const report = await gc.report(14, undefined, { artifacts: true })
    expect(StorageWorktreesReport.safeParse(report).success).toBe(true)
    const names = (report.artifacts ?? []).map((item) => `${item.kind}:${path.basename(item.directory)}:${item.path}`).sort()
    expect(names).toEqual(["bun-build:project:.1234abcd-00000000.bun-build", "directory:idle:dist", "directory:idle:target"])
    expect(report.artifactBytes).toBeGreaterThan(80_000)

    const dry = await gc.clean({ idleDays: 14, artifacts: true, dryRun: true })
    expect(dry.removed).toBe(3)
    expect(existsSync(path.join(idle, "dist"))).toBe(true)
    expect(existsSync(stale)).toBe(true)

    const real = await gc.clean({ idleDays: 14, artifacts: true })
    expect(real.removed).toBe(3)
    expect(existsSync(path.join(idle, "dist"))).toBe(false)
    expect(existsSync(path.join(idle, "target"))).toBe(false)
    expect(existsSync(stale)).toBe(false)
    // Not output, not stale, or not ours: untouched, and the worktree itself stays.
    expect(existsSync(path.join(idle, "build", "notes.txt"))).toBe(true)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(idle)).toBe(true)
  })

  test("a worktree in use or used recently keeps its output; tracked files under an ignored name are never removed", async () => {
    const { gc, detached, occupied } = await fixture()
    const busy = await detached("loop-worktrees", "busy")
    mkdirSync(path.join(busy, "dist"))
    writeFileSync(path.join(busy, "dist", "a.js"), "a")
    occupied.add(busy)
    const quirky = await detached("loop-worktrees", "quirky")
    mkdirSync(path.join(quirky, "target"))
    writeFileSync(path.join(quirky, "target", "kept.txt"), "tracked on purpose\n")
    await git(quirky, "add", "-f", "target/kept.txt")
    await git(quirky, "commit", "-m", "track target")
    const report = await gc.report(14, undefined, { artifacts: true })
    expect(report.artifacts).toEqual([])
    expect((await gc.clean({ idleDays: 14, artifacts: true })).removed).toBe(0)
    expect(existsSync(path.join(busy, "dist", "a.js")) && existsSync(path.join(quirky, "target", "kept.txt"))).toBe(true)
  })
})

describe("scanning many large worktrees", () => {
  async function many(count: number) {
    const f = await fixture()
    const trees: string[] = []
    for (let index = 0; index < count; index++) {
      const target = await f.detached("compound-worktrees", `r${index}`)
      mkdirSync(path.join(target, "dist"), { recursive: true })
      writeFileSync(path.join(target, "dist", "big.bin"), "x".repeat(300_000))
      trees.push(target)
    }
    return { ...f, trees }
  }

  test("a listing answers from what is known and measures nothing; a full report measures once and the next listing knows", async () => {
    const { gc, trees } = await many(5)
    const quick = await gc.report(14, undefined, { measure: "cached" })
    expect(quick.worktrees).toHaveLength(5)
    expect(quick.unmeasured).toBe(5)
    expect(quick.worktrees.every((tree) => tree.bytes === 0 && tree.bytesKnown === false)).toBe(true)
    expect(StorageWorktreesReport.safeParse(quick).success).toBe(true)
    const full = await gc.report(14)
    expect(full.unmeasured).toBeUndefined()
    expect(full.worktrees.every((tree) => tree.bytes >= 300_000 && tree.bytesKnown === undefined)).toBe(true)
    const again = await gc.report(14, undefined, { measure: "cached" })
    expect(again.unmeasured).toBeUndefined()
    expect(again.totalBytes).toBe(full.totalBytes)
    expect(trees).toHaveLength(5)
  })

  test("a size is measured again once the directory changes", async () => {
    const { gc, trees } = await many(1)
    const before = (await gc.report(14)).totalBytes
    writeFileSync(path.join(trees[0]!, "added.bin"), "y".repeat(400_000))
    const after = await gc.report(14, undefined, { measure: "cached" })
    expect(after.unmeasured).toBe(1)
    expect((await gc.report(14)).totalBytes).toBeGreaterThan(before + 300_000)
  })

  test("identical requests at once share one scan", async () => {
    const { gc } = await many(3)
    const [a, b, c] = await Promise.all([gc.report(14), gc.report(14), gc.report(14)])
    expect(b).toBe(a)
    expect(c).toBe(a)
    const [dry1, dry2] = [gc.clean({ idleDays: 14, dryRun: true }), gc.clean({ idleDays: 14, dryRun: true })]
    expect(await dry1).toBe(await dry2)
  })

  test("a request whose client goes away stops the scan; one still waited for keeps it going", async () => {
    const { gc } = await many(4)
    const gone = new AbortController()
    const leaving = gc.report(14, gone.signal)
    gone.abort()
    await expect(leaving).rejects.toThrow("cancelled")
    // The next identical request starts a scan of its own and gets a whole report.
    expect((await gc.report(14)).worktrees).toHaveLength(4)

    const first = new AbortController()
    const stays = new AbortController()
    const a = gc.report(14, first.signal)
    const b = gc.report(14, stays.signal)
    first.abort()
    await expect(a).rejects.toThrow("cancelled")
    expect((await b).worktrees).toHaveLength(4)
  })

  test("a clean cancelled before it starts removing removes nothing", async () => {
    const { gc, trees } = await many(3)
    const stop = new AbortController()
    stop.abort()
    await expect(gc.clean({ idleDays: 14, signal: stop.signal })).resolves.toMatchObject({ removed: 0 })
    expect(trees.every((tree) => existsSync(tree))).toBe(true)
  })
})
