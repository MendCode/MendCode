import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { liveCreateArgs, liveFile, parseCodeCommand, parseMutagenList, readLive, runCode, runGit, type CodeCommand, type CodeDeps, type MutagenRunner } from "../src/remote-code"
import type { SshRunner } from "../src/remote-setup"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-code-")); dirs.push(dir); return dir }
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
for (const [key, value] of Object.entries(IDENTITY)) process.env[key] = value

async function g(cwd: string, ...args: string[]) {
  const result = await runGit(cwd, args)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A bare "origin" and a working clone with one commit on main. */
async function fixture() {
  const root = temp()
  const origin = path.join(root, "origin.git")
  await g(root, "init", "--bare", "-b", "main", origin)
  const work = path.join(root, "work")
  await g(root, "clone", origin, work)
  await g(work, "checkout", "-b", "main")
  writeFileSync(path.join(work, "a.txt"), "one\n")
  writeFileSync(path.join(work, "gone.txt"), "bye\n")
  writeFileSync(path.join(work, ".gitignore"), "node_modules\n")
  await g(work, "add", "-A")
  await g(work, "commit", "-m", "base")
  await g(work, "push", "-u", "origin", "main")
  return { root, origin, work }
}

function deps(overrides: Partial<CodeDeps> = {}) {
  const lines: string[] = []
  const calls: string[][] = []
  const git: CodeDeps["git"] = (cwd, args, options) => { calls.push(args); return runGit(cwd, args, options) }
  const value: CodeDeps = {
    git, out: { write: (text) => { lines.push(String(text)); return true } }, now: () => Date.UTC(2026, 10, 23, 12, 0, 0), device: "laptop",
    mutagen: async () => ({ code: 127, stdout: "", stderr: "" }), ssh: () => async () => ({ code: 1, stdout: "", stderr: "no ssh in tests" }),
    ...overrides,
  }
  return { value, lines, calls, text: () => lines.join("") }
}

const parse = (args: string[], dir: string, cwd: string) => parseCodeCommand(["remote", "code", ...args], dir, cwd)!

test("handoff pushes a snapshot branch and leaves the user's branch, index and files alone", async () => {
  const { origin, work, root } = await fixture()
  writeFileSync(path.join(work, "a.txt"), "one\ntwo\n")        // unstaged edit of a tracked file
  writeFileSync(path.join(work, "b.txt"), "new\n")              // untracked, kept
  writeFileSync(path.join(work, "staged.txt"), "staged\n")      // staged, new
  await g(work, "add", "staged.txt")
  writeFileSync(path.join(work, ".env"), "TOKEN=abc\n")         // untracked credential: left out
  writeFileSync(path.join(work, "big.bin"), Buffer.alloc(6 * 1024 * 1024)) // over the size limit: left out
  mkdirSync(path.join(work, "node_modules"))
  writeFileSync(path.join(work, "node_modules", "x.js"), "x")   // ignored
  rmSync(path.join(work, "gone.txt"))                           // tracked deletion
  const before = { head: await g(work, "rev-parse", "HEAD"), status: await g(work, "status", "--porcelain"), index: await g(work, "ls-files", "--stage"), stash: await g(work, "stash", "list"), branches: await g(work, "branch", "--list") }
  const mine = deps()
  expect(await runCode(parse(["handoff", work], root, work), mine.value)).toBe(0)
  expect({ head: await g(work, "rev-parse", "HEAD"), status: await g(work, "status", "--porcelain"), index: await g(work, "ls-files", "--stage"), stash: await g(work, "stash", "list"), branches: await g(work, "branch", "--list") }).toEqual(before)
  const refs = (await g(origin, "for-each-ref", "--format=%(refname)", "refs/heads/mend/")).split("\n")
  expect(refs.length).toBe(1)
  expect(refs[0]).toMatch(/^refs\/heads\/mend\/wip-main-20261123120000-[0-9a-f]{7}$/)
  const files = (await g(origin, "ls-tree", "-r", "--name-only", refs[0]!)).split("\n")
  expect(files).toContain("b.txt")
  expect(files).toContain("staged.txt")
  expect(files).not.toContain("gone.txt")
  for (const left of [".env", "big.bin", "node_modules/x.js"]) expect(files).not.toContain(left)
  expect(await g(origin, "show", `${refs[0]}:a.txt`)).toBe("one\ntwo")
  expect(await g(origin, "rev-parse", `${refs[0]}^`)).toBe(before.head)
  expect(await g(origin, "rev-parse", "refs/heads/main")).toBe(before.head)
  expect(mine.text()).toContain("left out: .env (looks like a credential)")
  expect(mine.text()).toContain("big.bin (over 5 MiB)")
  expect(mine.calls.flat().some((arg) => /force|^\+|--mirror|--delete/.test(arg))).toBe(false)
})

test("a clean tree has nothing to hand off, and a dry run commits and pushes nothing", async () => {
  const { origin, work, root } = await fixture()
  const clean = deps()
  expect(await runCode(parse(["handoff", work], root, work), clean.value)).toBe(0)
  expect(clean.text()).toContain("nothing to hand off")
  writeFileSync(path.join(work, "b.txt"), "new\n")
  const dry = deps()
  expect(await runCode(parse(["handoff", work, "--dry-run"], root, work), dry.value)).toBe(0)
  expect(dry.text()).toContain("Dry run")
  expect(await g(origin, "for-each-ref", "refs/heads/mend/")).toBe("")
})

test("handoff refuses a repository without the git remote and reports a failed push without losing work", async () => {
  const { work, root, origin } = await fixture()
  writeFileSync(path.join(work, "b.txt"), "new\n")
  const missing = deps()
  expect(await runCode(parse(["handoff", work, "--git-remote", "nope"], root, work), missing.value)).toBe(1)
  expect(missing.text()).toContain("no git remote named nope")
  await g(work, "remote", "set-url", "origin", path.join(root, "absent.git"))
  const failing = deps()
  expect(await runCode(parse(["handoff", work], root, work), failing.value)).toBe(1)
  expect(failing.text()).toContain("failed")
  expect(failing.text()).toContain("Nothing on your branch changed")
  expect(existsSync(path.join(work, "b.txt"))).toBe(true)
  expect(await g(origin, "for-each-ref", "refs/heads/mend/")).toBe("")
})

test("receive checks the newest handoff out in its own worktree and never touches the receiver's checkout", async () => {
  const { origin, work, root } = await fixture()
  writeFileSync(path.join(work, "a.txt"), "one\ntwo\n")
  writeFileSync(path.join(work, "b.txt"), "new\n")
  expect(await runCode(parse(["handoff", work], root, work), deps().value)).toBe(0)
  const other = path.join(root, "other")
  await g(root, "clone", origin, other)
  writeFileSync(path.join(other, "local.txt"), "mine\n")
  const before = { head: await g(other, "rev-parse", "HEAD"), status: await g(other, "status", "--porcelain") }
  const data = path.join(root, "data")
  const received = deps()
  expect(await runCode(parse(["receive", other, "--dir", data], root, other), received.value)).toBe(0)
  const worktree = /in (.+?)(?: \(project folder|\.$)/m.exec(received.text())?.[1]?.replace(/\.$/, "")
  expect(worktree?.startsWith(path.join(data, "remote-code", "worktrees"))).toBe(true)
  expect(readFileSync(path.join(worktree!, "a.txt"), "utf8")).toBe("one\ntwo\n")
  expect(readFileSync(path.join(worktree!, "b.txt"), "utf8")).toBe("new\n")
  expect({ head: await g(other, "rev-parse", "HEAD"), status: await g(other, "status", "--porcelain") }).toEqual(before)
  expect(received.text()).toContain("contains the base commit")
  const again = deps()
  expect(await runCode(parse(["receive", other, "--dir", data], root, other), again.value)).toBe(0)
  expect(again.text()).toContain("Already received")
  expect(again.calls.flat().some((arg) => /force|^-B$|--delete|reset/.test(arg))).toBe(false)
})

test("receive says what to do when the host has no handoff, and refuses a name that is not a handoff branch", async () => {
  const { origin, root } = await fixture()
  const other = path.join(root, "other")
  await g(root, "clone", origin, other)
  const none = deps()
  expect(await runCode(parse(["receive", other, "--dir", path.join(root, "data")], root, other), none.value)).toBe(1)
  expect(none.text()).toContain("no mend/wip-* branch")
  expect(() => parse(["receive", other, "--branch", "main"], root, other)).toThrow("mend/wip-")
})

test("clone is skipped when a clone with the same git remote exists and creates one otherwise", async () => {
  const { origin, work, root } = await fixture()
  const url = "https://example.com/org/repo.git"
  await g(work, "remote", "set-url", "origin", url)
  const here = deps()
  expect(await runCode(parse(["clone", url, "--root", root, "--search-root", root], root, root), here.value)).toBe(0)
  expect(here.text()).toContain("Already here")
  const target = path.join(root, "fresh")
  // Only the clone itself is redirected to the local bare repository.
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = url
  const fresh = deps()
  try { expect(await runCode(parse(["clone", url, "--root", target, "--search-root", target], root, root), fresh.value)).toBe(0) }
  finally { delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0 }
  expect(fresh.text()).toContain("Cloned")
  expect(existsSync(path.join(target, "repo", "a.txt"))).toBe(true)
  expect(() => parse(["clone", "--upload-pack=x"], root, root)).toThrow()
})

// ---- live sync ----

/** A pretend host with one clone, and a Mutagen that records its calls. */
function liveFixture(options: { hostHead?: string; hostBranch?: string; hostUrl?: string; hasMutagen?: boolean } = {}) {
  const calls: string[][] = []
  const sessions = new Map<string, { paused: boolean }>()
  const state = { hostBranch: options.hostBranch, hostHead: options.hostHead, hostUrl: options.hostUrl }
  const mutagen: MutagenRunner = async (args) => {
    if (options.hasMutagen === false) return { code: 127, stdout: "", stderr: "not found" }
    calls.push(args)
    const [group, verb] = args
    if (args[0] === "version") return { code: 0, stdout: "0.18.1\n", stderr: "" }
    if (group === "sync" && verb === "create") { sessions.set(args[args.indexOf("--name") + 1]!, { paused: false }); return { code: 0, stdout: "Created session\n", stderr: "" } }
    if (group === "sync" && verb === "list") {
      const filter = args[2]
      const names = [...sessions.keys()].filter((name) => !filter || name === filter)
      if (filter && !names.length) return { code: 1, stdout: "", stderr: "unable to locate session" }
      return { code: 0, stdout: names.map((name) => `--------------------------------------------------------------------------------\nName: ${name}\nIdentifier: sync_x\nStatus: ${sessions.get(name)!.paused ? "Paused" : "Watching for changes"}\n`).join(""), stderr: "" }
    }
    if (group === "sync" && verb === "pause") { sessions.get(args[2]!)!.paused = true; return { code: 0, stdout: "", stderr: "" } }
    if (group === "sync" && verb === "resume") { sessions.get(args[2]!)!.paused = false; return { code: 0, stdout: "", stderr: "" } }
    if (group === "sync" && verb === "terminate") { const had = sessions.delete(args[2]!); return had ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "unable to locate" } }
    return { code: 1, stdout: "", stderr: "unexpected" }
  }
  const sshCalls: string[] = []
  const ssh = (_target: string): SshRunner => async ({ script }) => {
    sshCalls.push(script)
    return { code: 0, stdout: `head=${state.hostHead}\nbranch=${state.hostBranch}\nurl=${state.hostUrl}\n`, stderr: "" }
  }
  return { calls, sessions, mutagen, ssh, state, sshCalls }
}

test("live enable detects Mutagen, refuses a branch or commit mismatch and then creates a guarded two-way-safe session", async () => {
  const { origin, work, root } = await fixture()
  await g(work, "remote", "set-url", "origin", "git@example.com:Org/Proj.git")
  const head = await g(work, "rev-parse", "HEAD")
  const data = path.join(root, "data")
  const command = parse(["live", "enable", work, "--ssh", "me@host", "--remote-path", "/home/me/code/proj", "--dir", data], root, work)

  const absent = liveFixture({ hasMutagen: false, hostHead: head, hostBranch: "main", hostUrl: "https://example.com/org/proj" })
  const noMutagen = deps({ mutagen: absent.mutagen, ssh: absent.ssh })
  expect(await runCode(command, noMutagen.value)).toBe(1)
  expect(noMutagen.text()).toContain("Mutagen is not installed")
  expect(absent.sshCalls.length).toBe(0)

  const branch = liveFixture({ hostHead: head, hostBranch: "other", hostUrl: "https://example.com/org/proj" })
  const wrongBranch = deps({ mutagen: branch.mutagen, ssh: branch.ssh })
  expect(await runCode(command, wrongBranch.value)).toBe(1)
  expect(wrongBranch.text()).toContain("different branches")

  const commit = liveFixture({ hostHead: "0".repeat(40), hostBranch: "main", hostUrl: "https://example.com/org/proj" })
  const wrongCommit = deps({ mutagen: commit.mutagen, ssh: commit.ssh })
  expect(await runCode(command, wrongCommit.value)).toBe(1)
  expect(wrongCommit.text()).toContain("different commits")

  const other = liveFixture({ hostHead: head, hostBranch: "main", hostUrl: "https://example.com/org/else" })
  const wrongRepo = deps({ mutagen: other.mutagen, ssh: other.ssh })
  expect(await runCode(command, wrongRepo.value)).toBe(1)
  expect(wrongRepo.text()).toContain("not example.com/org/proj")
  for (const refused of [absent, branch, commit, other]) expect(refused.calls.some((call) => call[1] === "create")).toBe(false)
  expect(Object.keys(readLive(data).sessions)).toEqual([])

  const good = liveFixture({ hostHead: head, hostBranch: "main", hostUrl: "https://example.com/org/proj" })
  const enabled = deps({ mutagen: good.mutagen, ssh: good.ssh })
  expect(await runCode(command, enabled.value)).toBe(0)
  const create = good.calls.find((call) => call[1] === "create")!
  expect(create).toContain("two-way-safe")
  expect(create).toContain("--ignore-vcs")
  for (const pattern of ["node_modules", "dist", "build", ".next", "target", ".venv", "*.log", ".env"]) expect(create[create.indexOf(pattern) - 1]).toBe("--ignore")
  expect(create.at(-2)).toBe(work)
  expect(create.at(-1)).toBe("me@host:/home/me/code/proj")
  const ledger = readLive(data)
  expect(Object.values(ledger.sessions)[0]).toMatchObject({ local: work, ssh: "me@host", remote: "/home/me/code/proj" })
  expect((await Bun.file(liveFile(data)).stat()).mode & 0o777).toBe(0o600)
  expect(await runCode(command, deps({ mutagen: good.mutagen, ssh: good.ssh }).value)).toBe(0)
  expect(good.calls.filter((call) => call[1] === "create").length).toBe(1)
})

test("live enable --dry-run creates nothing, and --include-env stops ignoring .env", async () => {
  const { work, root } = await fixture()
  const head = await g(work, "rev-parse", "HEAD")
  const fixtureLive = liveFixture({ hostHead: head, hostBranch: "main", hostUrl: "" })
  const mine = deps({ mutagen: fixtureLive.mutagen, ssh: fixtureLive.ssh })
  const data = path.join(root, "data")
  expect(await runCode(parse(["live", "enable", work, "--ssh", "h", "--remote-path", "/srv/p", "--dir", data, "--dry-run"], root, work), mine.value)).toBe(0)
  expect(fixtureLive.calls.some((call) => call[1] === "create")).toBe(false)
  expect(existsSync(liveFile(data))).toBe(false)
  expect(liveCreateArgs({ name: "mc-x", local: "/a", ssh: "h", remote: "/b", ignores: [], includeEnv: true })).not.toContain(".env")
})

test("live status pauses on a branch change, resume re-checks, list shows state, disable terminates only what this tool made", async () => {
  const { work, root } = await fixture()
  const head = await g(work, "rev-parse", "HEAD")
  const live = liveFixture({ hostHead: head, hostBranch: "main", hostUrl: "" })
  const data = path.join(root, "data")
  const d = () => deps({ mutagen: live.mutagen, ssh: live.ssh })
  expect(await runCode(parse(["live", "enable", work, "--ssh", "h", "--remote-path", "/srv/p", "--dir", data], root, work), d().value)).toBe(0)
  const name = Object.keys(readLive(data).sessions)[0]!

  const ok = d()
  expect(await runCode(parse(["live", "status", work, "--dir", data], root, work), ok.value)).toBe(0)
  expect(ok.text()).toContain("Watching for changes")
  expect(live.sessions.get(name)!.paused).toBe(false)

  live.state.hostBranch = "feature"
  const mismatch = d()
  expect(await runCode(parse(["live", "status", work, "--dir", data], root, work), mismatch.value)).toBe(0)
  expect(mismatch.text()).toContain("PAUSED")
  expect(live.sessions.get(name)!.paused).toBe(true)
  const stuck = d()
  expect(await runCode(parse(["live", "resume", work, "--dir", data], root, work), stuck.value)).toBe(1)
  expect(live.sessions.get(name)!.paused).toBe(true)

  live.state.hostBranch = "main"
  expect(await runCode(parse(["live", "resume", work, "--dir", data], root, work), d().value)).toBe(0)
  expect(live.sessions.get(name)!.paused).toBe(false)

  const listed = d()
  expect(await runCode(parse(["live", "list", "--dir", data], root, work), listed.value)).toBe(0)
  expect(listed.text()).toContain(name)
  expect(listed.text()).toContain("Watching for changes")

  live.sessions.set("someone-elses", { paused: false })
  const unknown = d()
  expect(await runCode(parse(["live", "disable", work, "--name", "someone-elses", "--dir", data], root, work), unknown.value)).toBe(1)
  expect(live.sessions.has("someone-elses")).toBe(true)
  expect(await runCode(parse(["live", "disable", work, "--dir", data], root, work), d().value)).toBe(0)
  expect(live.sessions.has(name)).toBe(false)
  expect(live.sessions.has("someone-elses")).toBe(true)
  expect(Object.keys(readLive(data).sessions)).toEqual([])
})

test("live paths are found on the host by git remote when none is given", async () => {
  const { work, root } = await fixture()
  await g(work, "remote", "set-url", "origin", "git@example.com:Org/Proj.git")
  const head = await g(work, "rev-parse", "HEAD")
  const live = liveFixture({ hostHead: head, hostBranch: "main", hostUrl: "https://example.com/org/proj" })
  const ssh = (_t: string): SshRunner => async ({ script }) => script.includes("find ") ? { code: 0, stdout: "/home/me/code/proj\thttps://example.com/org/proj\n/home/me/code/else\thttps://example.com/org/else\n", stderr: "" } : live.ssh("")({ script })
  expect(await runCode(parse(["live", "enable", work, "--ssh", "h", "--dir", path.join(root, "d")], root, work), deps({ mutagen: live.mutagen, ssh }).value)).toBe(0)
  expect(live.calls.find((call) => call[1] === "create")!.at(-1)).toBe("h:/home/me/code/proj")
})

test("parsing rejects what could reach a shell or another command and keeps the commands separate", () => {
  const cwd = "/tmp/p"
  expect(() => parse(["live", "enable", ".", "--ssh", "-oProxyCommand=x"], "/d", cwd)).toThrow("--ssh")
  expect(() => parse(["live", "enable", ".", "--ssh", "h", "--remote-path", "rel/path"], "/d", cwd)).toThrow("absolute")
  expect(() => parse(["live", "enable", ".", "--ssh", "h", "--remote-path", "/a/../b"], "/d", cwd)).toThrow("absolute")
  expect(() => parse(["live", "enable", ".", "--ssh", "h", "--ignore", "a;b"], "/d", cwd)).toThrow("plain pattern")
  expect(() => parse(["handoff", ".", "--ssh", "h"], "/d", cwd)).toThrow("does not apply")
  expect(() => parse(["handoff", ".", "--git-remote", "--upload-pack=x"], "/d", cwd)).toThrow()
  expect(() => parse(["live", "status", ".", "--ssh", "h"], "/d", cwd)).toThrow("only applies")
  expect(parseCodeCommand(["remote", "add", "code", "h:1"], "/d")).toBeUndefined()
  expect(parseCodeCommand(["--remote", "code"], "/d")).toBeUndefined()
  expect((parse(["handoff"], "/d", cwd) as Extract<CodeCommand, { action: "handoff" }>).project).toBe(cwd)
})

test("parseMutagenList reads names, status, conflicts and the last error", () => {
  const text = "-----\nName: a\nStatus: Watching for changes\n-----\nName: b\nStatus: Halted on error\nLast error: boom\nConflicts:\n\t(alpha) x\n"
  const parsed = parseMutagenList(text)
  expect(parsed.get("a")).toEqual({ status: "Watching for changes", conflicts: false })
  expect(parsed.get("b")).toEqual({ status: "Halted on error", conflicts: true, error: "boom" })
})
