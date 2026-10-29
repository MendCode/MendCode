import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { denyingRule } from "../src/git-actions-policy"
import { gitCommit } from "../src/git-commit"
import { gitPush } from "../src/git-push"
import { GitActionRefusal, maskUrl, safeRefName, shownMasked } from "../src/git-remote"
import { bench, cleanBenches, cleanBenchTemplates, type Bench } from "./git-actions-bench"

afterEach(cleanBenches)
afterAll(cleanBenchTemplates)

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`

const push = (b: Bench, extra: Partial<Parameters<typeof gitPush>[0]> = {}) => gitPush({ directory: b.dir, env: b.env, ...extra })
async function refusal(run: () => Promise<unknown>) {
  try { await run() } catch (error) { if (error instanceof GitActionRefusal) return error.message; throw error }
  return undefined
}
/** A bench on a branch of its own with `count` commits the remote does not have. */
function featured(count = 1, branch = "feat/x") {
  const b = bench()
  b.checkout(branch)
  for (let index = 1; index <= count; index++) b.commit(`Change ${index}`)
  b.clearCalls()
  return b
}

describe("git.push sends the current branch and nothing else", () => {
  test("a branch with no upstream is pushed with -u origin <branch>; the remote has it and the branch tracks it afterwards", async () => {
    const b = featured(2)
    const done = await push(b)
    expect(done.pushed).toBe(true)
    expect(done.plan).toMatchObject({ branch: "feat/x", remote: "origin", setUpstream: true, commitsTotal: 2, protected: false })
    expect(done.plan.argv).toEqual(["git", "push", "--no-recurse-submodules", "--no-follow-tags", "-u", "origin", "feat/x"])
    expect(b.remoteRef("refs/heads/feat/x")).toBe(b.sh("rev-parse", "HEAD").trim())
    expect(b.sh("rev-parse", "--abbrev-ref", "feat/x@{upstream}").trim()).toBe("origin/feat/x")
    expect(b.pushes()).toEqual([["push", "--no-recurse-submodules", "--no-follow-tags", "-u", "origin", "feat/x"]])
  })

  test("a branch with an upstream is pushed without -u, and only the new commits are in the plan", async () => {
    const b = featured(1)
    await push(b)
    b.commit("Second")
    b.commit("Third")
    b.clearCalls()
    const done = await push(b)
    expect(done.plan).toMatchObject({ setUpstream: false, upstream: "origin/feat/x", commitsTotal: 2 })
    expect(done.plan.commits.map((commit) => commit.subject)).toEqual(["Third", "Second"])
    expect(done.plan.argv).toEqual(["git", "push", "--no-recurse-submodules", "--no-follow-tags", "origin", "feat/x"])
    expect(b.remoteRef("refs/heads/feat/x")).toBe(b.sh("rev-parse", "HEAD").trim())
  })

  test("a preview runs no push and changes nothing; it names the remote, its address and the commits that would go", async () => {
    const b = featured(3)
    const before = b.remoteRef("refs/heads/feat/x")
    const done = await push(b, { preview: true })
    expect(done.pushed).toBe(false)
    expect(done.plan).toMatchObject({ remote: "origin", url: b.remote, commitsTotal: 3 })
    expect(done.plan.commits.map((commit) => commit.subject)).toEqual(["Change 3", "Change 2", "Change 1"])
    expect(b.pushes()).toEqual([])
    expect(b.remoteRef("refs/heads/feat/x")).toBe(before)
    expect(() => b.sh("config", "--get", "branch.feat/x.merge")).toThrow()
  })

  test("the remote is the branch's own, not origin, when it has one", async () => {
    const b = featured(1)
    b.sh("remote", "add", "fork", b.remote)
    b.sh("config", "branch.feat/x.remote", "fork")
    const done = await push(b, { preview: true })
    expect(done.plan).toMatchObject({ remote: "fork", argv: ["git", "push", "--no-recurse-submodules", "--no-follow-tags", "-u", "fork", "feat/x"] })
  })

  test("no command line ever carries a force, a tag, a mirror, a deletion or a refspec of its own", async () => {
    const b = featured(1)
    for (const extra of [{ preview: true }, {}]) {
      const { plan } = await push(b, extra)
      for (const word of plan.argv) expect(word).not.toMatch(/^--(force|force-with-lease|tags|all|mirror|delete|prune)\b|^-[a-zA-Z]*f|^\+|:/)
    }
    expect(b.pushes()).toHaveLength(1)
    expect(b.pushes()[0]!.filter((word) => !word.startsWith("--no-"))).toEqual(["push", "-u", "origin", "feat/x"])
  })

  test("push.followTags and a submodule setting in the user's config add nothing: the flags override them", async () => {
    const b = featured(1)
    b.sh("config", "push.followTags", "true")
    b.sh("config", "push.recurseSubmodules", "on-demand")
    b.sh("tag", "-a", "v9", "-m", "release")
    await push(b)
    expect(b.remoteRef("refs/tags/v9")).toBeUndefined()
    expect(b.remoteRef("refs/heads/feat/x")).toBeDefined()
  })

  test("only the current branch goes: another branch with commits stays local", async () => {
    const b = featured(1)
    b.sh("branch", "other-work", "feat/x")
    b.sh("checkout", "-q", "other-work")
    b.commit("Not this one")
    b.sh("checkout", "-q", "feat/x")
    await push(b)
    expect(b.remoteRef("refs/heads/other-work")).toBeUndefined()
  })
})

describe("a push that git rejects is shown as git printed it, and never forced", () => {
  test("the remote moved on: git rejects, the page says it does not force, and the remote keeps the other commit", async () => {
    const b = featured(1)
    await push(b)
    const other = b.other()
    other.git("fetch", "-q", "origin")
    other.git("checkout", "-q", "-b", "feat/x", "--track", "origin/feat/x")
    other.commit("Theirs")
    other.git("push", "-q", "origin", "feat/x")
    const theirs = b.remoteRef("refs/heads/feat/x")
    b.commit("Mine")
    const message = await refusal(() => push(b))
    expect(message).toContain("push rejected")
    expect(message).toContain("never forces")
    expect(message).toMatch(/rejected|fetch first/)
    expect(b.remoteRef("refs/heads/feat/x")).toBe(theirs)
    expect(b.pushes().every((call) => !call.some((word) => /force/.test(word)))).toBe(true)
  })

  test("when this machine already knows the remote is ahead, the plan says how far and the push is still rejected", async () => {
    const b = featured(1)
    await push(b)
    const other = b.other()
    other.git("fetch", "-q", "origin")
    other.git("checkout", "-q", "-b", "feat/x", "--track", "origin/feat/x")
    other.commit("Theirs")
    other.git("push", "-q", "origin", "feat/x")
    b.commit("Mine")
    b.sh("fetch", "-q", "origin")
    const preview = await push(b, { preview: true })
    expect(preview.plan).toMatchObject({ behind: 1, commitsTotal: 1 })
    const message = await refusal(() => push(b))
    expect(message).toMatch(/push rejected/)
    expect(message).toMatch(/non-fast-forward|rejected/)
  })

  test("the user's pre-push hook can refuse; its output comes back and nothing was pushed", async () => {
    const b = featured(1)
    b.hook("pre-push", `echo "blocked: token ${TOKEN}"\nexit 1`)
    const preview = await push(b, { preview: true })
    expect(preview.plan.hooks).toEqual(["pre-push"])
    const message = await refusal(() => push(b))
    expect(message).toContain("push failed")
    expect(message).toContain("blocked")
    expect(message).not.toContain(TOKEN)
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
  })
})

describe("protected branches need their name typed", () => {
  function onMain() {
    const b = bench()
    b.commit("On main")
    b.clearCalls()
    return b
  }

  test("main is protected: no confirmation and a wrong one are refused, the right one pushes", async () => {
    const b = onMain()
    expect((await push(b, { preview: true })).plan.protected).toBe(true)
    expect(await refusal(() => push(b))).toContain("type its name")
    expect(await refusal(() => push(b, { confirm: "mian" }))).toContain("type its name")
    expect(b.pushes()).toEqual([])
    const done = await push(b, { confirm: "main" })
    expect(done.pushed).toBe(true)
    expect(b.remoteRef("refs/heads/main")).toBe(b.sh("rev-parse", "HEAD").trim())
  })

  test("master and the remote's default branch are protected, an ordinary branch is not", async () => {
    const b = bench()
    b.sh("checkout", "-q", "-b", "master")
    b.commit("On master")
    expect((await push(b, { preview: true })).plan.protected).toBe(true)
    const trunk = bench()
    trunk.sh("push", "-q", "origin", "main:trunk")
    trunk.sh("remote", "set-head", "origin", "trunk")
    trunk.sh("checkout", "-q", "-b", "trunk", "origin/trunk")
    trunk.commit("On trunk")
    expect((await push(trunk, { preview: true })).plan.protected).toBe(true)
    const plain = featured(1)
    expect((await push(plain, { preview: true })).plan.protected).toBe(false)
    expect(await refusal(() => push(plain))).toBeUndefined()
  })
})

describe("names that could be read as options or refspecs are refused before anything runs", () => {
  test("safeRefName rejects a leading dash, .., a colon, control characters, spaces and glob characters", () => {
    for (const bad of ["-x", "--upload-pack=evil", "a..b", "a:b", "a\nb", "a\tb", "a b", "a*b", "a?b", "a[b", "a\\b", "a~1", "a^", "@{u}", "/a", "a/", "a//b", "x.lock", "", "a\u0000b"]) expect(safeRefName(bad)).toBe(false)
    for (const good of ["main", "feat/x", "fix-1.2", "mend/work-ab12", "user/éa"]) expect(safeRefName(good)).toBe(true)
  })

  test("a branch that starts with a dash is refused and no push is started", async () => {
    const b = featured(1)
    b.sh("symbolic-ref", "HEAD", "refs/heads/--upload-pack=evil")
    b.sh("commit", "-q", "--allow-empty", "-m", "weird")
    b.clearCalls()
    const message = await refusal(() => push(b))
    expect(message).toContain("cannot be used from the page")
    expect(b.pushes()).toEqual([])
  })

  test("a remote name from the branch's config that starts with a dash, has .., or a colon is refused", async () => {
    for (const hostile of ["--receive-pack=touch pwned", "-u", "a..b", "a:b", "x y"]) {
      const b = featured(1)
      b.sh("config", "branch.feat/x.remote", hostile)
      const message = await refusal(() => push(b))
      expect(message, hostile).toContain("cannot be used from the page")
      expect(b.pushes()).toEqual([])
      expect(existsSync(path.join(b.dir, "pwned"))).toBe(false)
    }
  })

  test("a remote the branch names but the repository does not have is refused with its name", async () => {
    const b = featured(1)
    b.sh("config", "branch.feat/x.remote", "ghost")
    expect(await refusal(() => push(b))).toContain("not configured")
  })

  test("a branch that tracks another name on the remote is refused, never pushed to a new name", async () => {
    const b = featured(1)
    b.sh("push", "-q", "origin", "feat/x:feat/y")
    b.sh("branch", "--set-upstream-to=origin/feat/y", "feat/x")
    b.commit("More")
    expect(await refusal(() => push(b))).toContain("under another name")
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
  })
})

describe("it refuses in one line and pushes nothing", () => {
  test("no remote, nothing to push, a detached HEAD, a folder that is not a repository", async () => {
    const noRemote = bench({ remote: false })
    noRemote.checkout("feat/x")
    expect(await refusal(() => push(noRemote))).toBe("[GIT]: this repository has no remote: add one with git remote add origin <url>")
    const noOrigin = bench()
    noOrigin.sh("remote", "rename", "origin", "upstream")
    noOrigin.checkout("feat/x")
    expect(await refusal(() => push(noOrigin))).toContain("no remote named origin")
    const level = featured(1)
    await push(level)
    expect(await refusal(() => push(level))).toContain("nothing to push")
    const fresh = bench()
    fresh.checkout("empty")
    expect(await refusal(() => push(fresh))).toContain("nothing to push")
    const detached = featured(1)
    detached.sh("checkout", "-q", "--detach")
    expect(await refusal(() => push(detached))).toContain("detached HEAD")
    try { await gitPush({ directory: detached.base, env: detached.env }); throw new Error("expected a refusal") } catch (error) { expect(error).toMatchObject({ code: "not_git" }) }
    for (const b of [noRemote, noOrigin, level, fresh, detached]) expect(b.pushes().length).toBeLessThanOrEqual(1)
  })

  test("a permission rule that denies the command refuses it, names the rule, and nothing runs", async () => {
    const b = featured(1)
    const message = await refusal(() => push(b, { denied: denyingRule({ settings: { permission: { bash: { "git push *": "deny" } } } as never, directory: b.dir }) }))
    expect(message).toContain('your permission rule bash "git push *" denies')
    expect(b.pushes()).toEqual([])
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
  })
})

describe("what the user's permission.bash rules say", () => {
  const settings = (rules: Record<string, string>) => ({ permission: { bash: rules } }) as never
  const lines = ["git push --no-recurse-submodules --no-follow-tags -u origin feat/x", "git push -u origin feat/x", "git push origin feat/x", "git push"]

  test("a deny of git push, of that exact command, or of every git command is matched; an allow or an unrelated rule is not", () => {
    const denied = (rules: Record<string, string>) => denyingRule({ settings: settings(rules), directory: "/p" })(lines)
    expect(denied({ "git push *": "deny" })).toContain("git push *")
    expect(denied({ "git push origin feat/x": "deny" })).toContain("git push origin feat/x")
    expect(denied({ "git *": "deny" })).toContain("git *")
    expect(denied({ "*": "deny" })).toContain('"*"')
    expect(denied({ "git push *": "allow" })).toBeUndefined()
    expect(denied({ "git commit *": "deny" })).toBeUndefined()
    expect(denied({ "git *": "deny", "git push *": "allow" })).toBeUndefined()
  })

  test("the project's saved rules and the session's own rules count too", () => {
    const project = { projectConfig: { "/p": { permission: { bash: { "git push *": "deny" } } } } } as never
    expect(denyingRule({ settings: project, directory: "/p" })(lines)).toContain("git push *")
    expect(denyingRule({ settings: {} as never, directory: "/p", session: [{ permission: "bash", pattern: "git push *", action: "deny" }] })(lines)).toContain("git push *")
    expect(denyingRule({ settings: {} as never, directory: "/p" })(lines)).toBeUndefined()
  })
})

describe("credentials in a remote's address never show", () => {
  test("maskUrl and shownMasked hide the user and token of an address, wherever it appears", () => {
    expect(maskUrl(`https://x-access-token:${TOKEN}@github.com/acme/widgets.git`)).toBe("https://***@github.com/acme/widgets.git")
    expect(maskUrl("https://user:pw@host.example/a.git")).toBe("https://***@host.example/a.git")
    expect(maskUrl("git@github.com:acme/widgets.git")).toBe("git@github.com:acme/widgets.git")
    expect(maskUrl("ssh://git@host.example/a.git")).toBe("ssh://***@host.example/a.git")
    expect(maskUrl("/srv/git/a.git")).toBe("/srv/git/a.git")
    expect(shownMasked(`fatal: unable to access 'https://deploy:${TOKEN}@host.example/a.git/': Could not resolve host`)).toBe("fatal: unable to access 'https://***@host.example/a.git/': Could not resolve host")
  })

  test("the card's address is masked, and so is a push that fails against that address", async () => {
    const b = featured(1)
    b.sh("remote", "set-url", "origin", `http://x-access-token:${TOKEN}@127.0.0.1:1/acme/widgets.git`)
    const preview = await push(b, { preview: true })
    expect(preview.plan.url).toBe("http://***@127.0.0.1:1/acme/widgets.git")
    expect(JSON.stringify(preview)).not.toContain(TOKEN)
    const message = (await refusal(() => push(b, { timeoutMs: 20_000 })))!
    expect(message).toContain("push failed")
    expect(message).not.toContain(TOKEN)
    expect(message).not.toContain("x-access-token")
  })
})

