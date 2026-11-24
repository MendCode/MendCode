import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { homedir, hostname as osHostname, tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { sshRunner, type SshRunner } from "./remote-setup"
import { applyPathRule, mapProject, normalizeGitRemote, parsePathRule, type PathRule, type RemoteRepo } from "./remote-setup-projects"

/**
 * `remote code ...`: code travels between this machine and a host that runs the same project.
 * - `handoff` / `receive`: the default. A snapshot of the working tree (tracked changes plus new files that are not ignored) is committed with a temporary
 *   index on top of HEAD and pushed to its own new branch `mend/wip-*`. The user's branch, index, files and stash are never touched and nothing is forced.
 *   `receive` fetches those branches and checks the newest one out in its own worktree.
 * - `clone`: the project's git remote is looked for under the usual folders and cloned only when it is not there.
 * - `live`: opt-in two-way sync of one project through an installed Mutagen. Never bundled and never started by anything else.
 * Loaded only by `remote code`. Tests pass fakes for git, Mutagen and SSH.
 */
export type CodeCommand = { dir: string; dryRun: boolean } & (
  | { action: "handoff"; project: string; gitRemote: string; label?: string }
  | { action: "receive"; project: string; gitRemote: string; branch?: string; into?: string }
  | { action: "clone"; source: string; root: string; searchRoots: string[]; pathMaps: PathRule[] }
  | { action: "live"; sub: "enable"; project: string; ssh: string; remotePath?: string; pathMaps: PathRule[]; name?: string; ignores: string[]; includeEnv: boolean; searchRoots: string[] }
  | { action: "live"; sub: "disable" | "status" | "resume"; project: string; name?: string }
  | { action: "live"; sub: "list" }
)

export const CODE_USAGE = [
  "usage: remote code handoff [PROJECT] [--git-remote NAME] [--dry-run]",
  "       remote code receive [PROJECT] [--git-remote NAME] [--branch mend/wip-...] [--into DIR] [--dry-run]",
  "       remote code clone GIT_URL [--root DIR] [--search-root DIR] [--path-map LOCAL=REMOTE] [--dry-run]",
  "       remote code live enable [PROJECT] --ssh USER@HOST [--remote-path DIR | --path-map LOCAL=REMOTE] [--ignore PATTERN] [--include-env] [--dry-run]",
  "       remote code live status|resume|disable [PROJECT] [--name N]      remote code live list",
].join("\n")

const VALUE_FLAGS = ["--dir", "--git-remote", "--branch", "--into", "--ssh", "--remote-path", "--path-map", "--name", "--ignore", "--root", "--search-root"]
const BOOLEAN_FLAGS = ["--dry-run", "--include-env"]
const NAME = /^[A-Za-z0-9._-]{1,64}$/
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:[\]-]{0,252}$/
const ABSOLUTE_REMOTE = /^\/[A-Za-z0-9_./-]*$/
const WIP_BRANCH = /^mend\/wip-[A-Za-z0-9._-]{1,150}$/
const GIT_URL = /^[A-Za-z0-9@:/._~+-]+$/

/** Folders searched for an existing clone, and for a host over SSH. */
export const DEFAULT_SEARCH_ROOTS = ["code", "src", "projects", "work", "dev", "repos", "git"]
/** What a snapshot never includes: untracked files that look like credentials, files over this size, or more files than this. */
export const SNAPSHOT_FILE_MAX_BYTES = 5 * 1024 * 1024
export const SNAPSHOT_UNTRACKED_MAX_FILES = 5000
const SECRET_NAME = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|token)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i
/** Never synced by a live session, whatever the project says. `.env` files join them unless the user opts in. */
export const LIVE_IGNORES = ["node_modules", "dist", "build", ".next", "target", ".venv", "*.log"]
const ENV_IGNORES = [".env", ".env.*"]

