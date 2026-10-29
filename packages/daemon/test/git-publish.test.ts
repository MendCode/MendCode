import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { GIT_PUBLISH_MAX_DESCRIPTION, publishNameProblem, publishOwnerProblem } from "@mendcode/protocol"
import { denyingRule } from "../src/git-actions-policy"
import { GitActionRefusal } from "../src/git-remote"
import { gitPublish, publishArgv } from "../src/git-publish"
import { cleanBenches, cleanBenchTemplates } from "./git-actions-bench"
import { publishBench, type PublishBench } from "./git-publish-bench"

afterEach(cleanBenches)
afterAll(cleanBenchTemplates)

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`
const URL = "https://github.com/me/widgets"

const publish = (b: PublishBench, extra: Partial<Parameters<typeof gitPublish>[0]> = {}) => gitPublish({ directory: b.dir, env: b.env, ...extra })
async function refusal(run: () => Promise<unknown>) {
  try { await run() } catch (error) { if (error instanceof GitActionRefusal) return error.message; throw error }
  return undefined
}
/** A bench whose repository is named `widgets` for the account `me`. */
function ready() {
  const b = publishBench()
  b.user()
  b.addsRemote(`${URL}.git`)
  b.gh.reply({ stdout: URL })
  b.clearCalls()
  return b
}
const expectedArgv = (b: PublishBench, tail: string[] = []) => ["gh", "repo", "create", `me/${b.dir.split("/").at(-1)}`, "--private", "--source", b.dir, "--remote", "origin", ...tail]

describe("git.publish creates a private repository and adds the remote, and nothing else", () => {
  test("the command is gh repo create <owner>/<name> --private --source <root> --remote origin, with the owner read from gh and the folder's name; the page pushes nothing", async () => {
    const b = ready()
    const done = await publish(b)
    expect(done).toMatchObject({ published: true, url: URL, origin: `${URL}.git` })
    expect(done.plan.argv).toEqual(expectedArgv(b))
    expect(done.plan).toMatchObject({ repo: `me/${b.dir.split("/").at(-1)}`, owner: "me", visibility: "private", remote: "origin", head: "branch", branch: "main", commits: 1 })
    expect(b.ghCalls()).toEqual([["api", "user", "--jq", ".login"], expectedArgv(b).slice(1)])
    expect(b.pushes()).toEqual([])
    expect(b.sh("remote", "get-url", "origin").trim()).toBe(`${URL}.git`)
  })

  test("a preview creates nothing: only the account is read, and the plan names the command", async () => {
    const b = ready()
    const done = await publish(b, { preview: true })
    expect(done.published).toBe(false)
    expect(done.plan.argv).toEqual(expectedArgv(b))
    expect(b.ghCalls()).toEqual([["api", "user", "--jq", ".login"]])
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("a typed owner is used as it is and gh is not asked who you are; the description is one --description= word", async () => {
    const b = ready()
    const done = await publish(b, { owner: "acme-org", name: "widgets", description: "Small widgets for the shop" })
    expect(done.plan.argv).toEqual(["gh", "repo", "create", "acme-org/widgets", "--private", "--source", b.dir, "--remote", "origin", "--description=Small widgets for the shop"])
    expect(b.ghCalls()).toEqual([done.plan.argv.slice(1)])
  })

  test("a repository with no commit yet may be published, and so may a detached HEAD: only a remote is added", async () => {
    const b = ready()
    b.sh("checkout", "-q", "--orphan", "fresh")
    const unborn = await publish(b, { preview: true })
    expect(unborn.plan).toMatchObject({ head: "unborn", commits: 0, branch: "fresh" })
    const c = ready()
    c.sh("checkout", "-q", "--detach")
    const detached = await publish(c)
    expect(detached).toMatchObject({ published: true, plan: { head: "detached", commits: 1 } })
    expect(c.hasRemote("origin")).toBe(true)
  })

  test("no input makes the command public, internal or pushing, and no text becomes a flag: every name, owner and description is fuzzed", async () => {
    const hostile = ["--public", "--internal", "--push", "-p", "--private=false", "x --public", "x;--public", "$(id)", "`id`", "a b", "../x", "x/y", "x\n--public", "'; --internal", "-", ".", "..", ".x", "x.git", "é", "", "a".repeat(101), "name\0", "\u001b[31mred"]
    const b = ready()
    let accepted = 0
    for (const value of hostile) {
      for (const fields of [{ name: value }, { owner: value }, { description: value }, { name: "ok", owner: value, description: value }]) {
        const message = await refusal(async () => {
          const done = await publish(b, { preview: true, ...fields, ...("owner" in fields ? {} : { owner: "me" }) })
          accepted++
          const argv = done.plan.argv
          expect(argv.includes("--private")).toBe(true)
          expect(argv.filter((word) => ["--public", "--internal", "--push", "--private=false"].includes(word))).toEqual([])
          expect(argv.filter((word) => word.startsWith("-") && !word.startsWith("--description="))).toEqual(["--private", "--source", "--remote"])
          expect(argv).toHaveLength(argv.some((word) => word.startsWith("--description=")) ? 10 : 9)
          expect(argv[3]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/)
        })
        if (message) expect(message).toMatch(/^\[GIT\]: /)
      }
    }
    expect(accepted).toBeGreaterThan(0)
    // Nothing was created while fuzzing, and the pure builder agrees.
    expect(b.creates()).toEqual([])
    for (const description of ["--public", "--push", "x --internal"]) expect(publishArgv({ owner: "me", name: "x", root: "/r", description }).filter((word) => word.startsWith("-"))).toEqual(["--private", "--source", "--remote", `--description=${description}`])
    expect(() => publishArgv({ owner: "--public", name: "x", root: "/r" })).toThrow("[GIT]")
    expect(() => publishArgv({ owner: "me", name: "-x", root: "/r" })).toThrow("[GIT]")
  })

  test("a real run with hostile text in the description is one create with one description word and --private, and the remote is added", async () => {
    const b = ready()
    const description = "--public --push $(touch pwned); `id` \"quoted\" 'single'"
    const done = await publish(b, { owner: "me", name: "widgets", description })
    expect(done.published).toBe(true)
    expect(b.creates()).toEqual([["repo", "create", "me/widgets", "--private", "--source", b.dir, "--remote", "origin", `--description=${description}`]])
    expect(b.exists("pwned")).toBe(false)
  })

  test("names and owners: what GitHub takes is accepted, the rest is one line and nothing runs", async () => {
    for (const fine of ["widgets", "My.Repo_2", "a", "_x", "a-b", "9", "a".repeat(100)]) expect(publishNameProblem(fine)).toBeUndefined()
    for (const bad of ["", ".hidden", "-x", "a b", "a/b", "x.git", "x.GIT", "é", "a".repeat(101), "a\nb", "a;b"]) expect(publishNameProblem(bad)).toEqual(expect.any(String))
    for (const fine of ["me", "acme-org", "a1", "name_corp"]) expect(publishOwnerProblem(fine)).toBeUndefined()
    for (const bad of ["", "-me", "a b", "a/b", "é", "a".repeat(61)]) expect(publishOwnerProblem(bad)).toEqual(expect.any(String))
    const b = ready()
    expect(await refusal(() => publish(b, { name: "" }))).toBe("[GIT]: the repository name is empty")
    expect(await refusal(() => publish(b, { name: ".x", owner: "me" }))).toBe("[GIT]: the repository name cannot start with . or -")
    expect(await refusal(() => publish(b, { name: "ok", owner: "" }))).toBe("[GIT]: the owner is empty")
    expect(await refusal(() => publish(b, { name: "ok", owner: "me", description: "a\nb" }))).toBe("[GIT]: the description must be one line of text")
    expect(await refusal(() => publish(b, { name: "ok", owner: "me", description: "x".repeat(GIT_PUBLISH_MAX_DESCRIPTION + 1) }))).toContain("too long")
    expect(b.creates()).toEqual([])
  })

  test("the default name is the folder's, cleaned to what GitHub takes", async () => {
    const b = ready()
    b.sh("config", "user.name", "T")
    const done = await publish(b, { preview: true })
    expect(publishNameProblem(done.plan.name)).toBeUndefined()
    expect(done.plan.defaults).toEqual({ name: done.plan.name, owner: "me" })
  })
})

describe("what it refuses", () => {
  test("a remote named origin is never replaced or renamed: refused before gh is started, with its address masked", async () => {
    const b = ready()
    b.sh("remote", "add", "origin", `https://user:${TOKEN}@example.test/x/y.git`)
    const message = await refusal(() => publish(b))
    expect(message).toContain("a remote named origin already exists")
    expect(message).toContain("https://***@example.test/x/y.git")
    expect(message).not.toContain(TOKEN)
    expect(b.ghCalls()).toEqual([])
    expect(b.sh("remote", "get-url", "origin").trim()).toBe(`https://user:${TOKEN}@example.test/x/y.git`)
  })

  test("another remote is no obstacle; a half-configured origin is", async () => {
    const b = ready()
    b.sh("remote", "add", "upstream", "https://example.test/u/v.git")
    expect((await publish(b, { preview: true })).plan.repo).toContain("me/")
    b.sh("config", "remote.origin.pushurl", "https://example.test/p/q.git")
    expect(await refusal(() => publish(b, { preview: true }))).toContain("origin already exists")
  })

  test("not a repository is the usual line", async () => {
    const b = ready()
    expect(await refusal(() => publish(b, { directory: b.base }))).toBe("[GIT]: not a git repository")
  })

  test("a deny rule of permission.bash refuses it, whichever line it matches, and names the rule; nothing is created", async () => {
    for (const rule of ["gh repo create *", "gh repo create me/*", "gh repo create", "gh *"]) {
      const b = ready()
      const denied = denyingRule({ settings: { permission: { bash: { [rule]: "deny" } } } as never, directory: b.dir })
      const message = await refusal(() => publish(b, { owner: "me", name: "widgets", denied }))
      expect(message).toContain(`your permission rule bash "${rule}" denies`)
      expect(b.creates()).toEqual([])
      expect(b.hasRemote("origin")).toBe(false)
    }
    const b = ready()
    const full = denyingRule({ settings: { permission: { bash: { [`gh repo create me/widgets --private --source ${b.dir} --remote origin`]: "deny" } } } as never, directory: b.dir })
    expect(await refusal(() => publish(b, { owner: "me", name: "widgets", denied: full }))).toContain("denies")
    expect(await refusal(() => publish(b, { owner: "me", name: "widgets", preview: true, denied: full }))).toContain("denies")
    const account = denyingRule({ settings: { permission: { bash: { "gh api user": "deny" } } } as never, directory: b.dir })
    expect(await refusal(() => publish(b, { denied: account }))).toContain('your permission rule bash "gh api user" denies')
    expect(b.ghCalls()).toEqual([])
    // An allow rule changes nothing: the page always asks on its own card.
    const allowed = denyingRule({ settings: { permission: { bash: { "gh *": "allow" } } } as never, directory: b.dir })
    expect((await publish(b, { owner: "me", name: "widgets", preview: true, denied: allowed })).published).toBe(false)
  })
})

