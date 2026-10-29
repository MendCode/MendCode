/**
 * The Git page's local commit (`git.commit`, docs/git.md): data and types only, so the thin terminal client and the daemon share
 * them. The command is local only: it commits the files the user ticked and nothing else, and never pushes.
 */

/** Longest commit message the command takes, in characters. */
export const GIT_COMMIT_MAX_MESSAGE = 8000
/** Most paths one commit takes. */
export const GIT_COMMIT_MAX_PATHS = 300
/** Staged paths outside the selection a plan lists by name; the rest are only counted. */
export const GIT_COMMIT_MAX_LISTED = 20

/**
 * What `git.commit` will run, exactly. `argv` is the commit command (cwd `root`, literal pathspecs); `add` is the `git add` that comes
 * first when some selected paths are untracked, or absent. `stagedElsewhere` are paths staged in the index that are not in the
 * selection: they are not part of this commit and stay staged afterwards.
 */
export type GitCommitPlan = {
  root: string
  branch: string
  argv: string[]
  add?: string[]
  paths: string[]
  untracked: string[]
  stagedElsewhere: string[]
  stagedElsewhereTotal: number
  /** Names of the hooks that will run (`pre-commit`, `commit-msg`...); empty when the repository has none. */
  hooks: string[]
}

/** Ack of `git.commit`: the plan, and for a real run the new commit. A refusal is an error reply with one line (a failed commit adds the redacted git output below it). */
export type GitCommitReport = { plan: GitCommitPlan; committed: boolean; sha?: string; subject?: string }
