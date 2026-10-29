import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { readChanges, NotGitError } from "../../../packages/daemon/src/changes"
import { GitCommitRefusal, gitCommit } from "../../../packages/daemon/src/git-commit"
import { denyingRule } from "../../../packages/daemon/src/git-actions-policy"
import { gitInit } from "../../../packages/daemon/src/git-init"
import { gitPrCreate, gitPrView } from "../../../packages/daemon/src/git-pr"
import { gitPublish } from "../../../packages/daemon/src/git-publish"
import { gitPush } from "../../../packages/daemon/src/git-push"
import { GitActionRefusal } from "../../../packages/daemon/src/git-remote"
import type { Bench } from "../../../packages/daemon/test/git-actions-bench"
import { readGitStatus } from "../../../packages/daemon/src/git-status"
import { viewFile } from "../../../packages/daemon/src/file-view"
import { FileApiError } from "../../../packages/daemon/src/file-rest-process"
import { b30Report } from "./b30-fixtures"
import { appHarness, conversation, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"

/**
 * The Git page's test bench: a real repository on disk with a few kinds of change, and the daemon's own reads and `git.commit` behind the app's
 * `send`, so a frame is a screen of the wired app and a commit really happens in the temporary repository. Shared by the tests and by
 * `scripts/render-git-frames.ts`.
 */

/** The answers `gitApp`'s daemon still owes its app (a real `git` or the fake `gh` is running). */
let inFlight = 0
const SETTLE_TICK_MS = 2
const SETTLE_MS = 25

/**
 * The pause after a key: 25 ms, or less once the app has nothing outstanding (no answer owed for two ticks in a row). Most keys send
 * nothing, and the fixed 25 ms made the forty backspaces that clear a field take a second. A test that needs an answer slower than
 * 25 ms settles again, as before.
 */
export async function settle() {
  const end = performance.now() + SETTLE_MS
  for (let quiet = 0; quiet < 2 && performance.now() < end; quiet = inFlight === 0 ? quiet + 1 : 0) await Bun.sleep(SETTLE_TICK_MS)
}

/** An environment in which no global git config or machine identity can leak into the repository under test. */
export function isolated(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  for (const name of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER|DIR|WORK_TREE|INDEX)/.test(name)) delete env[name]
  return env
}

export type Repo = ReturnType<typeof repository>

export function repository(options: { identity?: boolean } = {}) {
  const base = tempDir("mendcode-git-page-")
  const dir = path.join(base, "repo")
  mkdirSync(dir)
  mkdirSync(path.join(base, "home"))
  const env = isolated(path.join(base, "home"))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }
  git("init", "-q", "-b", "main")
  if (options.identity !== false) { git("config", "user.name", "Tester"); git("config", "user.email", "tester@example.test") }
  write("src/app.rs", ["fn main() {", "    run();", "}", ""].join("\n"))
  write("src/files/link.rs", "pub fn link() {}\n")
  write("docs/guide.md", "# Guide\n\nOne.\n")
  write("README.md", "# Project\n")
  git("add", ".")
  // Without an identity only the daemon's commit is meant to fail: git guesses one from the host on macOS but not on a CI runner.
  git(...(options.identity === false ? ["-c", "user.name=Setup", "-c", "user.email=setup@example.test"] : []), "commit", "-q", "-m", "init")
  const hook = (name: string, body: string) => { const file = path.join(dir, ".git", "hooks", name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755) }
  /** The working tree the screens show: two modified files, a new one, and one change already staged for another file. */
  const dirty = () => {
    write("src/app.rs", ["fn main() {", "    run();", "    report();", "}", ""].join("\n"))
    write("docs/guide.md", "# Guide\n\nOne.\n\nTwo.\n")
    write("src/files/new.rs", "pub fn fresh() {}\n")
    write("README.md", "# Project\n\nStaged elsewhere.\n")
    git("add", "README.md")
  }
  /** A local bare repository as `origin`, with one commit on the branch that it does not have: one ahead, none behind. Nothing leaves the machine. */
  const upstream = () => {
    const remote = path.join(base, "remote.git")
    Bun.spawnSync(["git", "init", "-q", "--bare", remote], { env })
    git("remote", "add", "origin", remote)
    git("push", "-q", "-u", "origin", "main")
    write("ahead.txt", "one commit ahead\n")
    git("add", "ahead.txt")
    git("commit", "-q", "-m", "ahead")
  }
  return { base, dir, env, git, write, hook, dirty, upstream }
}

