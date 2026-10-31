import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import type { FixResult } from "./commands"
import { gitRun, type GitRun } from "./context"
import type { ReviewSessionFactory } from "./engine"
import type { CheckResult } from "./verify"

/**
 * `@mendcode fix` and the automatic fix modes (docs/pr-review.md): a separate session edits a throwaway worktree at the PR head
 * under the user's normal permissions, the base config's checks run on the result, and one commit is made. It is pushed to the PR's
 * branch only when everything still holds right before the push: `fix.push` is on, the user has not taken the job over, the PR is
 * still open and the reviewer may still push to it (`mayPush`, a fresh permission check), the branch tip is still the head the fix
 * started from, and the base did not move when the caller says it matters. A commit that is not pushed, for any of those reasons or
 * because the push was refused, is kept on `refs/mendcode/fix/<number>/<time>` in the user's repository (the worktree shares its
 * object store), so no work is lost. Never a force push, never a merge.
 */

const CHECK_TAIL = 2_000
/** A commit subject's length limit (git's convention): longer subjects are cut at a word boundary. */
export const SUBJECT_MAX = 72

/**
 * Who asked for a fix: the repository's automatic fix mode after a review (`fix.mode`), or a maintainer's `@mendcode fix` comment
 * (`url`: the comment, when the forge has one). The commit message and the fix session's prompt say which.
 */
export type FixSource = { kind: "mode"; mode: "fix-once" | "fix-loop" } | { kind: "comment"; actor: string; url?: string | undefined }

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
  /** Several findings at once (a fix round of the fix loop); `finding` is the single one `@mendcode fix` replied to. */
  findings?: readonly PrFinding[] | undefined
  /** Who asked for the fix; unset reads as an `@mendcode fix` comment of unknown author. */
  source?: FixSource | undefined
  checks: readonly string[]
  runChecks(directory: string, commands: readonly string[]): Promise<CheckResult[]>
  /** The fix session, in the throwaway worktree it is given (never the user's checkout). */
  sessions(worktree: string): ReviewSessionFactory
  /** The config's `fix.push` (and `fix.personal` for a personal reviewer). Unset: push, as `fixes: true` always did. */
  push?: boolean | undefined
  /** The PR is still open; read fresh right before the push. */
  stillOpen?: (() => Promise<boolean>) | undefined
  /** The reviewer may still push to the branch: a fresh permission check, not one cached from the command. A string is the reason it may not. */
  mayPush?: (() => Promise<true | string>) | undefined
  /** Who holds the job: while it is `user` (a take-over) the fix neither starts nor pushes. */
  controlOf?: (() => "reviewer" | "user") | undefined
  /** The base the fix was validated on, when a moved base must stop the push (read with `git ls-remote` on `remote`, default `origin`). */
  base?: { branch: string; sha: string; remote?: string | undefined } | undefined
  /** The fix session's id, once it exists, so the job records `fixSessionId` before the turn ends. */
  onSession?: ((id: string) => void) | undefined
  now?: () => number
  git?: GitRun
}

export function fixPrompt({ instructions, finding, findings, source }: { instructions: string; finding?: PrFinding | undefined; findings?: readonly PrFinding[] | undefined; source?: FixSource | undefined }) {
  const about = (one: PrFinding) => `${one.path}:${one.line} (${one.severity} ${one.category}) ${one.summary}\n${one.detail}`
  return [
    source?.kind === "mode"
      ? `MendCode's review of this pull request confirmed the findings below, and the repository's automatic fix mode (\`fix.mode: ${source.mode}\`) fixes them; nobody asked in a comment. Make the smallest change that fixes them, in this checkout, and nothing else.`
      : "A maintainer asked for a fix on this pull request (`@mendcode fix`). Make the smallest change that does what they asked, in this checkout, and nothing else.",
    "Do not commit, push, switch branches or run git commands that change history: MendCode commits and pushes your change after the repository's checks pass.",
    finding ? `The finding it is about: ${about(finding)}` : "",
    findings?.length ? `The confirmed findings to fix:\n\n${findings.slice(0, 30).map((one, index) => `${index + 1}. ${about(one)}`).join("\n\n")}` : "",
    `The request:\n${instructions.slice(0, 2_000)}`,
    "When you are done, answer with one sentence that says what you changed.",
  ].filter(Boolean).join("\n\n")
}

/**
 * `prefix` and the first line of `text` as a commit subject of at most `max` characters, cut at a word boundary (a single word
 * longer than the room is cut where the room ends), without a trailing period or separator.
 */
export function subjectLine(prefix: string, text: string, max = SUBJECT_MAX) {
  const line = text.split("\n").find((entry) => entry.trim())?.replace(/\s+/g, " ").trim() ?? ""
  const room = Math.max(1, max - prefix.length)
  const tidy = (value: string) => value.replace(/[\s.,;:!-]+$/, "")
  if (!tidy(line)) return `${prefix}requested change`
  if (line.length <= room) return `${prefix}${tidy(line)}`
  const cut = line.slice(0, room + 1)
  const space = cut.lastIndexOf(" ")
  return `${prefix}${tidy(space > 0 ? cut.slice(0, space) : line.slice(0, room)) || line.slice(0, room)}`
}

