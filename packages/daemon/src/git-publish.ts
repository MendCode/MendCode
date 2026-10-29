import path from "node:path"
import { GIT_PUBLISH_MAX_DESCRIPTION, publishNameProblem, publishOwnerProblem, type GitPublishPlan, type GitPublishReport } from "@mendcode/protocol"
import { networkEnv, repoLocks, run } from "./git-exec"
import { NO_GH, NOT_LOGGED_IN, first, unauthenticated } from "./git-pr"
import { GitActionRefusal, maskUrl, reader, repositoryRoot, shownMasked } from "./git-remote"

const ACCOUNT_MS = 30_000
const CREATE_MS = 90_000
const LINK = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** The command lines a user's `permission.bash` rule can match for the creation, from the full command to the plain one, and for the read of the account. */
export const publishLines = (plan: Pick<GitPublishPlan, "argv" | "owner" | "name">) => [plan.argv.join(" "), `gh repo create ${plan.owner}/${plan.name}`, "gh repo create"]
export const accountLines = () => ["gh api user --jq .login", "gh api user"]

/** The only flags the command can carry: the description is one `--description=` word, so no text of the form can become a flag of its own. */
const FLAGS = new Set(["--private", "--source", "--remote"])

/**
 * The `gh repo create` command of the page, and the only one: `--private` is always in it, and neither `--public`, `--internal` nor `--push` can be
 * (the push is `git.push`, confirmed on its own). `owner` and `name` have passed their checks; `description` is one line of text.
 */
export function publishArgv(input: { owner: string; name: string; root: string; description?: string }): string[] {
  const problem = publishOwnerProblem(input.owner) ?? publishNameProblem(input.name)
  if (problem) throw new GitActionRefusal(problem)
  const argv = ["gh", "repo", "create", `${input.owner}/${input.name}`, "--private", "--source", input.root, "--remote", "origin", ...(input.description ? [`--description=${input.description}`] : [])]
  const flags = argv.slice(3).filter((word) => word.startsWith("-"))
  if (!argv.includes("--private") || flags.some((word) => !FLAGS.has(word) && !word.startsWith("--description="))) throw new Error("[GIT]: the publish command must be private and carry no other flag")
  return argv
}

/** A repository name for the folder: what GitHub takes of its name, never empty. */
function defaultName(root: string) {
  const name = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100)
  return publishNameProblem(name) ? "repository" : name
}

const words = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean)

/**
 * Publishes the repository as a new private repository on GitHub (`git.publish`, docs/git.md): `gh repo create <owner>/<name> --private --source
 * <root> --remote origin [--description=…]`, without `--push`. The repository needs no commit and may be on a detached HEAD (the command only adds a
 * remote); it must not have a remote named `origin` (one is never replaced or renamed). The name and owner are checked before they reach an argument
 * list and default to the folder's name and the gh account. If gh creates the repository but the remote is not added, or the other way round, the
 * answer says what exists now and what to run; nothing is deleted and nothing is retried. With `preview` nothing is created (the account is read
 * when no owner is given). `denied` names the user's permission rule that forbids one of the command lines, if any.
 */
