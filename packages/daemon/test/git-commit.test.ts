import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, isReadOnlyCommand, GIT_COMMIT_MAX_PATHS } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { GitCommitRefusal, gitCommit } from "../src/git-commit"
import { remoteTokens } from "../src/remote"

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An environment where no global or system git config and no identity from the machine can leak in. */
function isolated(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  for (const name of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER|DIR|WORK_TREE|INDEX)/.test(name)) delete env[name]
  return env
}

function made(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-gitcommit-${prefix}-`)))
  dirs.push(dir)
  return dir
}

function sh(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function repo(options: { identity?: boolean; commit?: boolean } = {}) {
  const base = made("repo")
  const dir = path.join(base, "repo")
  mkdirSync(dir)
  const env = isolated(path.join(base, "home"))
  mkdirSync(path.join(base, "home"))
  sh(dir, env, "init", "-q", "-b", "main")
  if (options.identity !== false) {
    sh(dir, env, "config", "user.name", "Tester")
    sh(dir, env, "config", "user.email", "tester@example.test")
  }
  const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }
  write("a.txt", "a1\n")
  write("b.txt", "b1\n")
  write("sub/c.txt", "c1\n")
  if (options.commit !== false) {
    sh(dir, env, "add", ".")
    sh(dir, env, "commit", "-q", "-m", "init")
  }
  const hook = (name: string, body: string) => { const file = path.join(dir, ".git", "hooks", name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755) }
  const commit = (paths: string[], message = "Selected change", extra: { preview?: boolean; directory?: string } = {}) => gitCommit({ directory: extra.directory ?? dir, message, paths, env, ...(extra.preview ? { preview: true } : {}) })
  const refusal = async (run: () => Promise<unknown>) => { try { await run() } catch (error) { if (error instanceof GitCommitRefusal) return error.message; throw error } return undefined }
  const files = (rev = "HEAD") => sh(dir, env, "show", "--name-only", "--no-renames", "--format=", rev).split("\n").filter(Boolean)
  return { base, dir, env, write, hook, commit, refusal, files, git: (...args: string[]) => sh(dir, env, ...args) }
}

describe("git.commit commits only what was selected", () => {
  test("a selected change is committed, the file that was not selected stays modified and unstaged", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    r.write("b.txt", "b2\n")
    const done = await r.commit(["a.txt"])
    expect(done).toMatchObject({ committed: true, subject: "Selected change" })
    expect(r.files()).toEqual(["a.txt"])
    expect(r.git("status", "--porcelain")).toBe(" M b.txt\n")
    expect(done.plan.argv).toEqual(["git", "commit", "-m", "Selected change", "--", "a.txt"])
  })

  test("an untracked file is added and committed, and a tracked change in the same selection goes with it", async () => {
    const r = repo()
    r.write("new.txt", "fresh\n")
    r.write("other-new.txt", "stays\n")
    r.write("sub/c.txt", "c2\n")
    const done = await r.commit(["new.txt", "sub/c.txt"])
    expect(done.plan.add).toEqual(["git", "add", "--", "new.txt"])
    expect(r.files().sort()).toEqual(["new.txt", "sub/c.txt"])
    expect(r.git("status", "--porcelain")).toBe("?? other-new.txt\n")
  })

  test("changes staged for other files are left out of the commit, still staged afterwards, and the plan names them", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    r.write("b.txt", "b2\n")
    r.git("add", "b.txt")
    const preview = await r.commit(["a.txt"], "Only a", { preview: true })
    expect(preview).toMatchObject({ committed: false, plan: { stagedElsewhere: ["b.txt"], stagedElsewhereTotal: 1 } })
    expect(r.git("status", "--porcelain")).toBe(" M a.txt\nM  b.txt\n")
    await r.commit(["a.txt"], "Only a")
    expect(r.files()).toEqual(["a.txt"])
    expect(r.git("status", "--porcelain")).toBe("M  b.txt\n")
  })

  test("the files a staged rename touches are committed together when both paths are selected", async () => {
    const r = repo()
    r.git("mv", "a.txt", "renamed.txt")
    r.write("b.txt", "b2\n")
    await r.commit(["a.txt", "renamed.txt"])
    expect(r.files().sort()).toEqual(["a.txt", "renamed.txt"])
    expect(r.git("status", "--porcelain")).toBe(" M b.txt\n")
  })

  test("the first commit of a new repository works", async () => {
    const r = repo({ commit: false })
    await r.commit(["a.txt", "sub/c.txt"], "Start")
    expect(r.files().sort()).toEqual(["a.txt", "sub/c.txt"])
    expect(r.git("status", "--porcelain")).toBe("?? b.txt\n")
  })

  test("a preview changes nothing: no commit, nothing staged", async () => {
    const r = repo()
    r.write("new.txt", "fresh\n")
    const before = r.git("rev-parse", "HEAD")
    const preview = await r.commit(["new.txt"], "Add new", { preview: true })
    expect(preview).toMatchObject({ committed: false, plan: { untracked: ["new.txt"], add: ["git", "add", "--", "new.txt"] } })
    expect(r.git("rev-parse", "HEAD")).toBe(before)
    expect(r.git("status", "--porcelain")).toBe("?? new.txt\n")
  })

  test("it runs exactly git commit -m <message> -- <paths>: no flag that skips hooks, rewrites, forces or stages everything", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    const done = await r.commit(["a.txt"], "Mentions --no-verify and --amend only in text")
    expect(done.plan.argv).toEqual(["git", "commit", "-m", "Mentions --no-verify and --amend only in text", "--", "a.txt"])
    for (const flag of ["--no-verify", "-n", "--amend", "--force", "-f", "-a", "--all", "--allow-empty"]) expect(done.plan.argv.slice(0, 3)).not.toContain(flag)
    expect(done.plan.argv.slice(4)).toEqual(["--", "a.txt"])
  })
})

describe("what git is given", () => {
  test("a message with newlines and a leading dash is stored as written", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    await r.commit(["a.txt"], "-fix: keep the dash\n\nsecond paragraph\n- a list item\n# not a comment")
    expect(r.git("log", "-1", "--format=%B").trim()).toBe("-fix: keep the dash\n\nsecond paragraph\n- a list item\n# not a comment")
  })

  test("a path that starts with a dash or a colon is a file name, never an option or a pathspec", async () => {
    const r = repo()
    r.write("-rf.txt", "dash\n")
    r.write(":(top)b.txt", "colon\n")
    r.write("b.txt", "b2\n")
    await r.commit(["-rf.txt", ":(top)b.txt"], "Odd names")
    expect(r.files().sort()).toEqual(["-rf.txt", ":(top)b.txt"])
    expect(r.git("status", "--porcelain")).toBe(" M b.txt\n")
  })

  test("a path with glob characters matches only itself", async () => {
    const r = repo()
    r.write("*.txt", "star\n")
    r.write("a.txt", "a2\n")
    await r.commit(["*.txt"], "Star")
    expect(r.files()).toEqual(["*.txt"])
    expect(r.git("status", "--porcelain")).toBe(" M a.txt\n")
  })
})

describe("paths stay inside the repository", () => {
  test("a path that climbs out with .. is refused and nothing is committed or staged", async () => {
    const r = repo()
    writeFileSync(path.join(r.base, "outside.txt"), "x\n")
    r.write("a.txt", "a2\n")
    const before = r.git("rev-parse", "HEAD")
    for (const bad of ["../outside.txt", "sub/../../outside.txt", "../repo/a.txt/../../outside.txt"]) expect(await r.refusal(() => r.commit(["a.txt", bad]))).toMatch(/outside the repository/)
    expect(r.git("rev-parse", "HEAD")).toBe(before)
    expect(r.git("status", "--porcelain")).toBe(" M a.txt\n")
  })

  test("an absolute path, .git and the repository root are refused", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    for (const bad of [path.join(r.dir, "a.txt"), ".git/config", ".git", ".", ""]) expect([bad, await r.refusal(() => r.commit([bad]))]).toEqual([bad, expect.stringMatching(/^\[GIT\]: /)])
    expect(r.git("log", "--format=%s")).toBe("init\n")
  })

  test("a symlink that leaves the repository is refused whether it is the path or a folder on the way", async () => {
    const r = repo()
    const outside = path.join(r.base, "elsewhere")
    mkdirSync(outside)
    writeFileSync(path.join(outside, "secret.txt"), "s\n")
    symlinkSync(outside, path.join(r.dir, "link"))
    symlinkSync(path.join(outside, "secret.txt"), path.join(r.dir, "file-link"))
    r.write("a.txt", "a2\n")
    expect(await r.refusal(() => r.commit(["link/secret.txt"]))).toMatch(/outside the repository/)
    expect(await r.refusal(() => r.commit(["file-link"]))).toMatch(/outside the repository/)
    expect(await r.refusal(() => r.commit(["a.txt", "link/new.txt"]))).toMatch(/outside the repository/)
    expect(r.git("log", "--format=%s")).toBe("init\n")
    expect(r.git("diff", "--cached", "--name-only")).toBe("")
  })

  test("a symlink that stays inside is committed as the link", async () => {
    const r = repo()
    symlinkSync("a.txt", path.join(r.dir, "inner-link"))
    await r.commit(["inner-link"], "Link")
    expect(r.files()).toEqual(["inner-link"])
    expect(r.git("ls-tree", "HEAD", "inner-link")).toContain("120000")
  })

  test("a folder is not a selection", async () => {
    const r = repo()
    r.write("sub/c.txt", "c2\n")
    expect(await r.refusal(() => r.commit(["sub"]))).toMatch(/sub: is a folder/)
  })

  test("a path with no change is refused by name", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    expect(await r.refusal(() => r.commit(["a.txt", "b.txt"]))).toBe("[GIT]: b.txt: no changes to commit")
  })
})

describe("it refuses in one line and commits nothing", () => {
  test("an empty message, nothing selected, too many paths", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    expect(await r.refusal(() => r.commit(["a.txt"], "  \n "))).toBe("[GIT]: empty message")
    expect(await r.refusal(() => r.commit([]))).toBe("[GIT]: nothing selected")
    expect(await r.refusal(() => r.commit(Array.from({ length: GIT_COMMIT_MAX_PATHS + 1 }, (_, n) => `f${n}`)))).toMatch(/too many files/)
    expect(r.git("log", "--format=%s")).toBe("init\n")
  })

  test("a detached HEAD", async () => {
    const r = repo()
    r.git("checkout", "-q", "--detach")
    r.write("a.txt", "a2\n")
    expect(await r.refusal(() => r.commit(["a.txt"]))).toMatch(/detached HEAD/)
  })

  test("a merge, a rebase, a cherry-pick or a revert in progress", async () => {
    const r = repo()
    r.write("a.txt", "a2\n")
    const head = r.git("rev-parse", "HEAD").trim()
    writeFileSync(path.join(r.dir, ".git", "MERGE_HEAD"), `${head}\n`)
    expect(await r.refusal(() => r.commit(["a.txt"]))).toMatch(/a merge is in progress/)
    rmSync(path.join(r.dir, ".git", "MERGE_HEAD"))
    mkdirSync(path.join(r.dir, ".git", "rebase-merge"))
    expect(await r.refusal(() => r.commit(["a.txt"]))).toMatch(/a rebase is in progress/)
    rmSync(path.join(r.dir, ".git", "rebase-merge"), { recursive: true })
    writeFileSync(path.join(r.dir, ".git", "CHERRY_PICK_HEAD"), `${head}\n`)
    expect(await r.refusal(() => r.commit(["a.txt"]))).toMatch(/a cherry-pick is in progress/)
    rmSync(path.join(r.dir, ".git", "CHERRY_PICK_HEAD"))
    writeFileSync(path.join(r.dir, ".git", "REVERT_HEAD"), `${head}\n`)
    expect(await r.refusal(() => r.commit(["a.txt"]))).toMatch(/a revert is in progress/)
    rmSync(path.join(r.dir, ".git", "REVERT_HEAD"))
    expect((await r.commit(["a.txt"])).committed).toBe(true)
  })

  test("no git identity", async () => {
    const r = repo({ identity: false, commit: false })
    expect(await r.refusal(() => r.commit(["a.txt"]))).toBe("[GIT]: no git identity: set user.name and user.email")
  })

  test("a folder that is not a repository", async () => {
    const dir = made("plain")
    const env = isolated(dir)
    try { await gitCommit({ directory: dir, message: "x", paths: ["a"], env }); throw new Error("committed") } catch (error) {
      expect(error).toBeInstanceOf(GitCommitRefusal)
      expect((error as GitCommitRefusal).code).toBe("not_git")
    }
  })
})

describe("the repository's hooks run and can refuse", () => {
  test("a pre-commit hook that passes runs, and the commit goes through", async () => {
    const r = repo()
    r.hook("pre-commit", `echo ran > "${path.join(r.base, "hook-ran")}"`)
    r.write("a.txt", "a2\n")
    const done = await r.commit(["a.txt"])
    expect(done.plan.hooks).toEqual(["pre-commit"])
    expect(done.committed).toBe(true)
    expect(readFileSync(path.join(r.base, "hook-ran"), "utf8")).toBe("ran\n")
  })

  test("a failing hook stops the commit, its output comes back redacted, and a new file is untracked again", async () => {
    const secret = `sk-proj-${"a1B2c3D4".repeat(5)}`
    const r = repo()
    r.hook("pre-commit", `echo "lint: trailing space in a.txt"\necho "token ${secret}"\nexit 1`)
    r.write("a.txt", "a2\n")
    r.write("new.txt", "fresh\n")
    const before = r.git("rev-parse", "HEAD")
    const message = await r.refusal(() => r.commit(["a.txt", "new.txt"]))
    expect(message).toMatch(/^\[GIT\]: commit failed \(exit 1\)\nlint: trailing space in a\.txt/)
    expect(message).not.toContain(secret)
    expect(r.git("rev-parse", "HEAD")).toBe(before)
    expect(r.git("status", "--porcelain")).toBe(" M a.txt\n?? new.txt\n")
  })

  test("a hook that never ends is killed at the deadline", async () => {
    const r = repo()
    r.hook("pre-commit", "sleep 30")
    r.write("a.txt", "a2\n")
    const started = Date.now()
    const message = await Promise.race([
      r.refusal(() => gitCommit({ directory: r.dir, message: "slow", paths: ["a.txt"], env: r.env, timeoutMs: 400 })),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 10_000)),
    ])
    expect(message).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(8000)
    expect(existsSync(path.join(r.dir, ".git", "index.lock"))).toBe(false)
  })
})

describe("the command", () => {
  const ids = createIdFactory()
  const shape = () => ({ type: "git.commit", id: ids("command"), clientId: ids("client"), directory: "/project", message: "m", paths: ["a.txt"] })

  test("takes a directory, a message and paths and nothing else, and is not a read-only command", () => {
    expect(Command.safeParse(shape()).success).toBe(true)
    expect(Command.safeParse({ ...shape(), preview: true }).success).toBe(true)
    for (const extra of [{ amend: true }, { noVerify: true }, { all: true }, { paths: "a.txt" }, { message: 4 }]) expect(Command.safeParse({ ...shape(), ...extra }).success).toBe(false)
    expect(isReadOnlyCommand("git.commit")).toBe(false)
  })

  async function boot() {
    const base = made("daemon")
    const project = path.join(base, "project")
    mkdirSync(project)
    const env = isolated(path.join(base, "home"))
    mkdirSync(path.join(base, "home"))
    // The daemon spawns git with its own environment: keep this machine's git config out of it for the length of the test.
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
    Object.assign(process.env, { HOME: env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })
    cleanups.push(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
    sh(project, env, "init", "-q", "-b", "main")
    sh(project, env, "config", "user.name", "Tester")
    sh(project, env, "config", "user.email", "tester@example.test")
    writeFileSync(path.join(project, "a.txt"), "a1\n")
    sh(project, env, "add", ".")
    sh(project, env, "commit", "-q", "-m", "init")
    writeFileSync(path.join(project, "a.txt"), "a2\n")
    const dir = path.join(base, "data")
    mkdirSync(dir)
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const local = createClient({ socketPath: daemon.socketPath, name: "local" })
    await local.connect()
    cleanups.push(() => local.close())
    async function remote(readOnly: boolean) {
      const token = remoteTokens(dir).create({ name: readOnly ? "ro" : "full", readOnly }).token
      const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
      await peer.connect()
      cleanups.push(() => peer.close())
      return peer
    }
    return { project, env, local, remote }
  }

  test("a local client previews, then commits; a remote client and a read-only peer are refused and nothing changes", async () => {
    const h = await boot()
    const command = { type: "git.commit" as const, directory: h.project, message: "Update a", paths: ["a.txt"] }
    const head = sh(h.project, h.env, "rev-parse", "HEAD")
    const previewed = await h.local.send({ ...command, preview: true })
    expect(previewed).toMatchObject({ ok: true, result: { committed: false, plan: { branch: "main", paths: ["a.txt"] } } })
    expect(sh(h.project, h.env, "rev-parse", "HEAD")).toBe(head)

    const full = await h.remote(false)
    expect(await full.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await full.send({ ...command, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    const readOnly = await h.remote(true)
    expect(await readOnly.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await readOnly.send({ ...command, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(sh(h.project, h.env, "rev-parse", "HEAD")).toBe(head)

    const refused = await h.local.send({ ...command, message: " " })
    expect(refused).toMatchObject({ ok: false, error: { message: "[GIT]: empty message" } })
    const done = await h.local.send(command)
    expect(done).toMatchObject({ ok: true, result: { committed: true, subject: "Update a" } })
    expect(sh(h.project, h.env, "log", "-1", "--format=%s")).toBe("Update a\n")
  })
})