/**
 * The fix commit's message: a subject of at most `SUBJECT_MAX` characters cut at a word, and a body that says who asked: the
 * repository's automatic fix mode (with the findings it fixes) or the commenter's `@mendcode fix`, linked when the forge has a link.
 */
export function fixCommitMessage({ instructions, number, findings, source }: { instructions: string; number: number; findings?: readonly PrFinding[] | undefined; source?: FixSource | undefined }) {
  if (source?.kind === "mode") {
    const list = findings ?? []
    const subject = list.length === 1 ? subjectLine("fix: ", list[0]!.summary) : subjectLine("fix: ", `address ${list.length} confirmed findings of MendCode's review`)
    const listed = list.slice(0, 10).map((one) => `- ${one.path}:${one.line} ${one.summary.replace(/\s+/g, " ").slice(0, 200)}`)
    const more = list.length > 10 ? [`- and ${list.length - 10} more`] : []
    return { subject, body: [`Automatic fix by MendCode's fix mode (fix.mode: ${source.mode}) for the confirmed findings of its review of #${number}; nobody asked for it in a comment.`, ...(listed.length ? ["", ...listed, ...more] : [])].join("\n") }
  }
  const who = source?.kind === "comment" ? ` by @${source.actor.replace(/^@/, "")}` : ""
  const link = source?.kind === "comment" && source.url ? `: ${source.url}` : "."
  return { subject: subjectLine("fix: ", instructions), body: `Requested${who} with @mendcode fix on #${number}${link}` }
}

/** The tip of `refs/heads/<branch>` at `remote`, or undefined when the remote cannot say (no access, no such branch). */
export async function remoteTip({ git, directory, remote, branch }: { git: GitRun; directory: string; remote: string; branch: string }) {
  const listed = await git(["ls-remote", "--quiet", remote, `refs/heads/${branch}`], directory)
  return listed.code === 0 ? /^([0-9a-f]{40})\s/.exec(listed.out)?.[1] : undefined
}

/** Why the commit must not be pushed now, or undefined when every precondition still holds. `stale`: the branch or base moved. */
type PushInput = Pick<FixInput, "directory" | "number" | "head" | "branch" | "pushUrl" | "push" | "stillOpen" | "mayPush" | "controlOf" | "base" | "git">
async function pushBlocked(input: PushInput, git: GitRun): Promise<{ reason: string; stale?: true } | undefined> {
  if (input.controlOf?.() === "user") return { reason: "the job was taken over by the user, so nothing is pushed automatically" }
  if (input.stillOpen && !await input.stillOpen()) return { reason: "the pull request is no longer open" }
  const may = input.mayPush ? await input.mayPush() : true
  if (may !== true) return { reason: may }
  const tip = await remoteTip({ git, directory: input.directory, remote: input.pushUrl, branch: input.branch })
  if (!tip) return { reason: `the tip of \`${input.branch}\` could not be read before the push` }
  if (tip !== input.head) return { reason: `the branch moved from ${input.head.slice(0, 12)} to ${tip.slice(0, 12)} while the fix ran`, stale: true }
  if (input.base) {
    const base = await remoteTip({ git, directory: input.directory, remote: input.base.remote ?? "origin", branch: input.base.branch })
    if (!base) return { reason: `the tip of the base \`${input.base.branch}\` could not be read before the push` }
    if (base !== input.base.sha) return { reason: `the base \`${input.base.branch}\` moved from ${input.base.sha.slice(0, 12)} to ${base.slice(0, 12)} while the fix ran`, stale: true }
  }
  return undefined
}

/** Keeps `commit` on a fresh `refs/mendcode/fix/<number>/<time>` of the user's repository; undefined when git refused. */
async function keep({ git, directory, number, commit, now }: { git: GitRun; directory: string; number: number; commit: string; now: () => number }) {
  const at = now()
  for (const ref of [`refs/mendcode/fix/${number}/${at}`, `refs/mendcode/fix/${number}/${at}-${commit.slice(0, 12)}`]) {
    // The zero old value creates the ref only if it does not exist, so an earlier kept fix is never overwritten.
    if ((await git(["update-ref", ref, commit, "0".repeat(40)], directory)).code === 0) return ref
  }
  return undefined
}

/**
 * A committed fix (`commit`, kept on `kept`) is pushed when every precondition still holds (`pushBlocked`), else it stays on its
 * ref with the reason. A plain push of the commit from the user's repository (the worktree shares its objects): if someone pushed
 * meanwhile it is refused, and nothing is overwritten. Once on the branch the local ref is dropped.
 */