/** A folder that is not a repository, with a few files in it and a temporary home and git configuration (so `init.defaultBranch` is the test's to set). Shaped like `repository()` so an app can take it. */
export function folder(options: { config?: string; files?: boolean } = {}): Repo {
  const base = tempDir("mendcode-git-folder-")
  const dir = path.join(base, "project")
  mkdirSync(dir)
  mkdirSync(path.join(base, "home"))
  const global = path.join(base, "gitconfig")
  writeFileSync(global, options.config ?? "")
  const env: NodeJS.ProcessEnv = { ...isolated(path.join(base, "home")), GIT_CONFIG_GLOBAL: global }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }
  if (options.files !== false) {
    write("src/app.rs", ["fn main() {", "    run();", "}", ""].join("\n"))
    write("docs/guide.md", "# Guide\n\nOne.\n")
    write("README.md", "# Project\n")
    write(".gitignore", "target/\n.env\n")
    write(".env", "TOKEN=1\n")
  }
  const hook = (name: string, body: string) => { const file = path.join(dir, ".git", "hooks", name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755) }
  return { base, dir, env, git, write, hook, dirty: () => undefined, upstream: () => undefined }
}

const ok = (result: unknown) => ({ ok: true, result }) as CommandReply
const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as CommandReply

/** A bench of the push and pull request tests (a local bare `origin`, a logging git, a fake gh) as the repository of an app. */
function benchRepo(b: Bench): Repo {
  return { base: b.base, dir: b.dir, env: b.plain, git: (...args: string[]) => b.sh(...args), write: b.write, hook: b.hook, dirty: () => undefined, upstream: () => undefined }
}

export type GitSetup = {
  profile?: Partial<TuiProfile>
  tier?: "minimalist" | "balanced" | "full" | null
  width?: number
  height?: number
  settings?: Record<string, unknown>
  /** The repository to use (default: a fresh one with `dirty()` applied). */
  repo?: Repo
  /** A bench with a remote and a fake gh: `git.push`, `git.pr.view` and `git.pr.create` run for real against it, behind the same gate the daemon has. */
  bench?: Bench
  /** Replaces the bench's environment for the actions (no gh, say). */
  actionEnv?: NodeJS.ProcessEnv
  /** Decides over the daemon's answer to a command, before the real one runs. */
  intercept?: (command: CommandInput) => CommandReply | undefined
}

