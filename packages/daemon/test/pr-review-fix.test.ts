import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fixGuards, fixReply, runPrCommand, type CommandComment, type FixResult } from "../src/pr-review/commands"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { runFix, type FixInput } from "../src/pr-review/fix"
import type { GhCall } from "../src/pr-review/publish"
import { emptyState } from "../src/pr-review/state"

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const NOW = 1_800_000_000_000

/** A clone whose bare origin has `feature` at `head` and `main` at `base`, with a ref `moved` one commit past `head`. */
async function repository() {
  const origin = temp("fix-origin-"), dir = temp("fix-clone-"), root = temp("fix-root-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`${args.join(" ")}: ${done.out}`); return done.out.trim() }
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.name", "t")
  await git(dir, "config", "user.email", "t@example.invalid")
  await git(dir, "config", "commit.gpgsign", "false")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
  await git(dir, "commit", "-q", "-am", "feature")
  const head = await git(dir, "rev-parse", "HEAD")
  writeFileSync(path.join(dir, "b.ts"), "export const two = 2\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "someone else's push")
  const moved = await git(dir, "rev-parse", "HEAD")
  await git(dir, "reset", "-q", "--hard", head)
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", `${base}:refs/heads/main`, `${head}:refs/heads/feature`)
  return { origin, dir, root, base, head, moved, git }
}

/** A fix session that rewrites a.ts in its worktree, then runs `during` (another push meanwhile, say). */
const editor = (during: () => Promise<unknown> = async () => {}, seen: string[] = []) => (worktree: string): ReviewSessionFactory => async () => ({
  id: "ses_fix",
  async send() { seen.push(worktree); writeFileSync(path.join(worktree, "a.ts"), "export const one = 1\n"); await during(); return { text: "Restored one.", tokens: { input: 0, output: 0 } } },
  async close() {},
})

async function fixIn(repo: Awaited<ReturnType<typeof repository>>, extra: Partial<FixInput> = {}) {
  return runFix({ directory: repo.dir, root: repo.root, number: 12, head: repo.head, branch: "feature", pushUrl: "origin", instructions: "restore one", checks: [], runChecks: async () => [], sessions: editor(), now: () => NOW, ...extra })
}
const keptRefs = async (repo: Awaited<ReturnType<typeof repository>>) => (await repo.git(repo.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/mendcode/")).split("\n").filter(Boolean)

describe("runFix publishes safely", () => {
  test("a branch that moved while the fix ran is stale: nothing is pushed and the commit is kept on a local ref", async () => {
    const repo = await repository()
    const done = await fixIn(repo, { sessions: editor(() => repo.git(repo.dir, "push", "-q", "origin", `${repo.moved}:refs/heads/feature`)) })
    expect(done).toMatchObject({ ok: false, stale: true, kept: `refs/mendcode/fix/12/${NOW}`, sessionId: "ses_fix" })
    expect(!done.ok && done.reason).toContain("moved")
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.moved)
    // The kept commit is the fix on top of the head it started from, readable from the user's repository after the worktree is gone.
    const kept = !done.ok ? done.kept! : ""
    expect(await repo.git(repo.dir, "rev-parse", `${kept}^`)).toBe(repo.head)
    expect(await repo.git(repo.dir, "show", `${kept}:a.ts`)).toBe("export const one = 1")
    expect(!done.ok && done.commit).toBe(await repo.git(repo.dir, "rev-parse", kept))
    expect((await repo.git(repo.dir, "worktree", "list")).split("\n")).toHaveLength(1)
  })

  test("a push the remote refuses loses nothing: the commit stays on its kept ref and the branch is untouched", async () => {
    const repo = await repository()
    const hook = path.join(repo.origin, "hooks", "pre-receive")
    writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n")
    chmodSync(hook, 0o755)
    const done = await fixIn(repo)
    expect(done).toMatchObject({ ok: false, kept: `refs/mendcode/fix/12/${NOW}` })
    expect(!done.ok && done.reason).toBe("git push was refused")
    expect(!done.ok && done.stale).toBeUndefined()
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
    expect(await keptRefs(repo)).toHaveLength(1)
  })

  test("fix.push off commits and keeps the fix locally and pushes nothing", async () => {
    const repo = await repository()
    const done = await fixIn(repo, { push: false })
    expect(done).toMatchObject({ ok: true, pushed: false, kept: `refs/mendcode/fix/12/${NOW}` })
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
    expect(await repo.git(repo.dir, "show", `refs/mendcode/fix/12/${NOW}:a.ts`)).toBe("export const one = 1")
  })

  test("a closed PR, a revoked permission or a moved base keeps the fix and pushes nothing; a held job does not even start the session", async () => {
    const repo = await repository()
    const closed = await fixIn(repo, { stillOpen: async () => false })
    expect(closed).toMatchObject({ ok: false, reason: "the pull request is no longer open" })
    const revoked = await fixIn(repo, { now: () => NOW + 1, mayPush: async () => "maintainer no longer has write access to acme/app" })
    expect(revoked).toMatchObject({ ok: false, reason: "maintainer no longer has write access to acme/app", kept: `refs/mendcode/fix/12/${NOW + 1}` })
    await repo.git(repo.dir, "push", "-q", "origin", `${repo.head}:refs/heads/main`)
    const rebased = await fixIn(repo, { now: () => NOW + 2, base: { branch: "main", sha: repo.base } })
    expect(rebased).toMatchObject({ ok: false, stale: true })
    expect(!rebased.ok && rebased.reason).toContain("base `main` moved")
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
    expect(await keptRefs(repo)).toHaveLength(3)
    const seen: string[] = []
    const held = await fixIn(repo, { controlOf: () => "user", sessions: editor(async () => {}, seen) })
    expect(held).toMatchObject({ ok: false })
    expect(seen).toEqual([])
  })

  test("a push that lands removes the local ref, records the session and is a plain fast-forward of the head", async () => {
    const repo = await repository()
    const sessions: string[] = []
    const done = await fixIn(repo, { stillOpen: async () => true, mayPush: async () => true, base: { branch: "main", sha: repo.base }, onSession: (id) => sessions.push(id) })
    expect(done).toMatchObject({ ok: true, pushed: true, sessionId: "ses_fix" })
    expect(sessions).toEqual(["ses_fix"])
    expect(await repo.git(repo.origin, "rev-parse", "feature^")).toBe(repo.head)
    expect(await keptRefs(repo)).toEqual([])
  })
})

describe("@mendcode fix replies and revalidation", () => {
  const sha = "c".repeat(40)
  test("the reply says what was pushed, what was kept where, and when the branch moved", () => {
    expect(fixReply({ ok: true, commit: sha, pushed: true })).toBe(`Pushed ${sha.slice(0, 12)} to this branch.`)
    const local = fixReply({ ok: true, commit: sha, pushed: false, kept: "refs/mendcode/fix/12/1" })
    expect(local).toContain("did not push it: `fix.push` is off")
    expect(local).toContain("`refs/mendcode/fix/12/1`")
    const stale = fixReply({ ok: false, reason: "the branch moved from aaa to bbb while the fix ran", commit: sha, kept: "refs/mendcode/fix/12/2", stale: true })
    expect(stale).toStartWith("Nothing was pushed: the branch moved")
    expect(stale).toContain(`\`refs/mendcode/fix/12/2\` (commit ${sha.slice(0, 12)})`)
    expect(stale).toContain("redo it on the new head")
    expect(fixReply({ ok: false, reason: "[PR_REVIEW]: the fix session changed nothing" })).toBe("Nothing was pushed: the fix session changed nothing")
  })

  test("the guards read the PR's state and the commenter's access again; a failed read counts as no", async () => {
    let state = "open", level = "write"
    const gh: GhCall = async ({ argv }) => argv[1] === "repos/acme/app/pulls/12" ? { code: 0, out: state } : argv[1]?.endsWith("/permission") ? { code: 0, out: level } : { code: 1, out: "" }
    let pushable = true
    const guards = fixGuards({ gh, repo: "acme/app", number: 12, actor: "maintainer", pushable: async () => pushable })
    expect([await guards.stillOpen(), await guards.mayPush()]).toEqual([true, true])
    state = "closed"
    level = "read"
    expect(await guards.stillOpen()).toBe(false)
    expect(await guards.mayPush()).toBe("maintainer no longer has write access to acme/app")
    level = "write"
    pushable = false
    expect(await guards.mayPush()).toBe("the branch no longer accepts pushes from maintainers")
    const offline = fixGuards({ gh: async () => ({ code: 1, out: "" }), repo: "acme/app", number: 12, actor: "maintainer", pushable: async () => true })
    expect(await offline.stillOpen()).toBe(false)
  })

  test("@mendcode fix hands fix.push and the guards to the fix, and replies with where the kept commit is", async () => {
    const posts: string[] = []
    const gh: GhCall = async ({ argv, stdin }) => {
      if (argv[1]?.endsWith("/permission")) return { code: 0, out: "write" }
      if (argv.includes("POST")) { posts.push(JSON.parse(stdin!).body); return { code: 0, out: "{}" } }
      return { code: 1, out: "" }
    }
    const comment: CommandComment = { id: 5, surface: "issue", actor: "maintainer", body: "@mendcode fix the parser" }
    const asked: Array<{ push: boolean; open: boolean }> = []
    const result: FixResult = { ok: true, commit: "d".repeat(40), pushed: false, kept: "refs/mendcode/fix/12/9" }
    await runPrCommand({ kind: "fix", arg: "the parser" }, {
      gh, repo: "acme/app", number: 12, comment, state: emptyState(),
      review: async () => ({ status: "x", posted: false }), explain: async () => "",
      fixesAllowed: async () => true, pushable: async () => true, pushAllowed: async () => false,
      fix: async ({ push, guards }) => { asked.push({ push, open: await guards.stillOpen() }); return result },
    })
    expect(asked).toEqual([{ push: false, open: false }])
    expect(posts[0]).toContain("`fix.push` is off")
    expect(posts[0]).toContain("refs/mendcode/fix/12/9")
  })
})