export function parseCodeCommand(argv: string[], fallbackDir: string, cwd: string = process.cwd()): CodeCommand | undefined {
  const words: string[] = []
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (VALUE_FLAGS.includes(token)) {
      const next = argv[++i]
      if (!next || next.startsWith("--")) throw new Error(`${token} needs a value`)
      values.set(token, [...values.get(token) ?? [], next])
    } else if (BOOLEAN_FLAGS.includes(token)) flags.add(token)
    else words.push(token)
  }
  const at = words.indexOf("remote")
  if (at < 0 || words[at + 1] !== "code") return undefined
  const rest = words.slice(at + 2)
  const one = (flag: string) => values.get(flag)?.at(-1)
  const dir = path.resolve(one("--dir") ?? fallbackDir)
  const dryRun = flags.has("--dry-run")
  const action = rest[0]
  if (!["handoff", "receive", "clone", "live"].includes(action ?? "")) throw new Error(CODE_USAGE)
  const allowed: Record<string, string[]> = {
    handoff: ["--dir", "--git-remote"], receive: ["--dir", "--git-remote", "--branch", "--into"], clone: ["--dir", "--root", "--search-root", "--path-map"],
    live: ["--dir", "--ssh", "--remote-path", "--path-map", "--name", "--ignore", "--search-root"],
  }
  for (const flag of values.keys()) if (!allowed[action!]!.includes(flag)) throw new Error(`${flag} does not apply to remote code ${action}`)
  if (flags.has("--include-env") && action !== "live") throw new Error("--include-env does not apply here")
  const project = (word: string | undefined) => path.resolve(cwd, word ?? ".")
  const gitRemote = one("--git-remote") ?? "origin"
  if (!NAME.test(gitRemote) || gitRemote.startsWith("-")) throw new Error("--git-remote needs a remote name")
  const pathMaps = (values.get("--path-map") ?? []).map(parsePathRule)
  if (action === "handoff" || action === "receive") {
    if (rest.length > 2) throw new Error(CODE_USAGE)
    if (action === "handoff") return { action, dir, dryRun, project: project(rest[1]), gitRemote }
    const branch = one("--branch")
    if (branch !== undefined && !WIP_BRANCH.test(branch)) throw new Error("--branch needs a mend/wip-... branch")
    return { action, dir, dryRun, project: project(rest[1]), gitRemote, ...(branch ? { branch } : {}), ...(one("--into") ? { into: path.resolve(cwd, one("--into")!) } : {}) }
  }
  if (action === "clone") {
    if (rest.length !== 2) throw new Error(CODE_USAGE)
    const source = rest[1]!
    if (!GIT_URL.test(source) || source.startsWith("-") || !normalizeGitRemote(source)) throw new Error("clone needs a git URL such as https://host/org/repo.git or git@host:org/repo.git")
    return { action, dir, dryRun, source, root: path.resolve(cwd, one("--root") ?? path.join(homedir(), "code")), searchRoots: (values.get("--search-root") ?? []).map((root) => path.resolve(cwd, root)), pathMaps }
  }
  const sub = rest[1]
  if (sub === "list") {
    if (rest.length !== 2) throw new Error(CODE_USAGE)
    return { action: "live", sub, dir, dryRun }
  }
  if (!["enable", "disable", "status", "resume"].includes(sub ?? "") || rest.length > 3) throw new Error(CODE_USAGE)
  const name = one("--name")
  if (name !== undefined && !/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("--name uses lowercase letters, digits and -, starting with a letter")
  if (sub !== "enable") {
    for (const flag of ["--ssh", "--remote-path", "--path-map", "--ignore", "--search-root"]) if (values.has(flag)) throw new Error(`${flag} only applies to remote code live enable`)
    return { action: "live", sub: sub as "disable" | "status" | "resume", dir, dryRun, project: project(rest[2]), ...(name ? { name } : {}) }
  }
  const ssh = one("--ssh")
  if (!ssh || !SSH_TARGET.test(ssh)) throw new Error("live enable needs --ssh [user@]host")
  const remotePath = one("--remote-path")
  if (remotePath !== undefined && (!ABSOLUTE_REMOTE.test(remotePath) || remotePath.split("/").includes(".."))) throw new Error("--remote-path needs an absolute path (letters, digits, _ . - /)")
  const ignores = values.get("--ignore") ?? []
  for (const pattern of ignores) if (!/^[A-Za-z0-9_.*?/{}[\]!-]{1,120}$/.test(pattern)) throw new Error(`--ignore ${pattern} is not a plain pattern`)
  return { action: "live", sub: "enable", dir, dryRun, project: project(rest[2]), ssh, ...(remotePath ? { remotePath } : {}), pathMaps, ...(name ? { name } : {}), ignores, includeEnv: flags.has("--include-env"), searchRoots: values.get("--search-root") ?? [] }
}

export type RunResult = { code: number; stdout: string; stderr: string }
export type GitRunner = (cwd: string, args: string[], options?: { env?: Record<string, string>; input?: string }) => Promise<RunResult>
export type MutagenRunner = (args: string[]) => Promise<RunResult>
export type CodeDeps = { git: GitRunner; mutagen: MutagenRunner; ssh: (target: string) => SshRunner; out: { write(text: string): unknown }; now?: () => number; device?: string }