describe("limits", () => {
  test("a push that never ends is killed at the deadline and the repository is free for the next one", async () => {
    const b = featured(1)
    b.hook("pre-push", "sleep 30")
    const started = Date.now()
    const message = await refusal(() => push(b, { timeoutMs: 400 }))
    expect(message).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
    b.hook("pre-push", "exit 0")
    expect((await push(b)).pushed).toBe(true)
  })

  test("a commit running in the same repository holds the push off, and the push never runs", async () => {
    const b = featured(1)
    b.hook("pre-commit", "sleep 1")
    b.write("slow.txt", "slow\n")
    const commit = gitCommit({ directory: b.dir, message: "Slow", paths: ["slow.txt"], env: b.env })
    await Bun.sleep(400)
    const message = await refusal(() => push(b))
    expect(message).toContain("another commit, push or pull request is running")
    await commit
    expect(b.pushes()).toEqual([])
  })

  test("what git prints is bounded to its last lines", async () => {
    const b = featured(1)
    b.hook("pre-push", `i=0; while [ $i -lt 500 ]; do echo "line $i"; i=$((i+1)); done\nexit 1`)
    const message = (await refusal(() => push(b)))!
    expect(message.split("\n").length).toBeLessThanOrEqual(22)
    expect(message).toContain("line")
  })

  test("git is started with no prompt, no askpass and no relocation variables, in an environment of its own", async () => {
    const b = featured(1)
    b.hook("pre-push", `env | grep -E '^(GIT_TERMINAL_PROMPT|GIT_ASKPASS|SSH_ASKPASS|GIT_DIR|GIT_WORK_TREE|GCM_INTERACTIVE|SSH_ASKPASS_REQUIRE)=' > "${path.join(b.base, "seen-env")}" || true\nexit 0`)
    await gitPush({ directory: b.dir, env: { ...b.env, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent", SSH_ASKPASS: "/usr/bin/evil-askpass", GIT_ASKPASS: "/usr/bin/evil-askpass" } })
    const seen = (await Bun.file(path.join(b.base, "seen-env")).text()).split("\n").filter(Boolean).sort()
    expect(seen).toEqual(["GCM_INTERACTIVE=never", "GIT_ASKPASS=false", "GIT_TERMINAL_PROMPT=0", "SSH_ASKPASS_REQUIRE=never"])
  })
})
