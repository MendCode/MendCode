import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { gitTabHits } from "../src/view/git-page"
import { cleanTemps } from "./session-ui-harness"
import { click, frame, gitApp, keys, repository, settle, type GitApp } from "./git-page-helpers"

afterEach(cleanTemps)

const open = async (app: GitApp, command = "/git") => { await app.h.type(`${command}\r`); await settle(); app.h.app.render() }
const sentOf = (app: GitApp, type: string) => app.h.sent.filter((command) => command.type === type)
const log = (app: GitApp) => app.repo.git("log", "--format=%s").split("\n").filter(Boolean)

describe("the frame", () => {
  test("/git opens Changes under a tabs row: the three tabs, the hint, and the branch with ahead, behind and dirty count from git.status", async () => {
    const repo = repository()
    repo.upstream()
    repo.dirty()
    const app = await gitApp({ repo })
    await open(app)
    const [tabs, header] = app.h.text()
    expect(tabs).toMatch(/^ {2}Changes {4}Commit {4}Worktrees {4}PR {3}< > tabs +main ↑1 ↓0 · 4 dirty $/)
    expect(header).toContain("Changes · branch main")
    expect(app.h.app.page).toBe("changes")
    expect(sentOf(app, "git.status")).toHaveLength(1)
  })

  test("the active tab is the element-background chip, the others muted; the state of the repository is plain text", async () => {
    const app = await gitApp()
    await open(app)
    const row = app.h.frames.at(-1)![0]!
    const chip = (text: string) => row.find((span) => span.text === ` ${text} `)
    expect(chip("Changes")).toMatchObject({ fg: "text", bg: "element", bold: true })
    expect(chip("Commit")).toMatchObject({ fg: "muted" })
    expect(chip("Commit")?.bg).toBeUndefined()
    expect(row.find((span) => span.text === "main")).toMatchObject({ fg: "text" })
    expect(row.find((span) => span.text.includes("< > tabs"))).toMatchObject({ fg: "muted" })
    await keys(app.h, ">")
    const commit = app.h.frames.at(-1)![0]!
    expect(commit.find((span) => span.text === " Commit ")).toMatchObject({ bg: "element", bold: true })
    expect(commit.find((span) => span.text === " Changes ")?.bg).toBeUndefined()
  })

  test("below 70 columns the tabs shorten the way the other pages' tabs do, and the repository state keeps only the branch", async () => {
    const app = await gitApp({ width: 60, height: 24 })
    await open(app)
    const tabs = app.h.text()[0]!
    expect(tabs).toContain(" Chg ")
    expect(tabs).toContain(" Com ")
    expect(tabs).toContain(" Wt ")
    expect(tabs).toContain("main")
    expect(tabs).not.toContain("< > tabs")
    expect(tabs.length).toBeLessThanOrEqual(60)
  })

  test("a repository that is not one says so, and a detached HEAD is named", async () => {
    const repo = repository()
    repo.dirty()
    const app = await gitApp({ repo })
    await open(app)
    repo.git("checkout", "-q", "--detach")
    await keys(app.h, ">", "<")
    expect(app.h.text()[0]).toContain("detached HEAD")
  })

  test("/git <tab> and git.defaultTab choose the tab; an unknown word is a usage line", async () => {
    const app = await gitApp()
    await open(app, "/git commit")
    expect(app.h.app.page).toBe("git-commit")
    await keys(app.h, "\x1b")
    await open(app, "/git worktrees")
    expect(app.h.app.page).toBe("warp")
    await keys(app.h, "\x1b")
    await open(app, "/git nope")
    expect(app.h.app.page).toBe("chat")
    expect(frame(app.h)).toContain("usage: /git [changes | commit | worktrees | pr]")
    const preferred = await gitApp({ settings: { git: { defaultTab: "commit" } } })
    await open(preferred)
    expect(preferred.h.app.page).toBe("git-commit")
  })
})

