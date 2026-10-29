import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gitInit } from "../src/git-init"
import { GitActionRefusal } from "../src/git-remote"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function made(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-gitinit-${prefix}-`)))
  dirs.push(dir)
  return dir
}

/** A temporary home with the config the user would have, an empty folder to initialize, and the environment git runs in. */
function folder(config = "") {
  const base = made("folder")
  const home = path.join(base, "home")
  const dir = path.join(base, "project")
  mkdirSync(home)
  mkdirSync(dir)
  const global = path.join(base, "gitconfig")
  writeFileSync(global, config)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" }
  for (const name of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER|DIR|WORK_TREE|INDEX)/.test(name)) delete env[name]
  const init = (extra: Partial<Parameters<typeof gitInit>[0]> = {}) => gitInit({ directory: dir, project: dir, env, ...extra })
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  return { base, home, dir, env, init, git }
}
async function refusal(run: () => Promise<unknown>) {
  try { await run() } catch (error) { if (error instanceof GitActionRefusal) return error.message; throw error }
  return undefined
}
/** Every file under `dir` with a hash of its content: what "untouched" is compared with. */
function snapshot(dir: string, skip = ".git"): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.name === skip && current === dir) continue
      if (entry.isDirectory()) walk(full)
      else out[path.relative(dir, full)] = createHash("sha1").update(readFileSync(full)).digest("hex")
    }
  }
  walk(dir)
  return out
}

describe("git.init makes a repository here and nothing else", () => {
  test("a fresh folder gets git init -b main; the repository is empty: no commit, no ignore file, no remote", async () => {
    const f = folder()
    const done = await f.init()
    expect(done).toMatchObject({ initialized: true, root: f.dir, plan: { directory: f.dir, argv: ["git", "init", "-b", "main"], branch: "main", branchFrom: "default" } })
    expect(f.git(f.dir, "symbolic-ref", "--short", "HEAD").trim()).toBe("main")
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: f.dir, env: f.env }).exitCode).not.toBe(0)
    expect(f.git(f.dir, "remote").trim()).toBe("")
    expect(readdirSync(f.dir)).toEqual([".git"])
  })

  test("a preview runs nothing: no .git appears", async () => {
    const f = folder()
    const done = await f.init({ preview: true })
    expect(done).toMatchObject({ initialized: false, plan: { argv: ["git", "init", "-b", "main"] } })
    expect(existsSync(path.join(f.dir, ".git"))).toBe(false)
  })

  test("the user's init.defaultBranch is honoured: plain git init, and the first branch is the one they chose", async () => {
    const f = folder("[init]\n\tdefaultBranch = trunk\n")
    const done = await f.init()
    expect(done.plan).toEqual({ directory: f.dir, argv: ["git", "init"], branch: "trunk", branchFrom: "config" })
    expect(f.git(f.dir, "symbolic-ref", "--short", "HEAD").trim()).toBe("trunk")
  })

  test("a defaultBranch git would not accept falls back to main instead of failing", async () => {
    const f = folder("[init]\n\tdefaultBranch = \"bad name..x\"\n")
    const done = await f.init()
    expect(done.plan).toMatchObject({ argv: ["git", "init", "-b", "main"], branchFrom: "default" })
    expect(f.git(f.dir, "symbolic-ref", "--short", "HEAD").trim()).toBe("main")
  })

  test("the files that were there are untouched, and a .gitignore is neither created nor changed", async () => {
    const f = folder()
    mkdirSync(path.join(f.dir, "src"))
    writeFileSync(path.join(f.dir, "src", "app.ts"), "export {}\n")
    writeFileSync(path.join(f.dir, "README.md"), "# Project\n")
    writeFileSync(path.join(f.dir, ".env"), "SECRET=1\n")
    symlinkSync("README.md", path.join(f.dir, "link.md"))
    const before = snapshot(f.dir)
    await f.init()
    expect(snapshot(f.dir)).toEqual(before)
    expect(existsSync(path.join(f.dir, ".gitignore"))).toBe(false)
    expect(readdirSync(f.dir).sort()).toEqual([".env", ".git", "README.md", "link.md", "src"])
    const withIgnore = folder()
    writeFileSync(path.join(withIgnore.dir, ".gitignore"), "node_modules\n.env\n")
    writeFileSync(path.join(withIgnore.dir, ".env"), "SECRET=1\n")
    writeFileSync(path.join(withIgnore.dir, "a.txt"), "a\n")
    await withIgnore.init()
    expect(readFileSync(path.join(withIgnore.dir, ".gitignore"), "utf8")).toBe("node_modules\n.env\n")
    expect(withIgnore.git(withIgnore.dir, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean).sort()).toEqual([".gitignore", "a.txt"])
  })
})

describe("where it refuses", () => {
  test("inside a repository: the folder itself or a subfolder of it, naming the root, and nothing is created", async () => {
    const f = folder()
    f.git(f.dir, "init", "-q", "-b", "main")
    expect(await refusal(() => f.init())).toBe(`[GIT]: this folder is already a git repository: ${f.dir}`)
    const nested = path.join(f.dir, "packages", "web")
    mkdirSync(nested, { recursive: true })
    const message = await refusal(() => gitInit({ directory: nested, project: nested, env: f.env }))
    expect(message).toBe(`[GIT]: this folder is inside the git repository at ${f.dir}: the page does not start another one`)
    expect(existsSync(path.join(nested, ".git"))).toBe(false)
    // A linked worktree is a repository too.
    f.git(f.dir, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init")
    const linked = path.join(f.base, "linked")
    f.git(f.dir, "worktree", "add", "-q", linked)
    expect(await refusal(() => gitInit({ directory: linked, project: linked, env: f.env }))).toContain("already a git repository")
  })

  test("the home folder itself is refused, and so is a folder that is only a link to it; a folder inside it is fine", async () => {
    const f = folder()
    const home = path.join(f.base, "home")
    const env = { ...f.env, HOME: home }
    expect(await refusal(() => gitInit({ directory: home, project: home, env }))).toBe("[GIT]: this is your home folder: open a project folder instead")
    const link = path.join(f.base, "home-link")
    symlinkSync(home, link)
    expect(await refusal(() => gitInit({ directory: link, project: link, env }))).toContain("home folder")
    expect(existsSync(path.join(home, ".git"))).toBe(false)
    const inside = path.join(home, "work")
    mkdirSync(inside)
    expect((await gitInit({ directory: inside, project: inside, env })).initialized).toBe(true)
  })

  test("the root of the file system is refused before git is asked anything", async () => {
    const f = folder()
    expect(await refusal(() => gitInit({ directory: "/", project: "/", env: f.env }))).toBe("[GIT]: the root of the file system is not a project: open a folder of your own")
    expect(existsSync("/.git")).toBe(false)
  })

  test("a folder that is not the session's project folder, a missing folder and a file are refused", async () => {
    const f = folder()
    const other = path.join(f.base, "other")
    mkdirSync(other)
    expect(await refusal(() => gitInit({ directory: other, project: f.dir, env: f.env }))).toBe("[GIT]: only the project folder of this session can be initialized")
    expect(await refusal(() => gitInit({ directory: path.join(f.dir, "..", "project", "src"), project: f.dir, env: f.env }))).toBe("[GIT]: this folder does not exist")
    const sub = path.join(f.dir, "sub")
    mkdirSync(sub)
    expect(await refusal(() => gitInit({ directory: sub, project: f.dir, env: f.env }))).toBe("[GIT]: only the project folder of this session can be initialized")
    writeFileSync(path.join(f.dir, "file.txt"), "x")
    expect(await refusal(() => gitInit({ directory: path.join(f.dir, "file.txt"), project: path.join(f.dir, "file.txt"), env: f.env }))).toBe("[GIT]: this is not a folder")
    expect(existsSync(path.join(other, ".git"))).toBe(false)
    expect(existsSync(path.join(sub, ".git"))).toBe(false)
  })

  test("a .git that exists but git cannot read is reported and never deleted, overwritten or repaired", async () => {
    const empty = folder()
    mkdirSync(path.join(empty.dir, ".git"))
    expect(await refusal(() => empty.init())).toBe(`[GIT]: ${path.join(empty.dir, ".git")} exists but git cannot read it: repair or move it yourself, nothing was changed`)
    expect(readdirSync(path.join(empty.dir, ".git"))).toEqual([])

    const file = folder()
    writeFileSync(path.join(file.dir, ".git"), "this is not a gitfile\n")
    expect(await refusal(() => file.init())).toContain("exists but git cannot read it")
    expect(readFileSync(path.join(file.dir, ".git"), "utf8")).toBe("this is not a gitfile\n")

    const dangling = folder()
    symlinkSync(path.join(dangling.base, "nowhere"), path.join(dangling.dir, ".git"))
    expect(await refusal(() => dangling.init())).toContain("exists but git cannot read it")
    expect(Bun.spawnSync(["test", "-L", path.join(dangling.dir, ".git")]).exitCode).toBe(0)

    const above = folder()
    const child = path.join(above.dir, "child")
    mkdirSync(child)
    mkdirSync(path.join(above.dir, ".git"))
    expect(await refusal(() => gitInit({ directory: child, project: child, env: above.env }))).toContain(`${path.join(above.dir, ".git")} exists but git cannot read it`)
    expect(existsSync(path.join(child, ".git"))).toBe(false)
  })

  test("a failing git init is one line with git's words, and what was there stays", async () => {
    const f = folder()
    writeFileSync(path.join(f.dir, "keep.txt"), "keep\n")
    const before = snapshot(f.dir)
    // A folder git cannot write into fails the way a read-only disk does.
    Bun.spawnSync(["chmod", "555", f.dir])
    try {
      const message = await refusal(() => f.init())
      expect(message).toMatch(/^\[GIT\]: git init failed \(exit \d+\)\n.*(denied|read-only|Permission)/is)
    } finally { Bun.spawnSync(["chmod", "755", f.dir]) }
    expect(existsSync(path.join(f.dir, ".git"))).toBe(false)
    expect(snapshot(f.dir)).toEqual(before)
  })

  test("git missing is one line", async () => {
    const f = folder()
    expect(await refusal(() => gitInit({ directory: f.dir, project: f.dir, env: { ...f.env, PATH: path.join(f.base, "empty-bin") } }))).toBe("[GIT]: git is not installed or not on PATH")
  })
})
