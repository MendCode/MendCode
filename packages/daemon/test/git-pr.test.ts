import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { denyingRule } from "../src/git-actions-policy"
import { gitPrCreate, gitPrView } from "../src/git-pr"
import { gitPush } from "../src/git-push"
import { GitActionRefusal } from "../src/git-remote"
import { bench, cleanBenches, cleanBenchTemplates, type Bench } from "./git-actions-bench"

afterEach(cleanBenches)
afterAll(cleanBenchTemplates)

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`
const URL = "https://github.com/acme/widgets/pull/42"

type Create = Partial<Parameters<typeof gitPrCreate>[0]>
const create = (b: Bench, extra: Create = {}) => gitPrCreate({ directory: b.dir, env: b.env, ...extra })
const view = (b: Bench, extra: Partial<Parameters<typeof gitPrView>[0]> = {}) => gitPrView({ directory: b.dir, env: b.env, ...extra })
async function refusal(run: () => Promise<unknown>) {
  try { await run() } catch (error) { if (error instanceof GitActionRefusal) return error.message; throw error }
  return undefined
}
/** A pushed branch with `count` commits on top of main, level with its upstream. */
async function pushed(count = 1, branch = "feat/x") {
  const b = bench()
  b.checkout(branch)
  for (let index = 1; index <= count; index++) b.commit(`Change ${index}`)
  await gitPush({ directory: b.dir, env: b.env })
  b.clearCalls()
  return b
}

const VIEW = JSON.stringify({
  number: 42, title: "Git page: tabs", url: URL, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", headRefName: "feat/x", baseRefName: "main",
  author: { login: "mara" }, comments: [], reviews: [],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "linux / typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "windows / test", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "linux / test", status: "IN_PROGRESS" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
  ],
})

describe("git.pr.view reads the branch's pull request", () => {
  test("title, number, state, base and head, the checks with the failing and the pending names, the review and the mergeability", async () => {
    const b = await pushed()
    b.gh.reply({ stdout: VIEW })
    const done = await view(b)
    expect(done.branch).toBe("feat/x")
    expect(done.pr).toEqual({
      number: 42, title: "Git page: tabs", url: URL, state: "open", draft: false, base: "main", head: "feat/x",
      checks: { pass: 1, fail: 1, pending: 1, skip: 1 }, failing: ["windows / test"], pending: ["linux / test"], review: "CHANGES_REQUESTED", mergeable: "mergeable",
    })
    expect(b.gh.calls()).toHaveLength(1)
    expect(b.gh.calls()[0]!.argv.slice(0, 3)).toEqual(["pr", "view", "--json"])
    expect(b.pushes()).toEqual([])
  })

  test("a branch without a pull request is a result, not an error", async () => {
    const b = await pushed()
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    expect(await view(b)).toEqual({ branch: "feat/x" })
  })

  test("gh missing, not logged in, failing, slow and answering nonsense are one line each", async () => {
    const b = await pushed()
    expect(await refusal(() => view(b, { env: b.withoutGh }))).toBe("[GIT]: gh is not installed or not on PATH")
    b.gh.reply({ stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 })
    expect(await refusal(() => view(b))).toBe("[GIT]: gh is not logged in: run gh auth login in your shell")
    b.gh.reply({ stderr: `GraphQL: boom ${TOKEN}\nsecond line`, exit: 1 })
    const failing = (await refusal(() => view(b)))!
    expect(failing).toBe("[GIT]: gh could not read the pull request: GraphQL: boom [redacted:github-token]")
    b.gh.reply({ stdout: "<html>", exit: 0 })
    expect(await refusal(() => view(b))).toContain("not a pull request")
    b.gh.reply({ sleep: 20 })
    expect(await refusal(() => view(b, { timeoutMs: 300 }))).toContain("timed out")
  })

  test("no remote and a detached HEAD are one line, and gh is not started", async () => {
    const none = bench({ remote: false })
    none.checkout("feat/x")
    expect(await refusal(() => view(none))).toContain("no remote")
    const detached = await pushed()
    detached.sh("checkout", "-q", "--detach")
    expect(await refusal(() => view(detached))).toContain("detached HEAD")
    expect(none.gh.calls()).toHaveLength(0)
    expect(detached.gh.calls()).toHaveLength(0)
  })

  test("a permission rule that denies gh refuses the read before gh starts", async () => {
    const b = await pushed()
    const message = await refusal(() => view(b, { denied: denyingRule({ settings: { permission: { bash: { "gh *": "deny" } } } as never, directory: b.dir }) }))
    expect(message).toContain('your permission rule bash "gh *" denies')
    expect(b.gh.calls()).toHaveLength(0)
  })
})

describe("git.pr.create asks gh for exactly one pull request", () => {
  test("the command is gh pr create with the base, the head, the title as one argument and the body on standard input", async () => {
    const b = await pushed(2)
    b.gh.reply({ stdout: `Creating pull request for feat/x into main in acme/widgets\n\n${URL}\n` })
    const done = await create(b, { title: "Git page: tabs", body: "Two commits.\n\n- one\n- two" })
    expect(done).toMatchObject({ created: true, url: URL, number: 42 })
    expect(done.plan.argv).toEqual(["gh", "pr", "create", "--base", "main", "--head", "feat/x", "--title=Git page: tabs", "--body-file", "-"])
    expect(b.gh.calls()).toEqual([{ argv: ["pr", "create", "--base", "main", "--head", "feat/x", "--title=Git page: tabs", "--body-file", "-"], stdin: "Two commits.\n\n- one\n- two" }])
  })

  test("draft adds --draft and nothing else changes", async () => {
    const b = await pushed()
    b.gh.reply({ stdout: URL })
    const done = await create(b, { title: "T", body: "B", draft: true })
    expect(done.plan.argv.at(-1)).toBe("--draft")
    expect(b.gh.calls()[0]!.argv).toEqual(["pr", "create", "--base", "main", "--head", "feat/x", "--title=T", "--body-file", "-", "--draft"])
  })

  test("a title and body full of quotes, newlines, backticks, $() and a leading dash arrive as written and nothing is run", async () => {
    const b = await pushed()
    b.gh.reply({ stdout: URL })
    const title = `-Fix "quotes" & 'single' $(touch pwned-title) \`touch pwned-tick\` ; rm -rf / | cat > x`
    const body = `line "one"\n  $(touch pwned-body)\n\`backticks\`\n'single' \\ back\\slash\n\${HOME} $HOME\n\n    indented\nunicode: ñ 日本 🎉\n`
    await create(b, { title, body })
    const [call] = b.gh.calls()
    expect(call!.argv).toEqual(["pr", "create", "--base", "main", "--head", "feat/x", `--title=${title}`, "--body-file", "-"])
    expect(call!.stdin).toBe(body.trim())
    for (const name of ["pwned-title", "pwned-tick", "pwned-body", "x"]) for (const root of [b.base, b.dir, process.cwd()]) expect(existsSync(path.join(root, name))).toBe(false)
  })

  test("a title that is not one line, an empty title and an oversized body are refused and gh is not started", async () => {
    const b = await pushed()
    expect(await refusal(() => create(b, { title: "two\nlines", body: "" }))).toContain("one line")
    expect(await refusal(() => create(b, { title: "bell\u0007", body: "" }))).toContain("one line")
    expect(await refusal(() => create(b, { title: "   ", body: "" }))).toContain("empty title")
    expect(await refusal(() => create(b, { title: "T", body: "x".repeat(16_001) }))).toContain("invalid or too long")
    expect(await refusal(() => create(b, { title: "T", body: "nul\0byte" }))).toContain("invalid or too long")
    expect(b.gh.calls()).toHaveLength(0)
  })

  test("a preview runs nothing and carries the prefill: the subject of the single commit, or the branch name; the subjects as the body", async () => {
    const one = await pushed(1)
    const single = await create(one, { preview: true })
    expect(single.created).toBe(false)
    expect(single.plan).toMatchObject({ branch: "feat/x", base: "main", remote: "origin", pushed: true, commitsTotal: 1, defaults: { title: "Change 1", body: "- Change 1" } })
    const many = await pushed(3)
    const plan = (await create(many, { preview: true })).plan
    expect(plan.defaults).toEqual({ title: "feat/x", body: "- Change 1\n- Change 2\n- Change 3" })
    expect(plan.commits.map((commit) => commit.subject)).toEqual(["Change 1", "Change 2", "Change 3"])
    expect(plan.title).toBe("feat/x")
    expect(one.gh.calls()).toHaveLength(0)
    expect(many.gh.calls()).toHaveLength(0)
  })

  test("the base is the remote's default branch, can be another, and a base that is not a safe name is refused", async () => {
    const b = await pushed()
    b.sh("push", "-q", "origin", "main:release")
    expect((await create(b, { preview: true })).plan.base).toBe("main")
    expect((await create(b, { preview: true, base: "release" })).plan.argv).toContain("release")
    for (const hostile of ["--web", "a..b", "x:y", "a b"]) expect(await refusal(() => create(b, { preview: true, base: hostile })), hostile).toContain("cannot be used from the page")
    expect(await refusal(() => create(b, { preview: true, base: "feat/x" }))).toContain("is the base branch")
    expect(b.gh.calls()).toHaveLength(0)
  })

  test("with no way to tell the base the preview says so and a real run is refused until one is typed", async () => {
    const b = await pushed()
    b.sh("remote", "set-head", "origin", "--delete")
    b.sh("update-ref", "-d", "refs/remotes/origin/main")
    const preview = await create(b, { preview: true })
    expect(preview.plan.base).toBe("")
    expect(await refusal(() => create(b, { title: "T", body: "" }))).toBe("[GIT]: cannot tell the base branch: type it")
    expect(b.gh.calls()).toHaveLength(0)
  })
})