export async function gitPublish(input: { directory: string; name?: string; owner?: string; description?: string; preview?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; denied?: (lines: string[]) => string | undefined }): Promise<GitPublishReport> {
  const env = input.env ?? process.env
  const root = await repositoryRoot(input.directory, env)
  const read = reader(root, env)

  // What was typed is checked first: it costs no process.
  const name = (input.name ?? defaultName(root)).trim()
  const nameProblem = publishNameProblem(name)
  if (nameProblem) throw new GitActionRefusal(nameProblem)
  const typedOwner = input.owner?.trim()
  const typedProblem = typedOwner === undefined ? undefined : publishOwnerProblem(typedOwner)
  if (typedProblem) throw new GitActionRefusal(typedProblem)
  const description = (input.description ?? "").trim()
  if (/[\u0000-\u001f\u007f-\u009f]/.test(description)) throw new GitActionRefusal("the description must be one line of text")
  if (description.length > GIT_PUBLISH_MAX_DESCRIPTION) throw new GitActionRefusal(`the description is too long (${GIT_PUBLISH_MAX_DESCRIPTION} characters at most)`)

  const remotes = words((await read(["remote"])).out)
  const configured = await read(["config", "--get-regexp", "^remote\\.origin\\."])
  if (remotes.includes("origin") || configured.code === 0) {
    const address = await read(["remote", "get-url", "origin"])
    throw new GitActionRefusal(`a remote named origin already exists${address.code === 0 && address.out.trim() ? ` (${maskUrl(address.out.trim())})` : ""}: the page never replaces or renames a remote`)
  }

  const symbolic = await read(["symbolic-ref", "-q", "--short", "HEAD"])
  const branch = symbolic.code === 0 ? symbolic.out.trim() : ""
  const hasCommit = (await read(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0
  const counted = hasCommit ? await read(["rev-list", "--count", "HEAD"]) : undefined
  const commits = counted ? Number(counted.out.trim()) || 0 : 0
  const head = !hasCommit ? "unborn" : branch ? "branch" : "detached"

  const defaultOwner = typedOwner === undefined ? await account({ root, env, denied: input.denied }) : ""
  const owner = typedOwner ?? defaultOwner

  const argv = publishArgv({ owner, name, root, description })
  const plan: GitPublishPlan = {
    root, repo: `${owner}/${name}`, owner, name, description, visibility: "private", remote: "origin", argv,
    defaults: { name: defaultName(root), owner: defaultOwner || owner }, head, ...(branch ? { branch } : {}), commits,
  }
  const rule = input.denied?.(publishLines(plan))
  if (rule) throw new GitActionRefusal(rule, "forbidden")
  if (input.preview) return { plan, published: false }

  if (repoLocks.has(root)) throw new GitActionRefusal("another commit, push, publish or pull request is running in this repository")
  repoLocks.add(root)
  try {
    const limit = input.timeoutMs ?? CREATE_MS
    const done = await run({ program: "gh", cwd: root, args: argv.slice(1), env: networkEnv(env), timeoutMs: limit, detached: true })
    if (done.code === 127) throw new GitActionRefusal(NO_GH)
    const url = done.out.split("\n").map((line) => line.trim()).findLast((line) => LINK.test(line))
    const now = await originNow(read)
    const text = shownMasked(`${done.out}\n${done.err}`)
    if (!done.timedOut && done.code === 0 && now) return { plan, published: true, ...(url ? { url } : {}), origin: now }

    // Something may exist that the page did not finish: say exactly what, and what to run. Nothing is deleted and nothing is retried.
    const seconds = Math.round(limit / 1000)
    const partial = done.timedOut || done.code === 0 || url !== undefined || now !== undefined
    if (!partial) {
      if (unauthenticated(done.err)) throw new GitActionRefusal(NOT_LOGGED_IN)
      const reason = first(done.err || done.out)
      throw new GitActionRefusal([`gh could not create the repository: ${reason || `exit ${done.code}`}`, ...words(text).filter((line) => line !== reason)].join("\n"))
    }
    const headline = done.timedOut ? `gh timed out after ${seconds}s: ${plan.repo} may or may not exist on GitHub`
      : done.code === 0 ? "publish incomplete: gh reported success but origin was not added"
      : url ? `publish incomplete: ${plan.repo} was created, gh failed (exit ${done.code})`
      : `publish incomplete: gh failed (exit ${done.code}) after adding origin`
    const known = url ?? `<the address of ${plan.repo}>`
    throw new GitActionRefusal([
      headline,
      now ? `now: origin points to ${now}` : "now: this repository has no remote named origin",
      url ? `on GitHub: ${url}` : `on GitHub: unknown, check whether ${plan.repo} exists before trying again`,
      now ? "run: nothing to add; push from the PR tab when you are ready" : `run: git remote add origin ${known}`,
      "nothing was deleted and nothing is retried",
      ...words(text).filter((line) => line !== url),
    ].join("\n"))
  } finally { repoLocks.delete(root) }
}

/** The address `origin` has now, credentials masked, or undefined when there is no such remote. */
async function originNow(read: ReturnType<typeof reader>) {
  const address = await read(["remote", "get-url", "origin"]).catch(() => undefined)
  return address && address.code === 0 && address.out.trim() ? maskUrl(address.out.trim()) : undefined
}

/** The login of the gh account (`gh api user`), the default owner. Its failures are the clear lines of the other gh actions. */
async function account(input: { root: string; env: NodeJS.ProcessEnv; denied: ((lines: string[]) => string | undefined) | undefined }) {
  const rule = input.denied?.(accountLines())
  if (rule) throw new GitActionRefusal(rule, "forbidden")
  const done = await run({ program: "gh", cwd: input.root, args: ["api", "user", "--jq", ".login"], env: networkEnv(input.env), timeoutMs: ACCOUNT_MS, detached: true })
  if (done.code === 127) throw new GitActionRefusal(NO_GH)
  if (done.timedOut) throw new GitActionRefusal("gh timed out reading your account")
  if (done.code !== 0) throw new GitActionRefusal(unauthenticated(done.err) ? NOT_LOGGED_IN : `gh could not read your account: ${first(done.err) || `exit ${done.code}`}`)
  const login = done.out.trim()
  if (publishOwnerProblem(login)) throw new GitActionRefusal("gh returned something that is not an account name")
  return login
}
