/**
 * The Git page's local `git init` (`git.init`, docs/git.md): data and types only, so the thin terminal client and the daemon share them.
 * The command is local only and never leaves the machine: it makes a repository in the session's project folder and nothing else.
 */

/** What `git.init` will run, exactly. `argv` is the command (cwd `directory`); `branch` is the first branch and `branchFrom` says whose choice it is. */
export type GitInitPlan = {
  directory: string
  argv: string[]
  branch: string
  /** `config` when the user's own `init.defaultBranch` names it, `default` when the page asks for `main`. */
  branchFrom: "config" | "default"
}

/** Ack of `git.init`: the plan, and for a real run the repository's root. A refusal is an error reply with one line (a failed `git init` adds git's output below it). */
export type GitInitReport = { plan: GitInitPlan; initialized: boolean; root?: string }