class CodeError extends Error {}
const scrub = (text: string) => text.replace(/[A-Za-z0-9_-]{32,}/g, "***").replace(/\s+/g, " ").trim().slice(0, 300)
const shq = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

export const runGit: GitRunner = async (cwd, args, options = {}) => {
  const { runProcess } = await import("@mendcode/upgrade/process")
  return runProcess(["git", "-C", cwd, ...args], {
    ...(options.input === undefined ? {} : { input: options.input }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }, ...options.env },
  })
}

export const runMutagen: MutagenRunner = async (args) => {
  const { runProcess } = await import("@mendcode/upgrade/process")
  const done = await runProcess(["mutagen", ...args])
  return done.code === 127 ? { code: 127, stdout: "", stderr: "mutagen not found" } : done
}

async function must(result: Promise<RunResult>, message: string) {
  const done = await result
  if (done.code !== 0) throw new CodeError(`${message}${done.stderr || done.stdout ? `: ${scrub(done.stderr || done.stdout)}` : ""}`)
  return done.stdout.trim()
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14)
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work"

type Project = { top: string; url?: string; id?: string; rel: string; head?: string; branch?: string }
async function identify(git: GitRunner, directory: string): Promise<Project> {
  const top = await must(git(directory, ["rev-parse", "--show-toplevel"]), `${directory} is not inside a git repository`)
  const url = (await git(top, ["remote", "get-url", "origin"])).stdout.trim() || undefined
  const id = url ? normalizeGitRemote(url) : undefined
  const head = (await git(top, ["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim() || undefined
  const branch = (await git(top, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || undefined
  return { top, ...(url ? { url } : {}), ...(id ? { id } : {}), rel: path.relative(top, directory), ...(head ? { head } : {}), ...(branch ? { branch } : {}) }
}

async function gitRemoteExists(git: GitRunner, top: string, remote: string) {
  await must(git(top, ["remote", "get-url", remote]), `this repository has no git remote named ${remote}`)
}

/** Commits a snapshot of the working tree and pushes it to a new branch of its own. */
async function handoff(command: Extract<CodeCommand, { action: "handoff" }>, deps: CodeDeps, say: (line: string) => void) {
  const { git } = deps
  const project = await identify(git, command.project)
  if (!project.head) throw new CodeError("this repository has no commit yet; commit once, then hand off")
  await gitRemoteExists(git, project.top, command.gitRemote)
  const untracked = (await must(git(project.top, ["ls-files", "--others", "--exclude-standard", "-z"]), "listing new files failed")).split("\0").filter(Boolean)
  if (untracked.length > SNAPSHOT_UNTRACKED_MAX_FILES) throw new CodeError(`${untracked.length} new files that are not ignored: add the build output to .gitignore, or commit and push the branch yourself`)
  const included: string[] = []
  const left: string[] = []
  for (const file of untracked) {
    let reason: string | undefined
    if (SECRET_NAME.test(file)) reason = "looks like a credential"
    else {
      try { const stat = lstatSync(path.join(project.top, file)); if (stat.isFile() && stat.size > SNAPSHOT_FILE_MAX_BYTES) reason = "over 5 MiB" } catch { reason = "unreadable" }
    }
    if (reason) left.push(`${file} (${reason})`)
    else included.push(file)
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "mendcode-wip-"))
  try {
    // A throw-away index: the user's own index, files and branch are never read for writing.
    const env = { GIT_INDEX_FILE: path.join(scratch, "index"), GIT_LITERAL_PATHSPECS: "1" }
    // Start from a copy of the real index so files staged as new are kept, then take the working tree's content for every path in it.
    const realIndex = path.resolve(project.top, await must(git(project.top, ["rev-parse", "--git-path", "index"]), "locating the index failed"))
    if (existsSync(realIndex)) copyFileSync(realIndex, env.GIT_INDEX_FILE)
    else await must(git(project.top, ["read-tree", "HEAD"], { env }), "reading HEAD failed")
    await must(git(project.top, ["add", "-u", "--", "."], { env }), "staging tracked changes failed")
    if (included.length) await must(git(project.top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: `${included.join("\0")}\0` }), "staging new files failed")
    const tree = await must(git(project.top, ["write-tree"], { env }), "writing the snapshot failed")
    const headTree = await must(git(project.top, ["rev-parse", "HEAD^{tree}"]), "reading HEAD failed")
    for (const entry of left) say(`  left out: ${entry}`)
    if (tree === headTree) {
      say("The working tree matches HEAD: nothing to hand off. If HEAD is not on the host yet, push your branch the usual way.")
      return
    }
    const changed = (await must(git(project.top, ["diff-tree", "-r", "--name-only", "HEAD", tree]), "comparing the snapshot failed")).split("\n").filter(Boolean)
    const shortHead = project.head.slice(0, 7)
    const name = `mend/wip-${slug(project.branch ?? "detached")}-${stamp((deps.now ?? Date.now)())}-${shortHead}`
    await must(git(project.top, ["check-ref-format", `refs/heads/${name}`]), `${name} is not a usable branch name`)
    say(`Snapshot of ${changed.length} changed file${changed.length === 1 ? "" : "s"} on top of ${shortHead}${project.branch ? ` (${project.branch})` : ""}${project.id ? ` in ${project.id}` : ""}.`)
    if (command.dryRun) {
      for (const file of changed.slice(0, 20)) say(`  ${file}`)
      if (changed.length > 20) say(`  ... and ${changed.length - 20} more`)
      say(`Dry run: would push it to ${command.gitRemote} as ${name} (a new branch; never forced). Nothing was committed or pushed.`)
      return
    }
    const message = ["mendcode wip handoff", `base: ${project.head}`, `branch: ${project.branch ?? "(detached)"}`, ...project.id ? [`project: ${project.id}`] : [], `rel: ${project.rel || "."}`, `device: ${deps.device ?? (osHostname().split(".")[0] ?? "device")}`].join("\n")
    const identity = (await git(project.top, ["config", "user.email"])).stdout.trim() ? {} : { GIT_AUTHOR_NAME: "MendCode handoff", GIT_AUTHOR_EMAIL: "handoff@localhost", GIT_COMMITTER_NAME: "MendCode handoff", GIT_COMMITTER_EMAIL: "handoff@localhost" }
    const commit = await must(git(project.top, ["commit-tree", tree, "-p", "HEAD", "-m", message], { env: identity }), "committing the snapshot failed")
    const pushed = await git(project.top, ["push", "--no-verify", command.gitRemote, `${commit}:refs/heads/${name}`])
    if (pushed.code !== 0) throw new CodeError(`pushing ${name} to ${command.gitRemote} failed (${scrub(pushed.stderr || pushed.stdout)}). Nothing on your branch changed; try again after fixing access.`)
    say(`Pushed ${name} to ${command.gitRemote} (${commit.slice(0, 7)}). Your branch, index and files were not touched.`)
    say(`On the other machine: mendcode remote code receive ${project.rel ? path.join("<clone>", project.rel) : "<clone>"}`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Fetches the handoff branches and checks the newest into a worktree of its own. */
async function receive(command: Extract<CodeCommand, { action: "receive" }>, deps: CodeDeps, say: (line: string) => void) {
  const { git } = deps
  const project = await identify(git, command.project)
  await gitRemoteExists(git, project.top, command.gitRemote)
  const tracking = `refs/remotes/${command.gitRemote}/mend`
  if (command.dryRun) say(`Dry run: fetching mend/wip-* into ${tracking}/ (remote-tracking refs only); no worktree is added.`)
  const fetched = await git(project.top, ["fetch", "--no-tags", command.gitRemote, `+refs/heads/mend/wip-*:${tracking}/wip-*`])
  if (fetched.code !== 0) throw new CodeError(`fetching from ${command.gitRemote} failed (${scrub(fetched.stderr || fetched.stdout)})`)
  const rows = (await must(git(project.top, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(objectname)", `${tracking}/wip-*`]), "listing handoffs failed")).split("\n").filter(Boolean).map((line) => {
    const [ref = "", sha = ""] = line.split("\t")
    return { ref, sha, name: ref.slice(`refs/remotes/${command.gitRemote}/`.length) }
  })
  if (!rows.length) throw new CodeError(`${command.gitRemote} has no mend/wip-* branch: run remote code handoff on the other machine first`)
  const chosen = command.branch ? rows.find((row) => row.name === command.branch) : rows[0]
  if (!chosen) throw new CodeError(`${command.branch} is not on ${command.gitRemote}; there are ${rows.length}: ${rows.slice(0, 5).map((row) => row.name).join(", ")}`)
  if (!command.branch && rows.length > 1) say(`${rows.length - 1} older handoff${rows.length === 2 ? "" : "s"} also on ${command.gitRemote}; pass --branch to take another.`)
  const body = (await git(project.top, ["log", "-1", "--format=%B", chosen.sha])).stdout
  const base = /^base: ([0-9a-f]{40})$/m.exec(body)?.[1]
  if (base) {
    const have = (await git(project.top, ["cat-file", "-e", `${base}^{commit}`])).code === 0
    const atBase = have && (await git(project.top, ["merge-base", "--is-ancestor", base, "HEAD"])).code === 0
    say(have ? atBase ? `Your checkout contains the base commit ${base.slice(0, 7)}.` : `The base commit ${base.slice(0, 7)} is not in your current branch; the worktree still has the exact files.` : `The base commit ${base.slice(0, 7)} was fetched with the handoff.`)
  }
  const worktrees = await must(git(project.top, ["worktree", "list", "--porcelain"]), "listing worktrees failed")
  const holder = worktrees.split("\n\n").find((block) => block.includes(`branch refs/heads/${chosen.name}\n`) || block.endsWith(`branch refs/heads/${chosen.name}`))
  const existing = holder ? /^worktree (.+)$/m.exec(holder)?.[1] : undefined
  if (existing) { say(`Already received: ${existing} (branch ${chosen.name}).`); return }
  if ((await git(project.top, ["show-ref", "--verify", "-q", `refs/heads/${chosen.name}`])).code === 0) throw new CodeError(`a local branch ${chosen.name} already exists without a worktree; remove it with git branch -D, or take another handoff with --branch`)
  const target = command.into ?? path.join(command.dir, "remote-code", "worktrees", `${slug(path.basename(project.top))}-${chosen.sha.slice(0, 7)}`)
  if (existsSync(target)) throw new CodeError(`${target} already exists; pass --into another folder`)
  if (command.dryRun) { say(`Dry run: would add worktree ${target} on a new branch ${chosen.name} at ${chosen.sha.slice(0, 7)}.`); return }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  await must(git(project.top, ["worktree", "add", "-b", chosen.name, target, chosen.sha]), "creating the worktree failed")
  say(`Checked out ${chosen.name} (${chosen.sha.slice(0, 7)}) in ${target}${project.rel ? ` (project folder: ${path.join(target, project.rel)})` : ""}.`)
  say(`Your own branch and files were not touched. To bring the changes into your checkout: git -C ${project.top} cherry-pick --no-commit ${chosen.sha.slice(0, 12)}`)
}

/** Existing clones under the search roots, matched by git remote; used before anything is cloned. */
export async function scanRepos(git: GitRunner, roots: readonly string[], depth = 3): Promise<RemoteRepo[]> {
  const repos: RemoteRepo[] = []
  const visit = async (directory: string, level: number) => {
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    if (entries.some((entry) => entry.name === ".git")) {
      const url = (await git(directory, ["remote", "get-url", "origin"])).stdout.trim()
      repos.push({ top: directory, ...(url ? { url } : {}) })
      return
    }
    if (level >= depth) return
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") await visit(path.join(directory, entry.name), level + 1)
  }
  for (const root of roots) await visit(root, 0)
  return repos
}

async function clone(command: Extract<CodeCommand, { action: "clone" }>, deps: CodeDeps, say: (line: string) => void) {
  const id = normalizeGitRemote(command.source)!
  const roots = command.searchRoots.length ? command.searchRoots : [...new Set([command.root, ...DEFAULT_SEARCH_ROOTS.map((name) => path.join(homedir(), name))])]
  const repos = await scanRepos(deps.git, roots)
  const mapping = mapProject({ project: { id, url: command.source, rel: "", directory: "" }, rules: command.pathMaps, repos, cloneMissing: true, cloneRoot: command.root })
  if (mapping.directory !== undefined && mapping.how === "git") { say(`Already here: ${mapping.directory} (${id}).`); return }
  if (mapping.directory !== undefined) { say(`Maps to ${mapping.directory} by a path rule; clone it there yourself if it is missing.`); return }
  if (!mapping.clone) throw new CodeError(mapping.reason)
  const target = path.join(command.root, mapping.clone.name)
  if (existsSync(target)) throw new CodeError(`${target} exists but is not a clone of ${id}`)
  if (command.dryRun) { say(`Dry run: would clone ${command.source} into ${target}.`); return }
  mkdirSync(command.root, { recursive: true })
  const done = await deps.git(command.root, ["clone", "--", command.source, target])
  if (done.code !== 0) throw new CodeError(`git clone failed (${scrub(done.stderr)}); sign in to git on this machine or clone it yourself`)
  say(`Cloned ${id} into ${target}.`)
}

/* ---------- live sync (Mutagen) ---------- */

type LiveEntry = { name: string; project: string; id?: string; local: string; ssh: string; remote: string; createdAt: number }
type LiveLedger = { version: 1; sessions: Record<string, LiveEntry> }
/** A ledger of this tool's own Mutagen sessions, not a user-facing config file: <data dir>/remote-code/live-syncs.json. */
export const liveFile = (dir: string) => path.join(dir, "remote-code", `${"live-syncs"}.json`)

export function readLive(dir: string): LiveLedger {
  try {
    const value = JSON.parse(readFileSync(liveFile(dir), "utf8")) as LiveLedger
    if (value?.version === 1 && value.sessions && typeof value.sessions === "object") return value
  } catch {}
  return { version: 1, sessions: {} }
}

function writeLive(dir: string, ledger: LiveLedger) {
  const file = liveFile(dir)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

async function detectMutagen(mutagen: MutagenRunner) {
  const result = await mutagen(["version"])
  if (result.code !== 0) throw new CodeError("Mutagen is not installed (or not on PATH). Live sync wraps an existing install: brew install mutagen-io/mutagen/mutagen, or see https://mutagen.io. The git handoff needs nothing extra.")
  return result.stdout.trim().split("\n")[0] ?? ""
}

/** The state of the clone on the host: head, branch and git remote, over SSH. */
async function hostClone(ssh: SshRunner, remote: string) {
  const out = await ssh({ script: `set -eu; cd ${shq(remote)} && printf 'head=%s\\n' "$(git rev-parse HEAD)" && printf 'branch=%s\\n' "$(git symbolic-ref --short -q HEAD || echo '(detached)')" && printf 'url=%s\\n' "$(git remote get-url origin 2>/dev/null || true)"` })
  if (out.code !== 0) throw new CodeError(`cannot read the clone at ${remote} on the host (${scrub(out.stderr || out.stdout)})`)
  const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(out.stdout)?.[1]?.trim() ?? ""
  return { head: field("head"), branch: field("branch"), url: field("url") }
}

async function findHostPath(command: Extract<CodeCommand, { action: "live"; sub: "enable" }>, project: Project, ssh: SshRunner) {
  if (command.remotePath) return command.remotePath
  const ruled = applyPathRule(project.top, command.pathMaps)
  if (ruled) return ruled
  if (!project.id) throw new CodeError("this project has no git remote to match on the host: pass --remote-path or --path-map")
  const roots = [...new Set([...DEFAULT_SEARCH_ROOTS.map((name) => `"$HOME/${name}"`), ...command.searchRoots.map((root) => shq(root))])]
  const scan = await ssh({ script: `for r in ${roots.join(" ")}; do [ -d "$r" ] && find "$r" -maxdepth 4 -name .git -type d -prune 2>/dev/null; done | while IFS= read -r g; do t=$(dirname "$g"); u=$(git -C "$t" remote get-url origin 2>/dev/null || true); printf '%s\\t%s\\n' "$t" "$u"; done` })
  const repos: RemoteRepo[] = scan.stdout.split("\n").filter(Boolean).map((line) => { const [top = "", url = ""] = line.split("\t"); return { top, ...(url ? { url } : {}) } })
  const mapped = mapProject({ project: { id: project.id, rel: "", directory: project.top }, rules: [], repos, cloneMissing: false, cloneRoot: "" })
  if (mapped.directory === undefined) throw new CodeError(`${project.id} is not cloned on the host (${mapped.reason}). Clone it there, or run: mendcode remote code clone on the host, then try again`)
  return mapped.directory
}

const sessionName = (project: Project) => `mc-${slug(project.id?.split("/").at(-1) ?? path.basename(project.top))}-${createHash("sha256").update(project.top).digest("hex").slice(0, 6)}`

export function liveCreateArgs(input: { name: string; local: string; ssh: string; remote: string; ignores: readonly string[]; includeEnv: boolean }) {
  const ignores = [...new Set([...LIVE_IGNORES, ...input.includeEnv ? [] : ENV_IGNORES, ...input.ignores])]
  return ["sync", "create", "--name", input.name, "--sync-mode", "two-way-safe", "--ignore-vcs", ...ignores.flatMap((pattern) => ["--ignore", pattern]), "--label", "mendcode=code-sync", input.local, `${input.ssh}:${input.remote}`]
}

async function liveEnable(command: Extract<CodeCommand, { action: "live"; sub: "enable" }>, deps: CodeDeps, say: (line: string) => void) {
  const version = await detectMutagen(deps.mutagen)
  say(`Mutagen ${version} found.`)
  const project = await identify(deps.git, command.project)
  if (project.rel) say(`Syncing the whole repository at ${project.top}, not only ${project.rel}.`)
  if (!project.head || !project.branch) throw new CodeError("live sync needs a checked-out branch with at least one commit on this machine")
  const name = command.name ?? sessionName(project)
  const ledger = readLive(command.dir)
  if (ledger.sessions[name]) { say(`Live sync ${name} is already enabled for ${project.top}. See: remote code live status`); return }
  const ssh = deps.ssh(command.ssh)
  const remote = await findHostPath(command, project, ssh)
  const guarded = await hostClone(ssh, remote)
  if (project.id && guarded.url && normalizeGitRemote(guarded.url) !== project.id) throw new CodeError(`the clone at ${remote} on the host is ${normalizeGitRemote(guarded.url) ?? "another repository"}, not ${project.id}; refusing to sync them`)
  if (guarded.branch !== project.branch) throw new CodeError(`the clones are on different branches (here ${project.branch}, host ${guarded.branch}); check out the same branch on both first`)
  if (guarded.head !== project.head) throw new CodeError(`the clones are at different commits (here ${project.head.slice(0, 7)}, host ${guarded.head.slice(0, 7)}); pull or push so both are at the same commit first`)
  const args = liveCreateArgs({ name, local: project.top, ssh: command.ssh, remote, ignores: command.ignores, includeEnv: command.includeEnv })
  if (command.dryRun) { say(`Dry run: both clones are on ${project.branch} at ${project.head.slice(0, 7)}. Would run: mutagen ${args.join(" ")}`); return }
  const existing = await deps.mutagen(["sync", "list", name])
  if (existing.code === 0 && /^Name: /m.test(existing.stdout)) throw new CodeError(`a Mutagen session named ${name} already exists that this tool did not create; pass --name to use another name`)
  const created = await deps.mutagen(args)
  if (created.code !== 0) throw new CodeError(`mutagen could not create the session (${scrub(created.stderr || created.stdout)})`)
  ledger.sessions[name] = { name, project: project.id ?? project.top, ...(project.id ? { id: project.id } : {}), local: project.top, ssh: command.ssh, remote, createdAt: (deps.now ?? Date.now)() }
  writeLive(command.dir, ledger)
  say(`Live sync ${name} is on: ${project.top} <-> ${command.ssh}:${remote} (two-way-safe; conflicts are kept, never overwritten).`)
  say(`Ignored: ${[...LIVE_IGNORES, ...command.includeEnv ? [] : ENV_IGNORES, ...command.ignores].join(", ")} and the .git folder. Each side keeps its own commits.`)
  say("It pauses when either clone is on another branch: run `remote code live status` to check, `live resume` after.")
}

/** Mutagen's `sync list` text, one entry per session. */
export function parseMutagenList(text: string): Map<string, { status: string; conflicts: boolean; error?: string }> {
  const result = new Map<string, { status: string; conflicts: boolean; error?: string }>()
  for (const block of text.split(/^-{5,}\s*$/m)) {
    const name = /^Name: (.+)$/m.exec(block)?.[1]?.trim()
    if (!name) continue
    const error = /^Last error: (.+)$/m.exec(block)?.[1]?.trim()
    result.set(name, { status: /^Status: (.+)$/m.exec(block)?.[1]?.trim() ?? "unknown", conflicts: /^\s*Conflicts:/m.test(block), ...(error ? { error } : {}) })
  }
  return result
}

function pickEntries(ledger: LiveLedger, project: string | undefined, name: string | undefined, top: string | undefined): LiveEntry[] {
  const all = Object.values(ledger.sessions)
  if (name) return all.filter((entry) => entry.name === name)
  return top ? all.filter((entry) => entry.local === top) : all
}

async function liveManage(command: Extract<CodeCommand, { action: "live" }>, deps: CodeDeps, say: (line: string) => void) {
  const ledger = readLive(command.dir)
  if (command.sub === "list") {
    const entries = Object.values(ledger.sessions)
    if (!entries.length) { say("No live code syncs. Enable one with: remote code live enable PROJECT --ssh USER@HOST"); return }
    const known = (await deps.mutagen(["sync", "list"])).code === 0
    const listed = known ? parseMutagenList((await deps.mutagen(["sync", "list"])).stdout) : new Map()
    for (const entry of entries) {
      const state = listed.get(entry.name)
      say(`${entry.name}  ${entry.local} <-> ${entry.ssh}:${entry.remote}  ${known ? state ? `${state.status}${state.conflicts ? ", conflicts" : ""}` : "not running in Mutagen" : "Mutagen unavailable"}`)
    }
    return
  }
  const top = (await deps.git(command.project, ["rev-parse", "--show-toplevel"])).stdout.trim() || command.project
  const entries = pickEntries(ledger, undefined, command.name, command.name ? undefined : top)
  if (!entries.length) throw new CodeError(command.name ? `no live sync named ${command.name} was enabled by this tool` : `no live sync enabled for ${top}`)
  await detectMutagen(deps.mutagen)
  for (const entry of entries) {
    if (command.sub === "disable") {
      if (command.dryRun) { say(`Dry run: would run mutagen sync terminate ${entry.name}.`); continue }
      const done = await deps.mutagen(["sync", "terminate", entry.name])
      const gone = done.code === 0 || /unable to locate|no matching|not found/i.test(done.stderr + done.stdout)
      if (!gone) throw new CodeError(`mutagen could not terminate ${entry.name} (${scrub(done.stderr || done.stdout)})`)
      delete ledger.sessions[entry.name]
      writeLive(command.dir, ledger)
      say(`Live sync ${entry.name} ended. Files on both sides stay as they are.`)
      continue
    }
    const here = await identify(deps.git, entry.local)
    let guard: Awaited<ReturnType<typeof hostClone>> | undefined
    try { guard = await hostClone(deps.ssh(entry.ssh), entry.remote) } catch (error) { say(`${entry.name}: ${error instanceof Error ? error.message : "host check failed"}`) }
    const mismatch = guard !== undefined && guard.branch !== here.branch
    if (command.sub === "resume") {
      if (!guard) throw new CodeError(`${entry.name} stays paused: the host could not be checked`)
      if (mismatch) throw new CodeError(`${entry.name} stays paused: branches differ (here ${here.branch}, host ${guard.branch})`)
      if (!command.dryRun) await must(deps.mutagen(["sync", "resume", entry.name]), "mutagen could not resume the session")
      say(`${entry.name} resumed.`)
      continue
    }
    if (mismatch && !command.dryRun) {
      await must(deps.mutagen(["sync", "pause", entry.name]), "mutagen could not pause the session")
      say(`${entry.name}: PAUSED, the clones are on different branches (here ${here.branch}, host ${guard!.branch}). Check out the same branch on both, then: remote code live resume`)
    }
    const state = parseMutagenList((await deps.mutagen(["sync", "list", entry.name])).stdout).get(entry.name)
    say(`${entry.name}  ${entry.local} <-> ${entry.ssh}:${entry.remote}`)
    say(`  state: ${state ? `${state.status}${state.conflicts ? "; conflicts (mutagen sync list " + entry.name + ")" : ""}${state.error ? `; last error: ${scrub(state.error)}` : ""}` : "not found in Mutagen (disable it and enable again)"}`)
    if (guard) say(`  branch: ${here.branch ?? "?"} here, ${guard.branch || "?"} on the host${guard.head && here.head && guard.head !== here.head ? `; commits differ (${here.head.slice(0, 7)} here, ${guard.head.slice(0, 7)} on the host): fetch on the side that is behind` : ""}`)
  }
}

export async function runCode(command: CodeCommand, deps: CodeDeps): Promise<number> {
  const say = (line: string) => deps.out.write(`${line}\n`)
  try {
    if (command.action === "handoff") await handoff(command, deps, say)
    else if (command.action === "receive") await receive(command, deps, say)
    else if (command.action === "clone") await clone(command, deps, say)
    else if (command.sub === "enable") await liveEnable(command, deps, say)
    else await liveManage(command, deps, say)
    return 0
  } catch (error) {
    if (error instanceof CodeError) { say(`error: ${error.message}`); return 1 }
    throw error
  }
}

export async function runCodeCommand(command: CodeCommand, out: { write(text: string): unknown }): Promise<number> {
  return runCode(command, { git: runGit, mutagen: runMutagen, ssh: sshRunner, out })
}