async function pushOrKeep({ input, git, commit, kept }: { input: PushInput; git: GitRun; commit: string; kept: string }): Promise<FixResult> {
  if (input.push === false) return { ok: true, commit, pushed: false, kept }
  const blocked = await pushBlocked(input, git)
  if (blocked) return { ok: false, commit, kept, reason: blocked.reason, ...(blocked.stale ? { stale: true } : {}) }
  const pushed = await git(["push", "--quiet", input.pushUrl, `${commit}:refs/heads/${input.branch}`], input.directory)
  if (pushed.code !== 0) {
    const tip = await remoteTip({ git, directory: input.directory, remote: input.pushUrl, branch: input.branch })
    const moved = tip !== undefined && tip !== input.head
    return { ok: false, commit, kept, reason: moved ? `git push was refused: the branch moved to ${tip.slice(0, 12)} since ${input.head.slice(0, 12)}` : "git push was refused", ...(moved ? { stale: true } : {}) }
  }
  // On the branch now: the local ref is no longer the only copy.
  await git(["update-ref", "-d", kept, commit], input.directory)
  return { ok: true, commit, pushed: true }
}

/**
 * The fix of a round the user interrupted by taking the job over before its push (docs/pr-review.md, fix modes): after the release
 * it is pushed as it was kept, with the same revalidation as a new fix, instead of asking for a second fix. Undefined when it no
 * longer applies, so the round is redone: its ref is gone or moved, or the branch is no longer at the head the fix was made on.
 */
export async function pushKept(input: PushInput & { commit: string; kept: string }): Promise<FixResult | undefined> {
  const git = input.git ?? gitRun
  const held = await git(["rev-parse", "--verify", "--quiet", `${input.kept}^{commit}`], input.directory)
  if (held.code !== 0 || held.out.trim() !== input.commit) return undefined
  const parent = await git(["rev-parse", "--verify", "--quiet", `${input.commit}^`], input.directory)
  if (parent.code !== 0 || parent.out.trim() !== input.head) return undefined
  return pushOrKeep({ input, git, commit: input.commit, kept: input.kept })
}

export async function runFix(input: FixInput): Promise<FixResult> {
  const git = input.git ?? gitRun
  const now = input.now ?? Date.now
  if (input.controlOf?.() === "user") return { ok: false, reason: "the job was taken over by the user, so no automatic fix runs" }
  mkdirSync(path.join(input.root, "worktrees"), { recursive: true, mode: 0o700 })
  const worktree = mkdtempSync(path.join(input.root, "worktrees", `fix${input.number}-`))
  rmSync(worktree, { recursive: true, force: true })
  const added = await git(["worktree", "add", "--detach", "--quiet", worktree, input.head], input.directory)
  if (added.code !== 0) return { ok: false, reason: `could not check out ${input.head.slice(0, 12)}` }
  let sessionId: string | undefined
  const withSession = <T extends FixResult>(result: T): T => sessionId ? { ...result, sessionId } : result
  try {
    const session = await input.sessions(worktree)({ purpose: "review" })
    const id = (session as { id?: unknown }).id
    if (typeof id === "string") { sessionId = id; input.onSession?.(id) }
    let said = ""
    try { said = (await session.send(fixPrompt(input))).text.trim() } finally { await session.close() }
    const status = await git(["status", "--porcelain"], worktree)
    if (status.code !== 0) return withSession({ ok: false, reason: "git could not read the fix's changes" })
    if (!status.out.trim()) return withSession({ ok: false, reason: `the fix session changed nothing${said ? `: ${said.slice(0, 500)}` : ""}` })
    if (input.checks.length) {
      const results = await input.runChecks(worktree, input.checks)
      const failed = results.find((result) => result.code !== 0)
      if (failed) return withSession({ ok: false, reason: `\`${failed.command}\` ${failed.code === -1 ? "could not run" : `exited with ${failed.code}`}, so the fix was not pushed:\n\n\`\`\`text\n${failed.output.slice(-CHECK_TAIL).replace(/```/g, "'''")}\n\`\`\`` })
    }
    if ((await git(["add", "-A"], worktree)).code !== 0) return withSession({ ok: false, reason: "git could not stage the fix" })
    const message = fixCommitMessage(input)
    const committed = await git(["commit", "--quiet", "--no-verify", "-m", message.subject, "-m", message.body], worktree)
    if (committed.code !== 0) return withSession({ ok: false, reason: "git could not commit the fix (is user.name and user.email set?)" })
    const commit = (await git(["rev-parse", "HEAD"], worktree)).out.trim()
    // Kept before anything is decided: a crash, a refusal or a revalidation that fails from here on still leaves the work reachable.
    const kept = await keep({ git, directory: input.directory, number: input.number, commit, now })
    if (!kept) return withSession({ ok: false, commit, reason: "git could not keep the fix's commit on a local ref, so it was not pushed" })
    return withSession(await pushOrKeep({ input, git, commit, kept }))
  } finally {
    await git(["worktree", "remove", "--force", worktree], input.directory)
    rmSync(worktree, { recursive: true, force: true })
    await git(["worktree", "prune"], input.directory)
  }
}
