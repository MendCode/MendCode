import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanBenches, cleanBenchTemplates, bench, type Bench } from "../../../packages/daemon/test/git-actions-bench"
import { gitPrKey, createGitPrState, renderGitPrPage } from "../src/view/git-pr-page"
import { cleanTemps } from "./session-ui-harness"
import { frame, gitApp, keys, settle, type GitApp } from "./git-page-helpers"

afterEach(() => { cleanTemps(); cleanBenches() })
afterAll(cleanBenchTemplates)

const URL = "https://github.com/acme/widgets/pull/42"
const ON = { experimental: { git_actions: true } }
const VIEW = JSON.stringify({
  number: 42, title: "Git page: tabs", url: URL, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", headRefName: "feat/x", baseRefName: "main",
  author: { login: "mara" }, comments: [], reviews: [],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "linux / typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "windows / test", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "linux / test", status: "IN_PROGRESS" },
  ],
})

const open = async (app: GitApp, command = "/git pr") => { await app.h.type(`${command}\r`); await settle(); await settle(); app.h.app.render() }
const sentOf = (app: GitApp, type: string) => app.h.sent.filter((command) => command.type === type)
const ghWorks = (b: Bench, stdout = VIEW) => b.gh.reply({ stdout })

/** A branch of the bench with `count` commits on top of main, not pushed anywhere. */
function branch(count = 1, name = "feat/x") {
  const b = bench()
  b.checkout(name)
  for (let index = 1; index <= count; index++) b.commit(`Change ${index}`)
  b.clearCalls()
  return b
}
const pushedBranch = (count = 1) => { const b = branch(count); b.sh("push", "-q", "-u", "origin", "feat/x"); b.clearCalls(); return b }
const prApp = (b: Bench, extra: Partial<Parameters<typeof gitApp>[0]> = {}) => gitApp({ bench: b, settings: ON, height: 36, ...extra })

describe("the gate", () => {
  test("with the switch off the tab is one line, nothing is sent to the daemon and no git or gh process starts", async () => {
    const b = pushedBranch()
    const app = await gitApp({ bench: b, height: 30 })
    await open(app)
    expect(app.h.app.page).toBe("git-pr")
    expect(frame(app.h)).toContain("Off: this tab uses the network · /experimental git_actions on")
    for (const key of ["u", "P", "o", "r"]) await keys(app.h, key)
    expect(sentOf(app, "git.pr.view")).toHaveLength(0)
    expect(sentOf(app, "git.push")).toHaveLength(0)
    expect(sentOf(app, "git.pr.create")).toHaveLength(0)
    expect(b.gh.calls()).toEqual([])
    expect(b.pushes()).toEqual([])
    expect(frame(app.h)).not.toMatch(/push|create PR|copy link/)
  })

  test("the Commit tab is the same with the switch off or on: no push or pull request hint", async () => {
    const b = pushedBranch()
    const off = await gitApp({ bench: b, height: 30 })
    await open(off, "/git commit")
    const on = await gitApp({ bench: b, settings: ON, height: 30 })
    await open(on, "/git commit")
    expect(frame(off.h)).toBe(frame(on.h))
    expect(frame(off.h)).not.toMatch(/push|pull request/i)
  })

  test("features.git_actions false says it is blocked, and sends nothing", async () => {
    const b = pushedBranch()
    const app = await gitApp({ bench: b, settings: { experimental: { git_actions: true }, features: { git_actions: false } }, height: 30 })
    await open(app)
    expect(frame(app.h)).toContain("Blocked by features.git_actions")
    expect(sentOf(app, "git.pr.view")).toHaveLength(0)
    expect(b.gh.calls()).toEqual([])
  })

  test("minimalist never offers it: the switch alone does not turn the tab on", async () => {
    const b = pushedBranch()
    const app = await gitApp({ bench: b, tier: "minimalist", settings: ON, height: 30 })
    await open(app)
    expect(frame(app.h)).toContain("the Git page needs the balanced tier")
    expect(app.h.app.page).not.toBe("git-pr")
    expect(sentOf(app, "git.pr.view")).toHaveLength(0)
    expect(b.gh.calls()).toEqual([])
  })
})

