import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import { folder, frame, gitApp, keys, repository, settle, type GitApp, type GitSetup, type Repo } from "../apps/cli/test/git-page-helpers"
import { activeTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import { bench as makeBenchmark, cleanBenches, cleanBenchTemplates, type Bench } from "../packages/daemon/test/git-actions-bench"
import { publishBench } from "../packages/daemon/test/git-publish-bench"

/**
 * The Git page's frames: every one is a screen of the real wired app (appHarness: createApp, the real renderer) over a real temporary
 * repository, with the daemon's own `changes.query`, `git.status`, `git.commit` and `worktree.query` behind `send`. Usage:
 * `bun scripts/render-git-frames.ts [directory]`. Writes, for each scene, `<name>.txt` and `<name>.ansi` (the dark theme `mend`),
 * `<name>.light.txt` and `<name>.light.ansi` (the light theme `paper`) and `<name>.roles.txt`: every row with each span tagged by its
 * theme role and attributes, dark then light, with the color each role has in the theme. `PREVIEW.txt` is the Commit tab.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/git-page")
mkdirSync(target, { recursive: true })

/** `repo` and `bench` are makers: each theme gets a repository (or a bench with a local remote and a fake gh) of its own. */
type Setup = Omit<GitSetup, "repo" | "bench" | "actionEnv"> & { repo?: () => Repo; bench?: () => Bench; actionEnv?: (bench: Bench) => NodeJS.ProcessEnv }
/** `bun scripts/render-git-frames.ts <directory> pr` writes only the scenes whose name starts with `pr`, `push` or `create` (phase 2: the PR tab and the actions). */
const only = process.argv[3] === "pr" ? /^(pr|push|create)-/ : process.argv[3] === "publish" ? /^(init|noremote|publish)-/ : undefined

const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const

function frameRows(app: GitApp) {
  const lines = app.h.frames.at(-1) ?? []
  return { text: lines.map(plain), ansi: lines.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")) }
}

/** `fg=text bold` for a span: the role of the foreground and background, then the attributes. A span with no role takes the terminal's own colors. */
function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  if (span.link) parts.push("link")
  return parts.join(" ")
}

function rolesOf(lines: Line[]): string[] {
  return lines.map((line, row) => {
    const merged: Span[] = []
    for (const span of line) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    // A run of padding is told by its length, so the row stays readable.
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(row).padStart(2)}| ${merged.filter((span) => span.text !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

function roleTable(): string[] {
  const colors = activeTheme().colors as Record<string, string>
  return Object.entries(colors).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)
}

async function scene(name: string, setup: Setup, act: (app: GitApp) => Promise<void>) {
  if (only && !only.test(name)) return undefined as never
  const sections: string[] = []
  let main: GitApp | undefined
  for (const theme of THEMES) {
    const { repo: make, bench: makeBench, actionEnv, ...rest } = setup
    const bench = makeBench?.()
    const app = await gitApp({ ...rest, ...(make ? { repo: make() } : {}), ...(bench ? { bench, ...(actionEnv ? { actionEnv: actionEnv(bench) } : {}) } : {}), profile: { ...setup.profile, theme: theme.name } })
    await act(app)
    await settle()
    app.h.app.render()
    sections.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(app.h.frames.at(-1) ?? []), "", `roles in ${theme.name}:`, ...roleTable(), "")
    const rows = frameRows(app)
    const suffix = theme.label === "dark" ? "" : ".light"
    writeFileSync(path.join(target, `${name}${suffix}.txt`), rows.text.join("\n") + "\n")
    writeFileSync(path.join(target, `${name}${suffix}.ansi`), rows.ansi.join("\n") + "\n")
    if (theme.label === "dark") { main = app; console.log(`${name}: ${frame(app.h).split("\n").length} rows`) }
  }
  writeFileSync(path.join(target, `${name}.roles.txt`), sections.join("\n") + "\n")
  return main!
}

const open = async (app: GitApp, command: string) => { await app.h.type(`${command}\r`); await settle() }
/** docs/guide.md and src/files/new.rs ticked, a message written, back on the files. */
const ticked = async (app: GitApp, message = "Add the guide and the fresh module") => {
  await open(app, "/git commit")
  await keys(app.h, " ", "G", " ", "\t")
  await app.h.type(message)
  await keys(app.h, "\t")
}
const dirty = (hook?: string) => () => { const repo = repository(); repo.dirty(); if (hook) repo.hook("pre-commit", hook); return repo }
const ahead = () => { const repo = repository(); repo.upstream(); repo.dirty(); return repo }

for (const width of [120, 80]) {
  const height = width === 120 ? 30 : 26
  await scene(`changes-${width}`, { width, height, repo: ahead }, async (app) => { await open(app, "/git") })
  await scene(`commit-${width}`, { width, height, repo: ahead }, async (app) => { await open(app, "/git commit"); await keys(app.h, " ", "G", " ") })
  await scene(`commit-message-${width}`, { width, height, repo: ahead }, ticked)
  await scene(`commit-confirm-${width}`, { width, height, repo: ahead }, async (app) => { await ticked(app); await keys(app.h, "\r") })
  await scene(`worktrees-${width}`, { width, height, repo: ahead }, async (app) => { await open(app, "/git worktrees") })
}
await scene("commit-narrow-60", { width: 60, height: 24 }, async (app) => { await open(app, "/git commit"); await keys(app.h, " ") })
await scene("commit-confirm-hooks", { width: 120, height: 30, repo: dirty("exit 0") }, async (app) => { await ticked(app); await keys(app.h, "\r") })
await scene("commit-done", { width: 120, height: 30, repo: ahead }, async (app) => { await ticked(app); await keys(app.h, "\r", "\r"); await settle() })

// The hook failure: its output is on the page, redacted.
await scene("commit-hook-failure", { width: 120, height: 30, repo: dirty(`echo "lint: trailing space in docs/guide.md"\necho "token sk-proj-${"a1B2c3D4".repeat(5)}"\nexit 1`) }, async (app) => {
  await ticked(app, "Add the guide")
  await keys(app.h, "\r", "\r")
  await settle()
})

// Each refusal is one line.
await scene("refusal-nothing-selected", { width: 120, height: 30 }, async (app) => { await open(app, "/git commit"); await keys(app.h, "\r") })
await scene("refusal-empty-message", { width: 120, height: 30 }, async (app) => { await open(app, "/git commit"); await keys(app.h, " ", "\r") })
await scene("refusal-detached", { width: 120, height: 30, repo: () => { const repo = dirty()(); repo.git("checkout", "-q", "--detach"); return repo } }, async (app) => { await ticked(app, "Refused"); await keys(app.h, "\r") })
await scene("refusal-merge", { width: 120, height: 30, repo: () => { const repo = dirty()(); repo.write(".git/MERGE_HEAD", `${repo.git("rev-parse", "HEAD").trim()}\n`); return repo } }, async (app) => { await ticked(app, "Refused"); await keys(app.h, "\r") })
await scene("refusal-no-identity", { width: 120, height: 30, repo: () => { const repo = repository({ identity: false }); repo.dirty(); return repo } }, async (app) => { await ticked(app, "Refused"); await keys(app.h, "\r") })
await scene("refusal-remote", { width: 120, height: 30, intercept: (command) => command.type === "git.commit" ? { ok: false, error: { code: "forbidden", message: "[GIT]: commits run on this machine and are local only" } } : undefined }, async (app) => { await ticked(app, "From afar"); await keys(app.h, "\r") })

// Minimalist: nothing new. /changes is the page it was, /git is refused.
await scene("minimalist-changes", { width: 120, height: 30, tier: "minimalist" }, async (app) => { await open(app, "/changes") })
await scene("minimalist-git", { width: 120, height: 30, tier: "minimalist" }, async (app) => { await open(app, "/git") })

// Phase 2: the PR tab and the actions that leave the machine. The remote is a local bare repository and gh is a fake on the PATH: nothing leaves this machine.
const ON = { experimental: { git_actions: true } }
const BRANCH = "feat/pr-tab"
const SUBJECTS = ["Add the PR tab to the Git page", "Show the checks of the pull request", "Keep the push card to the exact command"]
const VIEW = JSON.stringify({
  number: 42, title: "Git page: a PR tab, push and create pull request", url: "https://github.com/acme/widgets/pull/42", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
  reviewDecision: "CHANGES_REQUESTED", headRefName: BRANCH, baseRefName: "main", author: { login: "mara" }, comments: [], reviews: [],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "linux / typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "linux / test (cli)", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "windows / test", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "docs", status: "IN_PROGRESS" },
  ],
})
const NO_PR = { stderr: `no pull requests found for branch "${BRANCH}"`, exit: 1 }
/** A branch with `pushed` commits already on the remote and `unpushed` on top of them; gh answers `answer`. */
function branchBench(input: { pushed?: number; unpushed?: number; answer?: Parameters<Bench["gh"]["reply"]>[0]; onMain?: boolean }) {
  return () => {
    const bench = makeBenchmark()
    if (!input.onMain) bench.checkout(BRANCH)
    const commit = (count: number, from: number) => { for (let index = 0; index < count; index++) bench.commit(SUBJECTS[(from + index) % SUBJECTS.length]!) }
    commit(input.pushed ?? 0, 0)
    if (input.pushed) bench.sh("push", "-q", "-u", "origin", BRANCH)
    commit(input.unpushed ?? 0, input.pushed ?? 0)
    bench.gh.reply(input.answer ?? { stdout: VIEW })
    bench.clearCalls()
    return bench
  }
}
let pushCard: Awaited<ReturnType<typeof scene>> | undefined
for (const width of [120, 80]) {
  const height = width === 120 ? 30 : 26
  await scene(`pr-view-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 2 }) }, async (app) => { await open(app, "/git pr") })
  await scene(`pr-none-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr") })
  await scene(`pr-off-${width}`, { width, height, bench: branchBench({ pushed: 2 }) }, async (app) => { await open(app, "/git pr") })
  await scene(`pr-ghmissing-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 2 }), actionEnv: (bench) => bench.withoutGh }, async (app) => { await open(app, "/git pr") })
  const card = await scene(`push-card-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 1, unpushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "u") })
  if (width === 120) pushCard = card
  await scene(`create-form-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "P") })
  await scene(`create-card-${width}`, { width, height, settings: ON, bench: branchBench({ pushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "P", "\t", "\t", "\t", "\r") })
}
await scene("push-card-noupstream", { width: 120, height: 30, settings: ON, bench: branchBench({ unpushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "u") })
await scene("push-card-protected", { width: 120, height: 30, settings: ON, bench: branchBench({ onMain: true, unpushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "u"); await app.h.type("ma") })
await scene("push-rejected", { width: 120, height: 30, settings: ON, bench: () => {
  const bench = branchBench({ pushed: 1, answer: NO_PR })()
  const other = bench.other()
  other.git("fetch", "-q", "origin", BRANCH)
  other.git("checkout", "-q", "-b", BRANCH, `origin/${BRANCH}`)
  other.commit("Someone else pushed first")
  other.git("push", "-q", "origin", BRANCH)
  bench.commit("Keep the push card to the exact command")
  bench.clearCalls()
  return bench
} }, async (app) => { await open(app, "/git pr"); await keys(app.h, "u", "\r"); await settle() })
await scene("push-done", { width: 120, height: 30, settings: ON, bench: branchBench({ unpushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "u", "\r"); await settle() })
await scene("create-form-narrow-60", { width: 60, height: 24, settings: ON, bench: branchBench({ pushed: 2, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "P") })
await scene("create-form-unpushed", { width: 120, height: 30, settings: ON, bench: branchBench({ pushed: 1, unpushed: 1, answer: NO_PR }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "P") })
await scene("create-failed", { width: 120, height: 30, settings: ON, bench: () => {
  const bench = branchBench({ pushed: 2, answer: NO_PR })()
  return bench
}, actionEnv: (bench) => { bench.gh.reply({ stderr: "GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and feat/pr-tab", exit: 1 }); return bench.env } }, async (app) => { await open(app, "/git pr"); await keys(app.h, "P", "\t", "\t", "\t", "\r", "\r"); await settle() })
await scene("pr-link-copied", { width: 120, height: 30, settings: ON, bench: branchBench({ pushed: 2 }) }, async (app) => { await open(app, "/git pr"); await keys(app.h, "o") })

// Phase 3: a folder that is not a repository (Initialize, local only), and a repository with no remote (Publish, behind the switch). Nothing leaves this machine:
// the remote is never created, and gh is a fake on the PATH.
const GONE = "[GIT]: push, publish and pull requests run on this machine and are local only"
for (const width of [120, 80]) {
  const height = width === 120 ? 30 : 26
  await scene(`init-state-${width}`, { width, height, repo: () => folder() }, async (app) => { await open(app, "/git") })
  await scene(`init-card-${width}`, { width, height, repo: () => folder() }, async (app) => { await open(app, "/git"); await keys(app.h, "i") })
  await scene(`init-done-${width}`, { width, height, repo: () => folder() }, async (app) => { await open(app, "/git"); await keys(app.h, "i", "\r"); await settle() })
}
await scene("init-state-narrow-60", { width: 60, height: 24, repo: () => folder() }, async (app) => { await open(app, "/git") })
await scene("init-card-config", { width: 120, height: 30, repo: () => folder({ config: "[init]\n\tdefaultBranch = trunk\n" }) }, async (app) => { await open(app, "/git"); await keys(app.h, "i") })
await scene("init-refused-home", { width: 120, height: 30, repo: () => { const repo = folder(); repo.env = { ...repo.env, HOME: repo.dir }; return repo } }, async (app) => { await open(app, "/git") })
await scene("init-refused-broken", { width: 120, height: 30, repo: () => { const repo = folder(); mkdirSync(path.join(repo.dir, ".git")); return repo } }, async (app) => { await open(app, "/git") })
await scene("init-refused-remote", { width: 120, height: 30, repo: () => folder(), intercept: (command) => command.type === "git.init" ? { ok: false, error: { code: "forbidden", message: "[GIT]: initializing a repository runs git on this machine and is local only" } } : undefined }, async (app) => { await open(app, "/git") })
await scene("init-failed", { width: 120, height: 30, repo: () => folder(), intercept: (command) => command.type === "git.init" && !command.preview ? { ok: false, error: { code: "invalid_command", message: "[GIT]: git init failed (exit 1)\nfatal: cannot mkdir .git/hooks: Permission denied" } } : undefined }, async (app) => { await open(app, "/git"); await keys(app.h, "i", "\r"); await settle() })

const PUBLISH_URL = "https://github.com/me/widgets"
/** A repository with `commits` commits and no remote; gh knows the account `me` and, like the real one, adds the remote it was asked for. */
function localBench(input: { commits?: number; user?: Parameters<ReturnType<typeof publishBench>["user"]>[0]; add?: boolean; reply?: Parameters<Bench["gh"]["reply"]>[0]; unborn?: boolean } = {}) {
  return () => {
    const bench = publishBench()
    bench.user(input.user)
    bench.addsRemote(input.add === false ? undefined : `${PUBLISH_URL}.git`)
    bench.gh.reply(input.reply ?? { stdout: PUBLISH_URL })
    if (input.unborn) bench.sh("checkout", "-q", "--orphan", "fresh")
    for (let index = 1; index < (input.commits ?? 1); index++) bench.commit(SUBJECTS[index % SUBJECTS.length]!)
    bench.clearCalls()
    return bench
  }
}
const publishOpen = async (app: GitApp) => { await open(app, "/git pr"); await keys(app.h, "g") }
const publishCardKeys = async (app: GitApp) => { await publishOpen(app); await keys(app.h, "\t", "\t", "\r") }
let publishCard: Awaited<ReturnType<typeof scene>> | undefined
await scene("noremote-off-120", { width: 120, height: 30, bench: localBench() }, async (app) => { await open(app, "/git pr") })
for (const width of [120, 80]) {
  const height = width === 120 ? 30 : 26
  await scene(`noremote-on-${width}`, { width, height, settings: ON, bench: localBench({ commits: 3 }) }, async (app) => { await open(app, "/git pr") })
  await scene(`publish-form-${width}`, { width, height, settings: ON, bench: localBench({ commits: 3 }) }, publishOpen)
  const card = await scene(`publish-card-${width}`, { width, height, settings: ON, bench: localBench({ commits: 3 }) }, async (app) => { await publishOpen(app); await keys(app.h, "\t", "\t"); await app.h.type("Small widgets for the shop"); await keys(app.h, "\r") })
  if (width === 120) publishCard = card
  await scene(`publish-done-${width}`, { width, height, settings: ON, bench: localBench({ commits: 3 }) }, async (app) => { await publishCardKeys(app); await keys(app.h, "\r"); await settle() })
}
await scene("noremote-narrow-60", { width: 60, height: 24, settings: ON, bench: localBench() }, async (app) => { await open(app, "/git pr") })
await scene("publish-form-narrow-60", { width: 60, height: 24, settings: ON, bench: localBench() }, publishOpen)
await scene("publish-card-unborn", { width: 120, height: 30, settings: ON, bench: localBench({ unborn: true }) }, publishCardKeys)
await scene("publish-done-unborn", { width: 120, height: 30, settings: ON, bench: localBench({ unborn: true }) }, async (app) => { await publishCardKeys(app); await keys(app.h, "\r"); await settle() })
await scene("publish-refused-ghmissing", { width: 120, height: 30, settings: ON, bench: localBench(), actionEnv: (bench) => bench.withoutGh }, publishOpen)
await scene("publish-refused-notlogged", { width: 120, height: 30, settings: ON, bench: localBench({ user: { stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 } }) }, publishOpen)
await scene("publish-refused-name", { width: 120, height: 30, settings: ON, bench: localBench() }, async (app) => { await publishOpen(app); await keys(app.h, "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f"); await app.h.type(".hidden repo"); await keys(app.h, "\t", "\t", "\r") })
await scene("publish-refused-origin", { width: 120, height: 30, settings: ON, bench: localBench() }, async (app) => { await open(app, "/git pr"); app.repo.git("remote", "add", "origin", "https://example.test/x/y.git"); await keys(app.h, "g") })
await scene("publish-refused-denied", { width: 120, height: 30, settings: { ...ON, permission: { bash: { "gh repo create *": "deny" } } }, bench: localBench() }, async (app) => { await publishOpen(app); await keys(app.h, "\t", "\t", "\r") })
await scene("publish-refused-remote", { width: 120, height: 30, settings: ON, bench: localBench(), intercept: (command) => command.type === "git.publish" ? { ok: false, error: { code: "forbidden", message: GONE } } : undefined }, publishOpen)
await scene("publish-failed-taken", { width: 120, height: 30, settings: ON, bench: localBench({ add: false, reply: { stderr: "GraphQL: Name already exists on this account (createRepository)", exit: 1 } }) }, async (app) => { await publishCardKeys(app); await keys(app.h, "\r"); await settle() })
await scene("publish-failed-org", { width: 120, height: 30, settings: ON, bench: localBench({ add: false, reply: { stderr: "GraphQL: acme does not have permission to create repositories (createRepository)", exit: 1 } }) }, async (app) => { await publishOpen(app); await keys(app.h, "\t"); await keys(app.h, ...Array(10).fill("\x7f")); await app.h.type("acme"); await keys(app.h, "\t", "\r", "\r"); await settle() })
await scene("publish-partial-120", { width: 120, height: 30, settings: ON, bench: localBench({ add: false, reply: { stdout: PUBLISH_URL, stderr: 'X Unable to add remote "origin"', exit: 1 } }) }, async (app) => { await publishCardKeys(app); await keys(app.h, "\r"); await settle() })
await scene("publish-partial-80", { width: 80, height: 26, settings: ON, bench: localBench({ add: false, reply: { stdout: PUBLISH_URL, stderr: 'X Unable to add remote "origin"', exit: 1 } }) }, async (app) => { await publishCardKeys(app); await keys(app.h, "\r"); await settle() })

const main = only ? (publishCard ?? pushCard!) : await scene("commit-preview", { width: 120, height: 30, repo: ahead }, ticked)
writeFileSync(path.join(target, "PREVIEW.txt"), frameRows(main).text.join("\n") + "\n")
cleanTemps()
cleanBenches()
cleanBenchTemplates()