describe("the branch must be on its upstream first, and the page never pushes for it", () => {
  test("a branch that is not pushed, one with commits the upstream lacks, and one behind it are refused with what to do", async () => {
    const fresh = bench()
    fresh.checkout("feat/x")
    fresh.commit("Only here")
    expect((await create(fresh, { preview: true })).plan).toMatchObject({ pushed: false, pushNote: "feat/x is not on origin yet" })
    expect(await refusal(() => create(fresh, { title: "T", body: "" }))).toBe("[GIT]: push first: feat/x is not on origin yet")

    const ahead = await pushed()
    ahead.commit("One more")
    ahead.commit("And another")
    expect((await create(ahead, { preview: true })).plan.pushNote).toBe("2 commits are not on origin/feat/x")
    expect(await refusal(() => create(ahead, { title: "T", body: "" }))).toContain("push first: 2 commits are not on origin/feat/x")

    const behind = await pushed()
    const other = behind.other()
    other.git("fetch", "-q", "origin")
    other.git("checkout", "-q", "-b", "feat/x", "--track", "origin/feat/x")
    other.commit("Theirs")
    other.git("push", "-q", "origin", "feat/x")
    behind.sh("fetch", "-q", "origin")
    expect((await create(behind, { preview: true })).plan.pushNote).toContain("has 1 commit this branch lacks")
    expect(await refusal(() => create(behind, { title: "T", body: "" }))).toContain("update the branch first")

    for (const b of [fresh, ahead, behind]) { expect(b.gh.calls()).toHaveLength(0); expect(b.pushes()).toEqual([]) }
  })
})