describe("the PR tab", () => {
  test("shows the pull request: title, number, state, base and head, checks with the failing and pending names, review, mergeability and the link", async () => {
    const b = pushedBranch()
    ghWorks(b)
    const app = await prApp(b)
    await open(app)
    const text = frame(app.h)
    expect(text).toContain("#42  Git page: tabs")
    expect(text).toContain("feat/x → main · open")
    expect(text).toContain(URL)
    expect(text).toContain("checks   1 passed · 1 failed · 1 pending")
    expect(text).toContain("✗ windows / test")
    expect(text).toContain("… linux / test")
    expect(text).toContain("changes requested")
    expect(text).toContain("mergeable")
    expect(text).toContain("u push · o copy link · r refresh · esc back")
    expect(b.gh.calls()[0]!.argv.slice(0, 2)).toEqual(["pr", "view"])
  })

  test("o and a click on the link copy it and print it, since the terminal has no browser to open", async () => {
    const b = pushedBranch()
    ghWorks(b)
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "o")
    expect(app.h.written.join("")).toContain("\x1b]52;")
    expect(frame(app.h)).toContain(`link copied · ${URL}`)
    app.h.written.length = 0
    const row = app.h.text().findIndex((line) => line.includes(URL))
    await app.h.app.onKey(`\x1b[<0;${app.h.text()[row]!.indexOf(URL) + 2};${row + 1}M`)
    await app.h.app.onKey(`\x1b[<0;${app.h.text()[row]!.indexOf(URL) + 2};${row + 1}m`)
    expect(app.h.written.join("")).toContain("\x1b]52;")
  })

  test("a branch without a pull request says so and offers the push and the new pull request", async () => {
    const b = pushedBranch()
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    expect(frame(app.h)).toContain("No pull request for feat/x.")
    expect(frame(app.h)).toContain("u push · P create PR · r refresh · esc back")
  })

  test("gh not installed, not logged in and no remote are one clear line each", async () => {
    const b = pushedBranch()
    const missing = await prApp(b, { actionEnv: b.withoutGh })
    await open(missing)
    expect(frame(missing.h)).toContain("gh is not installed or not on PATH")
    b.gh.reply({ stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 })
    const anon = await prApp(b)
    await open(anon)
    expect(frame(anon.h)).toContain("gh is not logged in: run gh auth login in your shell")
    const bare = bench({ remote: false })
    const none = await prApp(bare)
    await open(none)
    expect(frame(none.h)).toMatch(/no remote/i)
  })
})

describe("push", () => {
  test("u shows the card: leaves this machine, the exact command with -u when there is no upstream, the remote, the commits and what is not done", async () => {
    const b = branch(2)
    const app = await prApp(b)
    ghWorks(b, "")
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    await open(app)
    await keys(app.h, "u")
    const text = frame(app.h)
    expect(text).toContain("leaves this machine")
    expect(text).toContain("git push --no-recurse-submodules --no-follow-tags -u origin feat/x")
    expect(text).toContain("remote origin")
    expect(text).toContain("2 commits will be sent")
    expect(text).toContain("Change 2")
    expect(text).toContain("not done: no force, no tags, no other branch, no pull request")
    expect(text).toContain("enter push · esc cancel")
    expect(b.pushes()).toEqual([])
    expect(sentOf(app, "git.push").map((command) => (command as { preview?: boolean }).preview)).toEqual([true])
  })

  test("enter pushes with the plan shown, and only then; the branch reaches the remote and the card is gone", async () => {
    const b = branch(1)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "u")
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
    await keys(app.h, "\r")
    await settle()
    app.h.app.render()
    expect(b.remoteRef("refs/heads/feat/x")).toBe(b.sh("rev-parse", "HEAD").trim())
    expect(b.pushes()).toHaveLength(1)
    expect(b.pushes()[0]).not.toContain("--force")
    expect(frame(app.h)).toContain("pushed feat/x to origin · 1 commit")
    expect(frame(app.h)).not.toContain("leaves this machine")
  })

  test("esc cancels the card and nothing is pushed", async () => {
    const b = branch(1)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "u", "\x1b")
    expect(frame(app.h)).not.toContain("leaves this machine")
    expect(b.pushes()).toEqual([])
    expect(sentOf(app, "git.push").every((command) => (command as { preview?: boolean }).preview === true)).toBe(true)
  })

  test("a protected branch needs its name typed: enter alone does nothing, a wrong name does nothing, the name pushes", async () => {
    const b = bench()
    b.commit("On main")
    b.clearCalls()
    b.gh.reply({ stderr: 'no pull requests found for branch "main"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "u")
    expect(frame(app.h)).toContain("main is protected here: type its name to confirm")
    expect(frame(app.h)).toContain("type the branch name · enter push · esc cancel")
    await keys(app.h, "\r")
    expect(frame(app.h)).toContain("type main to confirm")
    expect(b.pushes()).toEqual([])
    await app.h.type("mai")
    await keys(app.h, "\r")
    expect(b.pushes()).toEqual([])
    await app.h.type("n")
    await keys(app.h, "\r")
    await settle()
    expect(b.pushes()).toHaveLength(1)
    expect(b.remoteRef("refs/heads/main")).toBe(b.sh("rev-parse", "HEAD").trim())
  })

  test("a rejected push shows what git said and that the page does not force; the remote keeps its commit", async () => {
    const b = pushedBranch()
    const other = b.other()
    other.git("fetch", "-q", "origin", "feat/x")
    other.git("checkout", "-q", "-b", "feat/x", "origin/feat/x")
    other.commit("Someone else")
    other.git("push", "-q", "origin", "feat/x")
    const theirs = b.remoteRef("refs/heads/feat/x")
    b.commit("Mine")
    b.clearCalls()
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "u", "\r")
    await settle()
    app.h.app.render()
    const text = frame(app.h)
    expect(text).toMatch(/rejected|non-fast-forward/i)
    expect(text).toContain("the page never forces")
    expect(text).toContain("leaves this machine")
    expect(b.remoteRef("refs/heads/feat/x")).toBe(theirs)
    expect(b.pushes().flat()).not.toContain("--force")
  })
})