export async function gitApp(setup: GitSetup = {}) {
  const repo = setup.repo ?? (setup.bench ? benchRepo(setup.bench) : (() => { const made = repository(); made.dirty(); return made })())
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...setup.profile })
  const workspaces = [
    { id: "ws_feature", name: "feature", type: "worktree", branch: "mend/feature", directory: path.join(repo.base, "feature") },
    { id: "ws_spike", name: "spike", type: "worktree", branch: "mend/spike", directory: path.join(repo.base, "spike") },
  ]
  const reply = async (command: CommandInput): Promise<CommandReply> => {
    inFlight++
    try { return await answer(command) } finally { inFlight-- }
  }
  const answer = async (command: CommandInput): Promise<CommandReply> => {
    const early = setup.intercept?.(command)
    if (early) return early
    if (command.type === "changes.query") return readChanges(command.directory).then(ok, (error) => error instanceof NotGitError ? fail("not_git", error.message) : fail("internal", String(error)))
    if (command.type === "changes.file") return readChanges(command.directory, { only: command.path }).then((report) => ok(report.files[0] ?? {}))
    if (command.type === "git.status") return ok(await readGitStatus(command.directory))
    if (command.type === "git.commit") {
      return gitCommit({ directory: command.directory, message: command.message, paths: command.paths, env: repo.env, ...(command.preview ? { preview: true } : {}) })
        .then(ok, (error) => error instanceof GitCommitRefusal ? fail(error.code, error.message) : fail("internal", String(error)))
    }
    if (command.type === "git.init") {
      // The daemon's own function; the project folder of the session is the app's directory.
      return gitInit({ directory: command.directory, project: repo.dir, env: repo.env, ...(command.preview ? { preview: true } : {}) })
        .then(ok, (error) => error instanceof GitActionRefusal ? fail(error.code, error.message) : fail("internal", String(error)))
    }
    if (setup.bench && (command.type === "git.push" || command.type === "git.publish" || command.type === "git.pr.view" || command.type === "git.pr.create")) {
      // The daemon's own gate, then its own functions, with the user's permission rules left out (the daemon tests cover them).
      const settings = setup.settings as { experimental?: { git_actions?: boolean }; features?: { git_actions?: boolean } } | undefined
      if (settings?.experimental?.git_actions !== true || settings.features?.git_actions === false) return fail("forbidden", "[GIT]: push and pull requests are off: they reach the network through git and gh, so turn them on with /experimental git_actions on")
      const env = setup.actionEnv ?? setup.bench.env
      // The user's own deny rules of permission.bash, as the daemon applies them.
      const permission = (setup.settings as { permission?: unknown } | undefined)?.permission
      const denied = permission ? denyingRule({ settings: { permission } as never, directory: repo.dir }) : undefined
      const settle = (run: Promise<unknown>) => run.then(ok, (error) => error instanceof GitActionRefusal ? fail(error.code, error.message) : fail("internal", String(error)))
      if (command.type === "git.publish") return settle(gitPublish({ directory: command.directory, env, ...(denied ? { denied } : {}), ...(command.name !== undefined ? { name: command.name } : {}), ...(command.owner !== undefined ? { owner: command.owner } : {}), ...(command.description !== undefined ? { description: command.description } : {}), ...(command.preview ? { preview: true } : {}) }))
      if (command.type === "git.push") return settle(gitPush({ directory: command.directory, env, ...(command.confirm !== undefined ? { confirm: command.confirm } : {}), ...(command.preview ? { preview: true } : {}) }))
      if (command.type === "git.pr.view") return settle(gitPrView({ directory: command.directory, env }))
      return settle(gitPrCreate({ directory: command.directory, env, ...(command.title !== undefined ? { title: command.title } : {}), ...(command.body !== undefined ? { body: command.body } : {}), ...(command.base !== undefined ? { base: command.base } : {}), ...(command.draft ? { draft: true } : {}), ...(command.preview ? { preview: true } : {}) }))
    }
    if (command.type === "file.view") {
      return viewFile({ directory: command.directory, path: command.path, from: command.from, count: command.count, search: command.search, known: command.known, lang: command.lang })
        .then(ok, (error) => fail("invalid_command", error instanceof FileApiError ? error.message : String(error)))
    }
    if (command.type === "worktree.query") {
      // The project checkout and the first workspace, which has uncommitted changes.
      const report = b30Report()
      report.workspace = { ...report.workspace, currentPath: repo.dir, repoRoot: repo.dir }
      const changed = { clean: false, summary: "Uncommitted changes", checkedAt: 0 }
      report.records = report.records.slice(0, 2).map((record, index) => ({ ...record, path: index === 0 ? repo.dir : workspaces[0]!.directory, dirty: changed }))
      return ok({ ...report, operation: (command.query as { operation: string }).operation })
    }
    if (command.type === "project.rest") {
      const operation = (command.input as { operation: string }).operation
      if (operation === "workspace-list") return ok({ workspaces })
      if (operation === "current") return ok({ project: { worktree: repo.dir } })
      if (operation === "workspace-status") return ok({ statuses: workspaces.map((item) => ({ workspaceID: item.id, status: "connected" })) })
    }
    return { ok: true } as CommandReply
  }
  const h = appHarness({ dataDir, directory: repo.dir, width: setup.width ?? 120, height: setup.height ?? 32, reply })
  h.app.applySettings({ onboarded: true, ...(setup.tier === null ? {} : { tier: setup.tier ?? "balanced" }), reducedMotion: true, ...(setup.settings ?? {}) })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("What changed?", "Two files, and a new one.")
  h.app.render()
  return { h, repo }
}

export type GitApp = Awaited<ReturnType<typeof gitApp>>
export const frame = (h: GitApp["h"]) => h.text().join("\n")
/** The frame as one line of words: a message that holds a temp path wraps where that path's length puts it (macOS and Linux differ). */
export const prose = (h: GitApp["h"]) => h.text().join(" ").replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ")
export const rowOf = (h: GitApp["h"], needle: string) => h.text().findIndex((row) => row.includes(needle))
/** Keys, one at a time (`\r` is Enter), then a frame once the daemon's answers have settled. */
export async function keys(h: GitApp["h"], ...sequence: string[]) {
  for (const key of sequence) { await h.app.onKey(key); await settle() }
  h.app.render()
}
export const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
export const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
/** A plain click on the first cell of `needle` (plus `offset`) in the frame. */
export async function click(h: GitApp["h"], needle: string, offset = 1) {
  const row = rowOf(h, needle)
  if (row < 0) throw new Error(`[TEST]: "${needle}" is not on screen`)
  const col = h.text()[row]!.indexOf(needle) + offset
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  await settle()
  h.app.render()
}
