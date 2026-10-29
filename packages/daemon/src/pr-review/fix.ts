import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import type { FixResult } from "./commands"
import { gitRun, type GitRun } from "./context"
import type { ReviewSessionFactory } from "./engine"
import type { CheckResult } from "./verify"

/**
 * `@mendcode fix` (docs/pr-review.md): a separate session edits a throwaway worktree at the PR head under the user's normal
 * permissions, the base config's checks run on the result, and one commit is pushed to the PR's branch only when they pass. A
 * failed check, a session that changed nothing, or a branch that moved meanwhile pushes nothing and says why. Never a force push.
 */

const CHECK_TAIL = 2_000

export type FixInput = {
  /** A checkout of the repository: the worktree is added to it, and it fetched `head`. */
  directory: string
  /** `<dataDir>/pr-review`, where the throwaway worktree lives. */
  root: string
  number: number
  head: string
  /** The PR's branch name in `pushUrl`. */
  branch: string
  /** Where the branch lives: `origin`, or the fork's URL. */
  pushUrl: string
  instructions: string
  finding?: PrFinding | undefined
  checks: readonly string[]
  runChecks(directory: string, commands: readonly string[]): Promise<CheckResult[]>
  /** The fix session, in the throwaway worktree it is given (never the user's checkout). */
  sessions(worktree: string): ReviewSessionFactory
  git?: GitRun
}

export function fixPrompt({ instructions, finding }: { instructions: string; finding?: PrFinding | undefined }) {
  return [
    "A maintainer asked for a fix on this pull request (`@mendcode fix`). Make the smallest change that does what they asked, in this checkout, and nothing else.",
    "Do not commit, push, switch branches or run git commands that change history: MendCode commits and pushes your change after the repository's checks pass.",
    finding ? `The finding it is about: ${finding.path}:${finding.line} (${finding.severity} ${finding.category}) ${finding.summary}\n${finding.detail}` : "",
    `The request:\n${instructions.slice(0, 2_000)}`,
    "When you are done, answer with one sentence that says what you changed.",
  ].filter(Boolean).join("\n\n")
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim().slice(0, 60) ?? "requested change"

export async function runFix(input: FixInput): Promise<FixResult> {
  const git = input.git ?? gitRun
  mkdirSync(path.join(input.root, "worktrees"), { recursive: true, mode: 0o700 })
  const worktree = mkdtempSync(path.join(input.root, "worktrees", `fix${input.number}-`))
  rmSync(worktree, { recursive: true, force: true })
  const added = await git(["worktree", "add", "--detach", "--quiet", worktree, input.head], input.directory)
  if (added.code !== 0) return { ok: false, reason: `could not check out ${input.head.slice(0, 12)}` }
  try {
    const session = await input.sessions(worktree)({ purpose: "review" })
    let said = ""
    try { said = (await session.send(fixPrompt(input))).text.trim() } finally { await session.close() }
    const status = await git(["status", "--porcelain"], worktree)
    if (status.code !== 0) return { ok: false, reason: "git could not read the fix's changes" }
    if (!status.out.trim()) return { ok: false, reason: `the fix session changed nothing${said ? `: ${said.slice(0, 500)}` : ""}` }
    if (input.checks.length) {
      const results = await input.runChecks(worktree, input.checks)
      const failed = results.find((result) => result.code !== 0)
      if (failed) return { ok: false, reason: `\`${failed.command}\` ${failed.code === -1 ? "could not run" : `exited with ${failed.code}`}, so the fix was not pushed:\n\n\`\`\`text\n${failed.output.slice(-CHECK_TAIL).replace(/```/g, "'''")}\n\`\`\`` }
    }
    if ((await git(["add", "-A"], worktree)).code !== 0) return { ok: false, reason: "git could not stage the fix" }
    const committed = await git(["commit", "--quiet", "--no-verify", "-m", `fix: ${firstLine(input.instructions)}`, "-m", `Requested with @mendcode fix on #${input.number}.`], worktree)
    if (committed.code !== 0) return { ok: false, reason: "git could not commit the fix (is user.name and user.email set?)" }
    const commit = (await git(["rev-parse", "HEAD"], worktree)).out.trim()
    // A plain push: if someone pushed meanwhile it is refused, and nothing is overwritten.
    const pushed = await git(["push", "--quiet", input.pushUrl, `HEAD:refs/heads/${input.branch}`], worktree)
    if (pushed.code !== 0) return { ok: false, reason: `git push was refused (the branch may have moved since ${input.head.slice(0, 12)}); nothing was pushed` }
    return { ok: true, commit }
  } finally {
    await git(["worktree", "remove", "--force", worktree], input.directory)
    rmSync(worktree, { recursive: true, force: true })
    await git(["worktree", "prune"], input.directory)
  }
}