describe("create pull request", () => {
  test("P on a branch that is not pushed says to push first and opens nothing", async () => {
    const b = branch(1)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "P")
    expect(frame(app.h)).toContain("push first")
    expect(app.h.text().join("\n")).not.toContain("Body")
    expect(b.gh.calls().filter((call) => call.argv[1] === "create")).toEqual([])
  })

  test("the form is prefilled from the commits; the card shows the exact command; enter creates with the body on standard input", async () => {
    const b = pushedBranch(2)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "P")
    let text = frame(app.h)
    expect(text).toContain("feat/x → main")
    expect(text).toContain("Change 2")
    expect(text).toContain("Change 1")
    expect(text).toContain("tab next")
    // Replace the body with one that would hurt if a shell ever saw it.
    await keys(app.h, "\t")
    for (let index = 0; index < 200; index++) await app.h.app.onKey("\x7f")
    const hostile = "it's \"quoted\"\n`touch pwned`\n$(touch pwned2)\n--web"
    for (const char of hostile) await app.h.app.onKey(char === "\n" ? "\x1b\r" : char)
    await keys(app.h, "\t", "\t", "\r")
    text = frame(app.h)
    expect(text).toContain("Confirm · create pull request")
    expect(text).toContain("leaves this machine")
    expect(text).toContain("gh pr create --base main --head feat/x")
    expect(text).toContain("on standard input, never in the command")
    expect(text).toContain("enter create the pull request · esc edit")
    expect(b.gh.calls().filter((call) => call.argv[1] === "create")).toEqual([])
    b.gh.reply({ stdout: `${URL}\n` })
    await keys(app.h, "\r")
    await settle()
    app.h.app.render()
    const created = b.gh.calls().filter((call) => call.argv[1] === "create")
    expect(created).toHaveLength(1)
    expect(created[0]!.argv.join(" ")).not.toContain("touch pwned")
    expect(created[0]!.argv).toContain("--body-file")
    expect(created[0]!.stdin).toBe(hostile)
    expect(frame(app.h)).toContain(`opened #42 ${URL}`)
  })

  test("esc on the card goes back to the form with what was typed; an empty title is one line, not a card", async () => {
    const b = pushedBranch(1)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "P")
    for (let index = 0; index < 100; index++) await app.h.app.onKey("\x7f")
    await keys(app.h, "\t", "\t", "\r")
    expect(frame(app.h)).toContain("empty title")
    expect(frame(app.h)).not.toContain("Confirm · create")
    await app.h.type("A title")
    await keys(app.h, "\t", "\t", "\t", "\r")
    expect(frame(app.h)).toContain("Confirm · create pull request")
    await keys(app.h, "\x1b")
    expect(frame(app.h)).toContain("A title")
    expect(frame(app.h)).not.toContain("Confirm · create")
  })

  test("a failing gh keeps the card and shows what it printed, with secrets masked", async () => {
    const b = pushedBranch(1)
    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    const app = await prApp(b)
    await open(app)
    await keys(app.h, "P", "\t", "\t", "\t", "\r")
    expect(frame(app.h)).toContain("Confirm · create pull request")
    const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`
    b.gh.reply({ stderr: `GraphQL: boom ${token}`, exit: 1 })
    await keys(app.h, "\r")
    await settle()
    app.h.app.render()
    expect(frame(app.h)).toContain("Confirm · create pull request")
    expect(frame(app.h)).toContain("GraphQL: boom")
    expect(frame(app.h)).not.toContain(token)
  })
})

describe("the view", () => {
  test("every frame fits its width and its height, wide and narrow", () => {
    const state = createGitPrState()
    state.body = { kind: "none", branch: "feat/a-very-long-branch-name/that-keeps-going-and-going" }
    for (const width of [120, 80, 60, 40]) for (const height of [10, 20, 30]) {
      const rows = renderGitPrPage({ state, width, height })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(row.map((span) => span.text).join("").length).toBeLessThanOrEqual(width)
    }
  })

  test("keys do nothing while an action runs", () => {
    const state = { ...createGitPrState(), stage: "running" as const, doing: "pushing…" }
    for (const key of ["\r", "\x1b", "u", "P"]) expect(gitPrKey(state, key).action).toEqual({ type: "none" })
  })
})