describe("what goes wrong with gh", () => {
  test("gh missing, not logged in, failing, slow: one line each, the failure's output redacted, and the repository is free afterwards", async () => {
    const b = await pushed()
    expect(await refusal(() => create(b, { title: "T", body: "", env: b.withoutGh }))).toBe("[GIT]: gh is not installed or not on PATH")
    b.gh.reply({ stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 })
    expect(await refusal(() => create(b, { title: "T", body: "" }))).toBe("[GIT]: gh is not logged in: run gh auth login in your shell")
    b.gh.reply({ stderr: `a pull request for branch "feat/x" into branch "main" already exists:\n${URL}\nhttps://deploy:${TOKEN}@host.example/x token ${TOKEN}`, exit: 1 })
    const failed = (await refusal(() => create(b, { title: "T", body: "" })))!
    expect(failed).toContain("gh could not create the pull request (exit 1)")
    expect(failed).toContain("already exists")
    expect(failed).not.toContain(TOKEN)
    expect(failed).not.toContain("deploy:")
    b.gh.reply({ sleep: 20 })
    const started = Date.now()
    expect(await refusal(() => create(b, { title: "T", body: "", timeoutMs: 400 }))).toContain("gh timed out")
    expect(Date.now() - started).toBeLessThan(10_000)
    b.gh.reply({ stdout: URL })
    expect((await create(b, { title: "T", body: "" })).created).toBe(true)
  })

  test("success with no link in gh's output is still a created pull request, without a link", async () => {
    const b = await pushed()
    b.gh.reply({ stdout: "done\n" })
    expect(await create(b, { title: "T", body: "" })).toMatchObject({ created: true })
    b.gh.reply({ stdout: "https://evil.example/x\n--web https://github.com/a/b/pull/0\n" })
    expect((await create(b, { title: "T", body: "" })).url).toBeUndefined()
  })

  test("a permission rule that denies gh pr create refuses it and gh is not started; so does a rule on the plain command", async () => {
    const b = await pushed()
    for (const pattern of ["gh pr create *", "gh *", "gh pr create"]) {
      const message = await refusal(() => create(b, { title: "T", body: "", denied: denyingRule({ settings: { permission: { bash: { [pattern]: "deny" } } } as never, directory: b.dir }) }))
      expect(message, pattern).toContain(`your permission rule bash "${pattern}" denies`)
    }
    expect(b.gh.calls()).toHaveLength(0)
  })

  test("gh gets no prompt and no relocated repository", async () => {
    const b = await pushed()
    b.gh.reply({ stdout: URL })
    const seen = path.join(b.base, "gh-env")
    const script = path.join(b.base, "bin", "gh")
    await Bun.write(script, `#!/bin/sh\ncat > /dev/null\nenv | grep -E '^(GH_PROMPT_DISABLED|GIT_TERMINAL_PROMPT|GIT_DIR|GIT_WORK_TREE|NO_COLOR)=' | sort > "${seen}"\necho ${URL}\n`)
    await create(b, { title: "T", body: "", env: { ...b.env, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent" } })
    expect((await Bun.file(seen).text()).trim().split("\n")).toEqual(["GH_PROMPT_DISABLED=1", "GIT_TERMINAL_PROMPT=0", "NO_COLOR=1"])
  })
})