describe("gh's own errors, one line each, redacted", () => {
  test("gh missing: nothing is created, for the account read and for the creation", async () => {
    const b = ready()
    const env = b.withoutGh
    expect(await refusal(() => publish(b, { env }))).toBe("[GIT]: gh is not installed or not on PATH")
    expect(await refusal(() => publish(b, { env, owner: "me", name: "widgets" }))).toBe("[GIT]: gh is not installed or not on PATH")
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("gh not logged in", async () => {
    const b = ready()
    b.user({ stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 })
    expect(await refusal(() => publish(b))).toBe("[GIT]: gh is not logged in: run gh auth login in your shell")
    b.addsRemote(undefined)
    b.gh.reply({ stderr: "authentication required: run gh auth login", exit: 4 })
    expect(await refusal(() => publish(b, { owner: "me", name: "widgets" }))).toBe("[GIT]: gh is not logged in: run gh auth login in your shell")
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("name taken and organization not permitted: gh's first line, with nothing left behind", async () => {
    const b = ready()
    b.addsRemote(undefined)
    b.gh.reply({ stderr: "GraphQL: Name already exists on this account (createRepository)", exit: 1 })
    expect(await refusal(() => publish(b, { owner: "me", name: "widgets" }))).toBe("[GIT]: gh could not create the repository: GraphQL: Name already exists on this account (createRepository)")
    b.gh.reply({ stderr: "GraphQL: me-org does not have permission to create repositories (createRepository)", exit: 1 })
    expect(await refusal(() => publish(b, { owner: "me-org", name: "widgets" }))).toBe("[GIT]: gh could not create the repository: GraphQL: me-org does not have permission to create repositories (createRepository)")
    expect(b.hasRemote("origin")).toBe(false)
    expect(b.creates()).toHaveLength(2)
  })

  test("a failure of the account read that is neither is one line too", async () => {
    const b = ready()
    b.user({ stderr: "HTTP 502: Bad Gateway", exit: 1 })
    expect(await refusal(() => publish(b))).toBe("[GIT]: gh could not read your account: HTTP 502: Bad Gateway")
    b.user({ stdout: "not an account name\n" })
    expect(await refusal(() => publish(b))).toBe("[GIT]: gh returned something that is not an account name")
  })

  test("what gh printed is shown without secrets, and credentials in an address are masked", async () => {
    const b = ready()
    b.addsRemote(undefined)
    b.gh.reply({ stderr: `GraphQL: bad (createRepository)\ntoken ${TOKEN}\nsee https://user:${TOKEN}@example.test/x`, exit: 1 })
    const message = (await refusal(() => publish(b, { owner: "me", name: "widgets" })))!
    expect(message).not.toContain(TOKEN)
    expect(message).toContain("https://***@example.test/x")
    expect(message.split("\n")[0]).toBe("[GIT]: gh could not create the repository: GraphQL: bad (createRepository)")
  })
})

describe("when only part of it happened", () => {
  test("the repository was created and printed, but the remote was not added: what exists, what to run, and nothing is deleted or retried", async () => {
    const b = ready()
    b.addsRemote(undefined)
    b.gh.reply({ stdout: URL, stderr: 'X Unable to add remote "origin"', exit: 1 })
    const message = (await refusal(() => publish(b, { owner: "me", name: "widgets" })))!
    const lines = message.replace("[GIT]: ", "").split("\n")
    expect(lines[0]).toBe("publish incomplete: me/widgets was created, gh failed (exit 1)")
    expect(lines).toContain("now: this repository has no remote named origin")
    expect(lines).toContain(`on GitHub: ${URL}`)
    expect(lines).toContain(`run: git remote add origin ${URL}`)
    expect(lines).toContain("nothing was deleted and nothing is retried")
    expect(lines).toContain('X Unable to add remote "origin"')
    expect(b.creates()).toHaveLength(1)
    expect(b.ghCalls().some((call) => call.includes("delete"))).toBe(false)
    expect(b.hasRemote("origin")).toBe(false)
    expect(b.pushes()).toEqual([])
  })

  test("the other way round: the remote is there although gh failed; the answer says where it points", async () => {
    const b = ready()
    b.gh.reply({ stderr: "X Failed to configure the repository", exit: 1 })
    const message = (await refusal(() => publish(b, { owner: "me", name: "widgets" })))!
    expect(message).toContain("publish incomplete: gh failed (exit 1) after adding origin")
    expect(message).toContain(`now: origin points to ${URL}.git`)
    expect(message).toContain("run: nothing to add; push from the PR tab when you are ready")
    expect(b.creates()).toHaveLength(1)
    expect(b.hasRemote("origin")).toBe(true)
  })

  test("gh said it worked but there is no origin: reported, with the address to add", async () => {
    const b = ready()
    b.addsRemote(undefined)
    const message = (await refusal(() => publish(b, { owner: "me", name: "widgets" })))!
    expect(message).toContain("publish incomplete: gh reported success but origin was not added")
    expect(message).toContain(`run: git remote add origin ${URL}`)
    expect(b.creates()).toHaveLength(1)
  })

  test("a timeout says the repository may or may not exist, kills gh and retries nothing", async () => {
    const b = ready()
    b.addsRemote(undefined)
    b.gh.reply({ sleep: 5 })
    const started = Date.now()
    const message = (await refusal(() => publish(b, { owner: "me", name: "widgets", timeoutMs: 300 })))!
    expect(Date.now() - started).toBeLessThan(4000)
    expect(message).toContain("gh timed out after 0s: me/widgets may or may not exist on GitHub")
    expect(message).toContain("on GitHub: unknown, check whether me/widgets exists before trying again")
    expect(message).toContain("run: git remote add origin <the address of me/widgets>")
    expect(b.creates()).toHaveLength(1)
  })

  test("one publish at a time per repository", async () => {
    const b = ready()
    b.gh.reply({ stdout: URL, sleep: 1 })
    const first = publish(b, { owner: "me", name: "widgets" })
    while (b.creates().length === 0) await Bun.sleep(20)
    expect(await refusal(() => publish(b, { owner: "me", name: "widgets" }))).toContain("is running in this repository")
    expect(await first).toMatchObject({ published: true })
  })
})
