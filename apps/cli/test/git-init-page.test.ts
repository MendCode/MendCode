import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { cleanTemps } from "./session-ui-harness"
import { folder, frame, gitApp, keys, press, prose, release, repository, settle, type GitApp } from "./git-page-helpers"

afterEach(cleanTemps)

const open = async (app: GitApp, command = "/git") => { await app.h.type(`${command}\r`); await settle(); await settle(); app.h.app.render() }
const sentOf = (app: GitApp, type: string) => app.h.sent.filter((command) => command.type === type)
const hasDotGit = (app: GitApp) => existsSync(path.join(app.repo.dir, ".git"))
const rowsOf = (app: GitApp) => app.h.text()

/** A plain click on the Initialize action: the last row that holds its label is the action (the title above it is not clickable). */
async function clickAction(app: GitApp) {
  const rows = rowsOf(app)
  const row = rows.findLastIndex((text) => text.includes(" Initialize repository "))
  const col = rows[row]!.indexOf(" Initialize repository ") + 2
  await app.h.app.onKey(press(col, row))
  await app.h.app.onKey(release(col, row))
  await settle()
  app.h.app.render()
}

describe("a folder that is not a repository", () => {
  test("/git shows one state in place of the tabs' content: what it is and the one action; nothing is created and nothing is committed", async () => {
    const repo = folder()
    const app = await gitApp({ repo })
    await open(app)
    expect(app.h.app.page).toBe("git-init")
    const text = frame(app.h)
    expect(text).toContain("Initialize repository")
    expect(text).toContain("Not a Git repository")
    expect(text).toContain("Initializing is local: nothing leaves this machine and your files are not touched.")
    expect(text).toContain("i initialize · r refresh · esc back")
    const [tabs] = rowsOf(app)
    expect(tabs).toContain("not a git repository")
    expect(tabs).not.toContain("< > tabs")
    expect(hasDotGit(app)).toBe(false)
    // Only a preview was asked of the daemon.
    expect(sentOf(app, "git.init").map((command) => (command as { preview?: boolean }).preview)).toEqual([true])
  })

  test("every tab of the page is that state, and so is the PR tab: nothing else is asked of the daemon", async () => {
    for (const command of ["/git commit", "/git pr", "/git worktrees", "/git changes"]) {
      const app = await gitApp({ repo: folder(), settings: { experimental: { git_actions: true } } })
      await open(app, command)
      expect(app.h.app.page).toBe("git-init")
      expect(app.h.sent.map((sent) => sent.type).filter((type) => type.startsWith("git."))).toEqual(["git.branch", "git.status", "git.init"])
    }
  })

  test("the action is drawn like the active tab (the element background), and tabs switch nothing: a click on one stays here", async () => {
    const app = await gitApp({ repo: folder() })
    await open(app)
    const row = app.h.frames.at(-1)!.find((line) => line.some((span) => span.text === " Initialize repository "))!
    expect(row.find((span) => span.text === " Initialize repository ")).toMatchObject({ fg: "text", bg: "element", bold: true })
    const tabs = app.h.frames.at(-1)![0]!
    expect(tabs.some((span) => span.bg === "element")).toBe(false)
    await app.h.app.onKey(press(14, 0))
    await app.h.app.onKey(release(14, 0))
    await settle()
    expect(app.h.app.page).toBe("git-init")
    await keys(app.h, ">", "<")
    expect(app.h.app.page).toBe("git-init")
  })

  test("i shows the card: the exact command, the directory, the first branch and that it is local; esc takes it back and nothing ran", async () => {
    const app = await gitApp({ repo: folder() })
    await open(app)
    await keys(app.h, "i")
    const text = frame(app.h)
    expect(text).toContain("Confirm · local only, nothing leaves this machine")
    expect(text).toContain("git init -b main")
    expect(text).toContain(`in ${readdirRoot(app)}`)
    expect(text).toContain("first branch main")
    expect(text).toContain("not done: no commit, no .gitignore, no remote, no network")
    expect(text).toContain("enter initialize · esc cancel")
    expect(hasDotGit(app)).toBe(false)
    await keys(app.h, "\x1b")
    expect(frame(app.h)).toContain("i initialize · r refresh · esc back")
    expect(hasDotGit(app)).toBe(false)
    expect(sentOf(app, "git.init").filter((command) => !(command as { preview?: boolean }).preview)).toHaveLength(0)
  })

  test("a click on the action is the key", async () => {
    const app = await gitApp({ repo: folder() })
    await open(app)
    await clickAction(app)
    expect(frame(app.h)).toContain("Confirm · local only")
    // A click elsewhere on the page does nothing.
    await keys(app.h, "\x1b")
    await app.h.app.onKey(press(3, 12))
    await app.h.app.onKey(release(3, 12))
    await settle()
    expect(frame(app.h)).not.toContain("Confirm · local only")
  })

  test("enter makes the repository and lands on the Commit tab with the files listed; .gitignore is honoured and left alone, and nothing is committed", async () => {
    const repo = folder()
    repo.git("config", "--global", "user.name", "Tester")
    repo.git("config", "--global", "user.email", "tester@example.test")
    const app = await gitApp({ repo })
    await open(app)
    await keys(app.h, "i", "\r")
    await settle()
    app.h.app.render()
    expect(app.h.app.page).toBe("git-commit")
    const text = frame(app.h)
    for (const file of [".gitignore", "docs/guide.md", "README.md", "src/app.rs"]) expect(text).toContain(file)
    expect(text).not.toContain(".env")
    expect(text).toContain("initialized main · nothing committed · tick the files to commit")
    expect(rowsOf(app)[0]).toContain("main")
    expect(repo.git("symbolic-ref", "--short", "HEAD").trim()).toBe("main")
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.dir, env: repo.env }).exitCode).not.toBe(0)
    expect(readFileSync(path.join(repo.dir, ".gitignore"), "utf8")).toBe("target/\n.env\n")
    expect(readdirSync(repo.dir).sort()).toEqual([".env", ".git", ".gitignore", "README.md", "docs", "src"])
    // The real command ran once, after the preview.
    expect(sentOf(app, "git.init").map((command) => Boolean((command as { preview?: boolean }).preview))).toEqual([true, false])
    // The user commits what they choose.
    await keys(app.h, " ", "\t")
    await app.h.type("First commit")
    await keys(app.h, "\t", "\r", "\r")
    await settle()
    expect(repo.git("log", "--format=%s").trim()).toBe("First commit")
  })

  test("the user's init.defaultBranch is the first branch and the card says whose it is", async () => {
    const repo = folder({ config: "[init]\n\tdefaultBranch = trunk\n" })
    const app = await gitApp({ repo })
    await open(app)
    await keys(app.h, "i")
    const text = frame(app.h)
    expect(text).toContain("git init")
    expect(text).not.toContain("git init -b")
    expect(text).toContain("first branch trunk · your init.defaultBranch")
    await keys(app.h, "\r")
    await settle()
    expect(repo.git("symbolic-ref", "--short", "HEAD").trim()).toBe("trunk")
  })

  test("a folder the daemon would not initialize shows its reason instead of the action: the home folder, a .git it cannot read, a remote client", async () => {
    const home = folder()
    home.env = { ...home.env, HOME: home.dir }
    const a = await gitApp({ repo: home })
    await open(a)
    expect(frame(a.h)).toContain("this is your home folder: open a project folder instead")
    expect(a.h.frames.at(-1)!.some((line) => line.some((span) => span.bg === "element"))).toBe(false)
    await keys(a.h, "i", "\r")
    expect(frame(a.h)).not.toContain("Confirm")
    expect(hasDotGit(a)).toBe(false)

    const broken = folder()
    mkdirSync(path.join(broken.dir, ".git"))
    const b = await gitApp({ repo: broken })
    await open(b)
    expect(prose(b.h)).toContain("/.git exists but git cannot read it: repair or move it yourself, nothing was changed")
    expect(readdirSync(path.join(broken.dir, ".git"))).toEqual([])

    const c = await gitApp({ repo: folder(), intercept: (command) => command.type === "git.init" ? { ok: false, error: { code: "forbidden", message: "[GIT]: initializing a repository runs git on this machine and is local only" } } : undefined })
    await open(c)
    expect(frame(c.h)).toContain("initializing a repository runs git on this machine and is local only")
  })

  test("a failing git init keeps the card with the command and what git printed, in the error role; nothing is lost", async () => {
    const app = await gitApp({ repo: folder(), intercept: (command) => command.type === "git.init" && !command.preview ? { ok: false, error: { code: "invalid_command", message: "[GIT]: git init failed (exit 1)\nfatal: cannot mkdir .git/hooks: Permission denied" } } : undefined })
    await open(app)
    await keys(app.h, "i", "\r")
    await settle()
    app.h.app.render()
    const text = frame(app.h)
    expect(app.h.app.page).toBe("git-init")
    expect(text).toContain("git init -b main")
    expect(text).toContain("fatal: cannot mkdir .git/hooks: Permission denied")
    const notice = app.h.frames.at(-1)!.find((line) => line.some((span) => span.text.startsWith("git init failed")))!
    expect(notice.find((span) => span.text.startsWith("git init failed"))).toMatchObject({ fg: "error" })
    expect(hasDotGit(app)).toBe(false)
  })

  test("r looks again: the folder became a repository, so the page leaves the state", async () => {
    const repo = folder()
    const app = await gitApp({ repo })
    await open(app)
    repo.git("init", "-q", "-b", "main")
    await keys(app.h, "r")
    await settle()
    expect(app.h.app.page).toBe("changes")
  })

  test("a repository, a subfolder of one and the tiers are as they were: no init state", async () => {
    const app = await gitApp()
    await open(app)
    expect(app.h.app.page).toBe("changes")
    expect(sentOf(app, "git.init")).toHaveLength(0)
    const none = await gitApp({ repo: folder(), tier: "minimalist" })
    await open(none)
    expect(none.h.app.page).toBe("chat")
    expect(sentOf(none, "git.init")).toHaveLength(0)
    const sub = repository()
    sub.dirty()
    const nested = await gitApp({ repo: sub })
    await open(nested, "/git commit")
    expect(nested.h.app.page).toBe("git-commit")
  })

  test("it fits 80 and 60 columns, and the keys are words of the label system", async () => {
    for (const [width, height] of [[80, 26], [60, 24]] as const) {
      const app = await gitApp({ repo: folder(), width, height })
      await open(app)
      for (const row of rowsOf(app)) expect(row.length).toBeLessThanOrEqual(width)
      await keys(app.h, "i")
      for (const row of rowsOf(app)) expect(row.length).toBeLessThanOrEqual(width)
      expect(frame(app.h)).toContain("git init -b main")
    }
  })
})

/** The directory the card names: the real path of the project folder. */
function readdirRoot(app: GitApp) {
  return Bun.spawnSync(["realpath", app.repo.dir]).stdout.toString().trim()
}