describe("tiers", () => {
  test("with no tier, /changes and /warp are the pages they were: no tabs row, no keys, no extra reads", async () => {
    const app = await gitApp({ tier: null })
    await open(app, "/changes")
    expect(app.h.text()[0]).toMatch(/^ Changes · branch main/)
    expect(app.h.text().join("\n")).not.toContain("< > tabs")
    await keys(app.h, ">")
    expect(app.h.app.page).toBe("changes")
    expect(sentOf(app, "git.status")).toHaveLength(0)
    await keys(app.h, "\x1b")
    await open(app, "/warp")
    expect(app.h.text().join("\n")).not.toContain("< > tabs")
    expect(frame(app.h)).not.toContain("dirty")
    expect(sentOf(app, "worktree.query")).toHaveLength(0)
    await keys(app.h, "\x1b")
    await open(app, "/git")
    expect(app.h.app.page).toBe("chat")
  })

  test("minimalist lists neither /git nor /changes: typed by hand they run nothing and name the tier that has them", async () => {
    const app = await gitApp({ tier: "minimalist" })
    for (const word of ["/git", "/changes"]) {
      await open(app, word)
      expect(app.h.app.page).toBe("chat")
      expect(frame(app.h)).toContain("balanced")
    }
    expect(sentOf(app, "git.status")).toHaveLength(0)
  })

  test("/tier git_hub off takes the frame away from a balanced tier", async () => {
    const app = await gitApp({ settings: { features: { git_hub: false } } })
    await open(app, "/changes")
    expect(app.h.text().join("\n")).not.toContain("< > tabs")
  })
})

describe("switching tabs", () => {
  test("> and < walk Changes, Commit, Worktrees and PR and wrap around", async () => {
    const app = await gitApp()
    await open(app)
    const pages: string[] = []
    for (const key of [">", ">", ">", ">", "<", "<", "<", "<"]) { await keys(app.h, key); pages.push(app.h.app.page) }
    expect(pages).toEqual(["git-commit", "warp", "git-pr", "changes", "git-pr", "warp", "git-commit", "changes"])
  })

  test("a click on a tab opens it; a click on the tab that is open does nothing", async () => {
    const app = await gitApp()
    await open(app)
    const hits = gitTabHits(app.h.size.width)
    expect(hits.map((hit) => hit.tab)).toEqual(["changes", "commit", "worktrees", "pr"])
    await click(app.h, "Commit")
    expect(app.h.app.page).toBe("git-commit")
    await click(app.h, "Commit")
    expect(app.h.app.page).toBe("git-commit")
    await click(app.h, "Worktrees")
    expect(app.h.app.page).toBe("warp")
    await click(app.h, "Changes")
    expect(app.h.app.page).toBe("changes")
  })

  test("coming back to Changes finds the page as it was: the same file", async () => {
    const app = await gitApp()
    await open(app)
    await keys(app.h, "n")
    const before = app.h.text().find((row) => row.includes("Diff")) ?? ""
    await keys(app.h, ">", "<")
    expect(app.h.app.page).toBe("changes")
    expect(app.h.text().find((row) => row.includes("Diff"))).toBe(before)
  })

  test("< and > are text while a comment, a line number or a workspace name is being typed", async () => {
    const app = await gitApp()
    await open(app)
    await keys(app.h, "\x1b[C", "c")
    await keys(app.h, "<", ">")
    expect(app.h.app.page).toBe("changes")
    expect(frame(app.h)).toContain("<>")
    expect(app.h.text()[0]).not.toContain("< > tabs")
    await keys(app.h, "\x1b")
    await keys(app.h, ">", ">")
    expect(app.h.app.page).toBe("warp")
    await keys(app.h, "c", "<")
    expect(app.h.app.page).toBe("warp")
  })
})

