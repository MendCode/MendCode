/**
 * The Git page's actions that leave the machine (`git.push`, `git.pr.create`) and its read of the branch's pull request (`git.pr.view`,
 * docs/git.md): data and types only, so the thin terminal client and the daemon share them. All three are local only and run only while
 * `experimental.git_actions` is on.
 */

/** Commits a card names by subject; the rest are only counted. */
export const GIT_ACTIONS_MAX_LISTED = 8
/** Longest pull request title and body the command takes, in characters. */
export const GIT_PR_MAX_TITLE = 256
export const GIT_PR_MAX_BODY = 16_000
export const GIT_PR_MAX_BASE = 200

/** The start of the refusal every action gives while the repository has no remote: the PR tab recognizes it and offers to publish. */
export const GIT_NO_REMOTE = "this repository has no remote"

/** What the publish form takes. The visibility is not a field: a published repository is private, always. */
export const GIT_PUBLISH_MAX_NAME = 100
export const GIT_PUBLISH_MAX_OWNER = 60
export const GIT_PUBLISH_MAX_DESCRIPTION = 350
const PUBLISH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const PUBLISH_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

/** Why a repository name cannot be used, or undefined: letters, digits, `.`, `_` and `-`, up to 100, not starting with `.` or `-`. */
export function publishNameProblem(name: string): string | undefined {
  if (name === "") return "the repository name is empty"
  if (name.length > GIT_PUBLISH_MAX_NAME) return `the repository name is too long (${GIT_PUBLISH_MAX_NAME} characters at most)`
  if (name.startsWith(".") || name.startsWith("-")) return "the repository name cannot start with . or -"
  if (!PUBLISH_NAME.test(name)) return "the repository name takes letters, digits, . _ and - only"
  if (name.toLowerCase().endsWith(".git")) return "the repository name cannot end in .git"
  return undefined
}

/** Why an owner (a user or an organization on GitHub) cannot be used, or undefined. */
export function publishOwnerProblem(owner: string): string | undefined {
  if (owner === "") return "the owner is empty"
  if (!PUBLISH_OWNER.test(owner)) return "the owner takes letters, digits, _ and - only, and cannot start with -"
  return undefined
}

export type GitCommitLine = { sha: string; subject: string }

/**
 * What `git.publish` will run, exactly. `argv` is the `gh repo create` command (cwd `root`): `--private` is always in it and `--push`, `--public` and
 * `--internal` never are; the push is the separate `git.push`. `defaults` are what the form was prefilled with. `head` says what the repository
 * stands on: a branch, a detached HEAD (allowed, publishing only adds a remote) or no commit yet (allowed; the first commit comes before the push).
 */
export type GitPublishPlan = {
  root: string
  /** `owner/name`, as GitHub will have it. */
  repo: string
  owner: string
  name: string
  description: string
  visibility: "private"
  remote: "origin"
  argv: string[]
  defaults: { name: string; owner: string }
  head: "branch" | "detached" | "unborn"
  branch?: string
  commits: number
}

/** Ack of `git.publish`: the plan, and for a real run the new repository's link and the address `origin` now has (credentials masked). A refusal or a partial failure is an error reply: one line, then what exists now and what to run. */
export type GitPublishReport = { plan: GitPublishPlan; published: boolean; url?: string; origin?: string }

/**
 * What `git.push` will run, exactly. `argv` is the push command (cwd `root`); `url` is the remote's push URL with any credentials masked.
 * `commits` are the commits the remote does not have as far as this machine knows (nothing is fetched). `protected` means the page asks for the
 * branch name to be typed (`confirm`). `hooks` are the repository hooks that run (`pre-push`).
 */
export type GitPushPlan = {
  root: string
  branch: string
  remote: string
  url: string
  argv: string[]
  setUpstream: boolean
  /** `origin/feat`, when the branch already has an upstream. */
  upstream?: string
  commits: GitCommitLine[]
  commitsTotal: number
  /** Commits the remote has that this branch does not, as far as this machine knows; the push is then rejected, and never forced. */
  behind: number
  protected: boolean
  hooks: string[]
}

/** Ack of `git.push`: the plan, and for a real run the redacted tail of git's output. A refusal or a failed push is an error reply with one line (a failed push adds that output below it). */
export type GitPushReport = { plan: GitPushPlan; pushed: boolean; output?: string }

export type GitPrChecks = { pass: number; fail: number; pending: number; skip: number }

/** The branch's pull request as `gh pr view` reports it. */
export type GitPrInfo = {
  number: number
  title: string
  url: string
  state: "open" | "merged" | "closed"
  draft: boolean
  base: string
  head: string
  checks: GitPrChecks
  /** Names of the failing checks (the first few). */
  failing: string[]
  /** Names of the checks still running (the first few). */
  pending: string[]
  review?: string
  mergeable: "mergeable" | "conflicting" | "unknown"
}

/** Ack of `git.pr.view`: the branch and its pull request, or none. Everything else (no gh, not logged in, no remote) is an error reply with one line. */
export type GitPrView = { branch: string; pr?: GitPrInfo }

/**
 * What `git.pr.create` will run. `argv` is the `gh pr create` command; the body goes through its standard input, never the command line.
 * `defaults` are the prefill from the commits since the merge-base with the base branch. `pushed` is true when every commit of the branch is on
 * its upstream; when it is not, `pushNote` says what to push first (the page offers the push as a step of its own).
 */
export type GitPrPlan = {
  root: string
  branch: string
  remote: string
  url: string
  base: string
  argv: string[]
  title: string
  body: string
  draft: boolean
  defaults: { title: string; body: string }
  commits: GitCommitLine[]
  commitsTotal: number
  pushed: boolean
  pushNote?: string
}

/** Ack of `git.pr.create`: the plan, and for a real run the new pull request's link and whether it was saved on the session. */
export type GitPrCreateReport = { plan: GitPrPlan; created: boolean; url?: string; number?: number }