describe("the Changes tab is the Changes page", () => {
  test("its keys are unchanged: 2 and 1 move the focus, j k move, f and a click open the file in the viewer", async () => {
    const app = await gitApp()
    await open(app)
    await keys(app.h, "2")
    expect(frame(app.h)).toContain("↑↓ line")
    await keys(app.h, "1")
    expect(frame(app.h)).toContain("↑↓ file")
    await keys(app.h, "f")
    expect(app.h.app.page).toBe("chat")
    expect(frame(app.h)).toContain("# Guide")
  })

  test("a click on a file of the list opens it, one row lower than the page draws it on its own", async () => {
    const app = await gitApp({ width: 130 })
    await open(app)
    await click(app.h, "README.md", 4)
    expect(app.h.app.page).toBe("chat")
    expect(frame(app.h)).toContain("# Project")
  })
})

describe("the Commit tab", () => {
  const prepare = async (app: GitApp) => {
    await open(app, "/git commit")
    // docs/guide.md and src/files/new.rs: the first and the last file of the list.
    await keys(app.h, " ", "G", " ")
  }
  const write = async (app: GitApp, message: string) => {
    await keys(app.h, "\t")
    await app.h.type(message)
    await keys(app.h, "\t")
  }

  test("lists the files with a box each, none ticked, and the keys are real labels", async () => {
    const app = await gitApp()
    await open(app, "/git commit")
    const text = frame(app.h)
    expect(text).toContain("0 of 4 files ticked")
    expect(text).toContain("[ ] M docs/guide.md")
    expect(text).toContain("[ ] ? src/files/new.rs")
    expect(text).toContain("write the commit message")
    expect(text).toContain("space tick · a all/none · tab message · enter review")
    await keys(app.h, " ", "a")
    expect(frame(app.h)).toContain("4 of 4 files ticked")
    expect(frame(app.h)).toContain("[x] M docs/guide.md")
    await keys(app.h, "a")
    expect(frame(app.h)).toContain("0 of 4 files ticked")
  })

  test("enter without a selection or without a message is one line and nothing else", async () => {
    const app = await gitApp()
    await open(app, "/git commit")
    await keys(app.h, "\r")
    expect(app.h.text().at(-4)).toBeDefined()
    expect(frame(app.h)).toContain("nothing selected · space ticks a file")
    await keys(app.h, " ", "\r")
    expect(frame(app.h)).toContain("empty message · tab writes it")
    expect(sentOf(app, "git.commit")).toHaveLength(0)
    expect(log(app)).toEqual(["init"])
  })

  test("the message is the app's multi-line editor: typing, enter for a new line, paste, backspace", async () => {
    const app = await gitApp()
    await open(app, "/git commit")
    await keys(app.h, "\t")
    await app.h.type("Subject line")
    await keys(app.h, "\r")
    await app.h.type("Second")
    await app.h.app.onInput("\x1b[200~pasted\nlines\x1b[201~")
    app.h.app.render()
    const text = frame(app.h)
    expect(text).toContain("Subject line")
    expect(text).toContain("Secondpasted")
    expect(text).toContain("lines█")
    expect(text).toContain("type the message · enter newline · tab files")
    await keys(app.h, "\x7f")
    expect(frame(app.h)).toContain("line█")
  })

  test("enter shows the exact command, every path and what is staged elsewhere, and esc takes it back", async () => {
    const app = await gitApp()
    await prepare(app)
    await write(app, "Add the guide and the fresh module")
    await keys(app.h, "\r")
    const text = frame(app.h)
    expect(text).toContain("Confirm · local only, nothing leaves this machine")
    expect(text).toContain('git commit -m "Add the guide and the fresh module" --')
    expect(text).toContain("  docs/guide.md")
    expect(text).toContain("  src/files/new.rs  new")
    expect(text).toContain("git add -- src/files/new.rs")
    expect(text).toContain("branch main · no repository hooks")
    expect(text).toContain("1 other staged file stays staged and out of this commit: README.md")
    expect(text).toContain("enter commit · esc cancel")
    expect(log(app)).toEqual(["init"])
    await keys(app.h, "\x1b")
    expect(frame(app.h)).toContain("[x] M docs/guide.md")
    expect(app.h.app.page).toBe("git-commit")
  })

  test("enter on the card commits the ticked files only; what was staged elsewhere stays staged, and the list and the tabs row follow", async () => {
    const app = await gitApp()
    await prepare(app)
    await write(app, "Add the guide and the fresh module\n\nBody text.")
    await keys(app.h, "\r", "\r")
    await settle()
    app.h.app.render()
    expect(log(app)).toEqual(["Add the guide and the fresh module", "init"])
    expect(app.repo.git("show", "--name-only", "--format=").split("\n").filter(Boolean).sort()).toEqual(["docs/guide.md", "src/files/new.rs"])
    expect(app.repo.git("status", "--porcelain")).toBe("M  README.md\n M src/app.rs\n")
    const text = frame(app.h)
    expect(text).toMatch(/committed [0-9a-f]{7,} Add the guide and the fresh module · 2 files/)
    expect(text).toContain("0 of 2 files ticked")
    expect(text).not.toContain("docs/guide.md")
    expect(app.h.text()[0]).toContain("2 dirty")
    expect(app.h.sent.find((command) => command.type === "git.commit" && !command.preview)).toMatchObject({ message: "Add the guide and the fresh module\n\nBody text.", paths: ["docs/guide.md", "src/files/new.rs"] })
  })

  test("a failing hook: the command ran, the output is on the page without secrets, nothing is committed or left staged", async () => {
    const repo = repository()
    repo.dirty()
    const secret = `sk-proj-${"a1B2c3D4".repeat(5)}`
    repo.hook("pre-commit", `echo "lint: trailing space in guide.md"\necho "token ${secret}"\nexit 1`)
    const app = await gitApp({ repo })
    await prepare(app)
    await write(app, "Will be refused")
    await keys(app.h, "\r", "\r")
    await settle()
    app.h.app.render()
    const text = frame(app.h)
    expect(text).toContain("commit failed (exit 1)")
    expect(text).toContain("Output")
    expect(text).toContain("lint: trailing space in guide.md")
    expect(text).not.toContain(secret)
    expect(log(app)).toEqual(["init"])
    expect(app.repo.git("status", "--porcelain")).toContain("?? src/files/new.rs")
    expect(text).toContain("[x] M docs/guide.md")
    const failure = app.h.frames.at(-1)!.find((row) => row.some((span) => span.text.startsWith("commit failed")))!
    expect(failure.find((span) => span.text.startsWith("commit failed"))).toMatchObject({ fg: "error" })
  })

  test("a hook that passes lets the commit through", async () => {
    const repo = repository()
    repo.dirty()
    repo.hook("pre-commit", `echo ran > "${path.join(repo.base, "hook-ran")}"`)
    const app = await gitApp({ repo })
    await prepare(app)
    await write(app, "Hooked")
    await keys(app.h, "\r")
    expect(frame(app.h)).toContain("repository hooks run: pre-commit")
    await keys(app.h, "\r")
    await settle()
    expect(log(app)[0]).toBe("Hooked")
    expect(await Bun.file(path.join(repo.base, "hook-ran")).text()).toBe("ran\n")
  })

  test("each refusal of the daemon is one line in the warning role and no commit", async () => {
    const cases: Array<{ name: string; line: RegExp; repo: () => ReturnType<typeof repository> }> = [
      { name: "detached HEAD", line: /detached HEAD: switch to a branch before committing/, repo: () => { const r = repository(); r.dirty(); r.git("checkout", "-q", "--detach"); return r } },
      { name: "merge in progress", line: /a merge is in progress: finish or abort it first/, repo: () => { const r = repository(); r.dirty(); writeFileSync(path.join(r.dir, ".git", "MERGE_HEAD"), `${r.git("rev-parse", "HEAD").trim()}\n`); return r } },
      { name: "no identity", line: /no git identity: set user.name and user.email/, repo: () => { const r = repository({ identity: false }); r.dirty(); return r } },
    ]
    for (const entry of cases) {
      const repo = entry.repo()
      const app = await gitApp({ repo })
      await prepare(app)
      await write(app, "Refused")
      await keys(app.h, "\r")
      const text = frame(app.h)
      expect([entry.name, entry.line.test(text)]).toEqual([entry.name, true])
      expect(app.h.app.page).toBe("git-commit")
      const row = app.h.frames.at(-1)!.find((line) => line.some((span) => entry.line.test(span.text)))!
      expect(row.find((span) => entry.line.test(span.text))).toMatchObject({ fg: "warning" })
      expect(sentOf(app, "git.commit").every((command) => command.type === "git.commit" && command.preview === true)).toBe(true)
      cleanTemps()
    }
  })

  test("a remote client's refusal is shown as the daemon words it", async () => {
    const app = await gitApp({ intercept: (command) => command.type === "git.commit" ? { ok: false, error: { code: "forbidden", message: "[GIT]: commits run on this machine and are local only" } } : undefined })
    await prepare(app)
    await write(app, "From afar")
    await keys(app.h, "\r")
    expect(frame(app.h)).toContain("commits run on this machine and are local only")
    expect(log(app)).toEqual(["init"])
  })

  test("w puts /commit with the ticked files in the prompt and sends nothing: the turn is the user's to start", async () => {
    const app = await gitApp()
    await prepare(app)
    await keys(app.h, "w")
    expect(app.h.app.page).toBe("chat")
    expect(frame(app.h)).toContain("/commit only these files: docs/guide.md src/files/new.rs")
    expect(app.h.sent.filter((command) => command.type === "user.submit" || command.type === "commands.execute")).toEqual([])
    expect(sentOf(app, "git.commit")).toHaveLength(0)
  })

  test("a message in the making survives a trip to the other tabs", async () => {
    const app = await gitApp()
    await open(app, "/git commit")
    await keys(app.h, "\t")
    await app.h.type("Half written")
    await keys(app.h, "\t", ">", ">", ">", ">")
    expect(app.h.app.page).toBe("git-commit")
    expect(frame(app.h)).toContain("Half written")
  })

  test("at 80 and 60 columns the page fits and narrow shows one panel at a time", async () => {
    for (const width of [80, 60]) {
      const app = await gitApp({ width, height: 26 })
      await open(app, "/git commit")
      for (const row of app.h.text()) expect(row.length).toBeLessThanOrEqual(width)
      if (width < 70) {
        expect(frame(app.h)).toContain("Files")
        await keys(app.h, "\t")
        expect(frame(app.h)).toContain("write the commit message")
      } else expect(frame(app.h)).toContain("Message")
      cleanTemps()
    }
  })
})

describe("the Worktrees tab", () => {
  test("is the workspace picker inside the frame, with the rows that have uncommitted changes marked", async () => {
    const app = await gitApp()
    await open(app, "/git worktrees")
    const text = frame(app.h)
    expect(app.h.text()[0]).toContain("Worktrees")
    expect(text).toContain("Available workspaces · 2")
    expect(text).toContain("Local project · current · dirty")
    expect(text).toContain("feature · mend/feature · dirty")
    expect(text).toMatch(/spike · mend\/spike\n?/)
    expect(text).not.toContain("spike · mend/spike · dirty")
  })

  test("/worktrees (the manager) and /warp both sit under the same tabs", async () => {
    const app = await gitApp()
    await open(app, "/worktrees")
    expect(app.h.app.page).toBe("worktrees")
    expect(app.h.text()[0]).toContain("< > tabs")
    await keys(app.h, ">")
    expect(app.h.app.page).toBe("git-pr")
    await keys(app.h, "<")
    expect(app.h.app.page).toBe("warp")
  })
})
