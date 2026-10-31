import type { CommandRun, DaemonFeature, ProviderCapabilities, ProviderKind, ReviewProvider } from "../contracts"
import { gitRun, type GitRun } from "../context"
import { createGiteaProvider, tokenFromEnv } from "./gitea"
import { createGithubProvider, GITHUB_CAPABILITIES } from "./github"
import { createGitlabProvider } from "./gitlab"

/**
 * Which forge a checkout talks to and what MendCode can really do there (docs/pr-review.md, providers; R10). Detection reads the
 * remote URL only: no network, no credential. The capability matrix is the single truthful statement of each adapter: a feature
 * the provider's documented API lacks, or that the adapter does not implement, is `false` and the platform never imitates it
 * (no fake threads, no fake approvals). `verified: "contract"` means the adapter is proven against fixtures built from the
 * provider's documentation, never against the live service; it changes to `live` only when a real call passes in this build.
 * scripts/live-forges.ts is that real call for GitLab and Gitea (local GitLab CE 19.5.3 and Gitea 28.2.0 passed on 2026-10-30),
 * and its `--daemon` flow runs the daemon itself against them (watch, post, dedupe, mentions, fix push). A row is `live` only
 * when that daemon flow passed against the forge; otherwise it stays `contract`, so the matrix never claims more than the daemon does.
 */

/** A remote URL split into the parts every adapter needs. `port` is kept only for an https remote (an ssh port is not the web's). */
export type RemoteUrl = { host: string; port?: string | undefined; path: string; scheme: "https" | "http" | "ssh" | "git" }

/**
 * Parses the remote forms git accepts for a forge: `https://host[:port]/path(.git)`, `ssh://[user@]host[:port]/path(.git)`,
 * scp-like `user@host:path(.git)` and `git://host/path`. Credentials in an https URL are dropped, never returned.
 */
export function parseRemoteUrl(remote: string): RemoteUrl | undefined {
  const text = remote.trim()
  const clean = (path: string) => decodeURIComponent(path).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
  const url = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(text)
  if (url) {
    const scheme = url[1]!.toLowerCase() as RemoteUrl["scheme"]
    const path = clean(url[4]!)
    return path ? { host: url[2]!.toLowerCase(), ...(url[3] && scheme.startsWith("http") ? { port: url[3] } : {}), path, scheme } : undefined
  }
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(text)
  if (scp) { const path = clean(scp[2]!); return path ? { host: scp[1]!.toLowerCase(), path, scheme: "ssh" } : undefined }
  return undefined
}

/** Hosts the user names in config (GitHub Enterprise, a self-hosted GitLab or Gitea whose name says nothing), by lowercase host. */
export type ProviderOverrides = { hosts?: Readonly<Record<string, ProviderKind>> | undefined }

export type DetectedProvider =
  | { kind: ProviderKind; host: string; repo: string; /** The web/API origin (`https://host[:port]`). */ baseUrl: string; reason: string }
  | { kind: undefined; host?: string | undefined; reason: string }

const byName = (host: string): { kind: ProviderKind; reason: string } | undefined => {
  if (host === "github.com" || host === "ssh.github.com") return { kind: "github", reason: `${host} is GitHub` }
  if (host === "gitlab.com" || host.includes("gitlab")) return { kind: "gitlab", reason: host === "gitlab.com" ? "gitlab.com is GitLab" : `the host ${host} names GitLab` }
  if (host === "codeberg.org") return { kind: "gitea", reason: "codeberg.org runs Forgejo (Gitea's API)" }
  if (host.includes("gitea") || host.includes("forgejo")) return { kind: "gitea", reason: `the host ${host} names ${host.includes("gitea") ? "Gitea" : "Forgejo"} (Gitea's API)` }
  return undefined
}

/**
 * The provider of a remote URL. A config override wins over the host's name (`hosts: { "git.corp.example": "github" }` for
 * GitHub Enterprise). GitHub and Gitea repositories are exactly `owner/repo`; GitLab keeps every subgroup (`group/sub/project`).
 */
export function detectProvider(remoteUrl: string, overrides: ProviderOverrides = {}): DetectedProvider {
  const remote = parseRemoteUrl(remoteUrl)
  if (!remote) return { kind: undefined, reason: `${JSON.stringify(remoteUrl.slice(0, 120))} is not a remote URL git understands (https, ssh or user@host:path)` }
  const configured = Object.entries(overrides.hosts ?? {}).find(([host]) => host.toLowerCase() === remote.host || host.toLowerCase() === `${remote.host}:${remote.port ?? ""}`)
  const found = configured ? { kind: configured[1], reason: `the config names ${configured[0]} as ${configured[1]}` } : byName(remote.host)
  if (!found) return { kind: undefined, host: remote.host, reason: `${remote.host} is not a known GitHub, GitLab or Gitea host; name it in the provider host overrides to review there` }
  const segments = remote.path.split("/").filter(Boolean)
  if (found.kind !== "gitlab" && segments.length !== 2) return { kind: undefined, host: remote.host, reason: `${remote.path} is not owner/repo, which ${found.kind === "github" ? "GitHub" : "Gitea"} repositories always are` }
  if (found.kind === "gitlab" && segments.length < 2) return { kind: undefined, host: remote.host, reason: `${remote.path} is not group/project` }
  const origin = `${remote.scheme === "http" ? "http" : "https"}://${remote.host}${remote.port ? `:${remote.port}` : ""}`
  return { kind: found.kind, host: remote.host, repo: segments.join("/"), baseUrl: origin, reason: found.reason }
}

/**
 * The forge of a checkout for the daemon: `origin` as written in the checkout's config (`remote.origin.url`, before any
 * `insteadOf` rewriting) and, for a self-hosted host whose name says nothing (`127.0.0.1:3000`, `git.corp.example`), the kind the
 * user named with `git config mendcode.forge gitlab|gitea|github` in that checkout. Local only: no network, no credential.
 */
export async function checkoutForge({ directory, git = gitRun }: { directory: string; git?: GitRun | undefined }): Promise<DetectedProvider> {
  const url = await git(["config", "--get", "remote.origin.url"], directory).catch(() => ({ code: 1, out: "" }))
  if (url.code !== 0 || !url.out.trim()) return { kind: undefined, reason: `${directory} has no origin remote` }
  const named = await git(["config", "--get", "mendcode.forge"], directory).catch(() => ({ code: 1, out: "" }))
  const kind = named.code === 0 ? named.out.trim().toLowerCase() : ""
  const remote = parseRemoteUrl(url.out.trim())
  const hosts = remote && (kind === "github" || kind === "gitlab" || kind === "gitea") ? { [`${remote.host}${remote.port ? `:${remote.port}` : ""}`]: kind as ProviderKind } : undefined
  const found = detectProvider(url.out.trim(), hosts ? { hosts } : {})
  if (found.kind === undefined || found.kind === "github") return found
  // An ssh remote says nothing of the web port or scheme: `git config mendcode.forgeUrl http://host:port` names them.
  const web = await git(["config", "--get", "mendcode.forgeUrl"], directory).catch(() => ({ code: 1, out: "" }))
  const origin = web.code === 0 ? /^(https?:\/\/[^/\s?#]+)\/*$/i.exec(web.out.trim())?.[1] : undefined
  return origin ? { ...found, baseUrl: origin.toLowerCase(), reason: `${found.reason}; mendcode.forgeUrl names ${origin}` } : found
}

/** `glab` with an argument array (no shell, no prompt), 30 seconds at most; 127 when it is not installed. glab keeps its own login. */
export const glabProcess: CommandRun = async ({ argv, cwd, stdin }) => {
  try {
    const child = Bun.spawn(["glab", ...argv], { ...(cwd ? { cwd } : {}), stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_PROMPT: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1", GLAB_CHECK_UPDATE: "false" } })
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, out, err }
    } finally { clearTimeout(timer) }
  } catch (error) { return { code: 127, out: "", err: error instanceof Error ? error.message : String(error) } }
}

/** The environment variable a Gitea or Forgejo token is read from, at each call (never stored, never printed). */
export const GITEA_TOKEN_ENV = "GITEA_TOKEN"

/** The repository path of a checkout's `origin`, read through git (no network). Shared by the adapters' `repoOf`. */
export async function remoteRepoOf({ directory, git = gitRun, provider }: { directory: string; git?: GitRun | undefined; provider: ProviderKind }): Promise<string> {
  const done = await git(["remote", "get-url", "origin"], directory)
  const remote = done.code === 0 ? parseRemoteUrl(done.out) : undefined
  const segments = remote?.path.split("/").filter(Boolean) ?? []
  if (!remote || (provider === "gitlab" ? segments.length < 2 : segments.length !== 2)) throw new Error(`[PR_REVIEW]: the origin remote of ${directory} does not name a ${provider} repository`)
  return segments.join("/")
}

// ── Capabilities ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per provider, what MendCode does there. Sources (read 2026-10-30):
 * - GitHub: providers/github.ts owns its row (`GITHUB_CAPABILITIES`) and its verification state; it is taken from there as is.
 * - GitLab: merge requests API (https://docs.gitlab.com/api/merge_requests/: `draft`, `labels`, `reviewers`, `allow_collaboration`),
 *   discussions API (https://docs.gitlab.com/api/discussions/: diff threads with `position`, `PUT …/discussions/:id?resolved=true`),
 *   suggestions (https://docs.gitlab.com/user/project/merge_requests/reviews/suggestions/: ```suggestion:-N+M). A merge request
 *   has no review object carrying an event: comments are notes and discussions, approval is a separate action MendCode never
 *   takes, so `reviewEvents` is false. The REST docs (https://docs.gitlab.com/api/rest/) document no ETag/If-None-Match.
 * - Gitea/Forgejo: the API swagger (https://gitea.com/swagger.v1.json, Gitea 1.27 release branch; https://codeberg.org/swagger.v1.json,
 *   Forgejo): `POST /repos/{owner}/{repo}/pulls/{index}/reviews` with event COMMENT and `comments[].new_position` (one line, no
 *   range), `draft`, `labels`, `requested_reviewers`, `allow_maintainer_edit`. Resolving a review comment
 *   (`POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve`) exists from Gitea 1.26 but not in Forgejo (Codeberg), and the
 *   adapter does not tell them apart, so `resolveThreads` is false. No suggested-change syntax is documented. No conditional
 *   requests are documented.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderKind, ProviderCapabilities>> = {
  github: GITHUB_CAPABILITIES,
  gitlab: { inlineComments: true, suggestions: true, resolveThreads: true, reviewEvents: false, requestedReviewers: true, labels: true, draft: true, forkPush: true, conditionalRequests: false, verified: "live" },
  gitea: { inlineComments: true, suggestions: false, resolveThreads: false, reviewEvents: true, requestedReviewers: true, labels: true, draft: true, forkPush: true, conditionalRequests: false, verified: "live" },
}

const CAPABILITY_ROWS: ReadonlyArray<[keyof Omit<ProviderCapabilities, "verified">, string]> = [
  ["inlineComments", "Inline comments on diff lines"],
  ["suggestions", "Suggested-change blocks"],
  ["resolveThreads", "Resolve a thread when fixed"],
  ["reviewEvents", "One review object with an event (COMMENT)"],
  ["requestedReviewers", "Requested reviewers"],
  ["labels", "Labels"],
  ["draft", "Draft state"],
  ["forkPush", "Push to a fork's branch when allowed"],
  ["conditionalRequests", "Conditional list requests (ETag)"],
]

const PROVIDER_NOTES: Readonly<Record<ProviderKind, string>> = {
  github: "through `gh`; reviews are posted with event COMMENT, never REQUEST_CHANGES or APPROVE.",
  gitlab: "through `glab api`; the summary is a merge request note and each inline comment its own diff discussion (a merge request has no review object); a comment GitLab refuses moves into the summary; multi-line suggestions use ```suggestion:-N+0.",
  gitea: "REST `/api/v1` with a token read from the environment variable the config names; also Forgejo (Codeberg). Inline comments anchor one line; thread resolution is not used (Forgejo has no API for it).",
}

/** The capability matrix as a Markdown table, with the verification state and one note per provider (docs/pr-review.md). */
export function capabilityMatrixText(matrix: Readonly<Record<ProviderKind, ProviderCapabilities>> = PROVIDER_CAPABILITIES): string {
  const kinds = Object.keys(matrix) as ProviderKind[]
  const name = (kind: ProviderKind) => kind === "github" ? "GitHub" : kind === "gitlab" ? "GitLab" : "Gitea / Forgejo"
  const rows = [
    `| Capability | ${kinds.map(name).join(" | ")} |`,
    `|---|${kinds.map(() => "---").join("|")}|`,
    ...CAPABILITY_ROWS.map(([key, label]) => `| ${label} | ${kinds.map((kind) => matrix[kind][key] ? "yes" : "no").join(" | ")} |`),
    `| Verified | ${kinds.map((kind) => matrix[kind].verified === "live" ? "live" : "contract (fixtures, not live)").join(" | ")} |`,
  ]
  return [...rows, "", ...kinds.map((kind) => `- ${name(kind)}: ${PROVIDER_NOTES[kind]}`)].join("\n")
}

// ── What the daemon runs per forge ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The daemon's features per forge (docs/pr-review.md, providers). GitHub runs everything through `gh`. GitLab and Gitea run the
 * watch, reviews, posts, `@mendcode` commands, claims and fixes through their adapters; what is `false` is said to the session
 * once with the reason below, never skipped silently.
 */
export const DAEMON_FEATURES: Readonly<Record<ProviderKind, Readonly<Record<DaemonFeature, boolean>>>> = {
  github: { watch: true, review: true, publish: true, mentions: true, claims: true, fix: true, resolveThreads: true, checkFollowUp: true, hostedRunner: true },
  gitlab: { watch: true, review: true, publish: true, mentions: true, claims: true, fix: true, resolveThreads: true, checkFollowUp: false, hostedRunner: false },
  gitea: { watch: true, review: true, publish: true, mentions: true, claims: true, fix: true, resolveThreads: false, checkFollowUp: false, hostedRunner: false },
}
export const DAEMON_FEATURE_REASONS: Readonly<Partial<Record<DaemonFeature, string>>> = {
  resolveThreads: "a fixed finding's thread is not resolved: Forgejo has no API for it and the adapter does not tell Gitea from Forgejo",
  checkFollowUp: "failing checks are not explained after a review: the follow-up reads GitHub check runs and Actions logs, and no GitLab pipeline or Gitea Actions reader is wired",
  hostedRunner: "the hosted runner (`mendcode github run`) is a GitHub Action; there is no GitLab CI or Gitea Actions runner",
}
export const forgeName = (kind: ProviderKind) => kind === "github" ? "GitHub" : kind === "gitlab" ? "GitLab" : "Gitea"
/** The features gated off on `kind`, one line each with its reason. */
export const gatedOff = (kind: ProviderKind) => (Object.keys(DAEMON_FEATURES[kind]) as DaemonFeature[]).filter((feature) => !DAEMON_FEATURES[kind][feature]).map((feature) => `${forgeName(kind)}: ${DAEMON_FEATURE_REASONS[feature] ?? `${feature} is off`}`)

// ── Construction ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What an adapter may need. `run` is the provider's CLI (`gh` or `glab`, argv without the binary); Gitea uses `fetch` against
 * `baseUrl` with `token`, a reader of the environment variable the config names (MendCode never stores a forge token).
 */
export type ProviderDeps = {
  run?: CommandRun | undefined
  git?: GitRun | undefined
  fetch?: typeof fetch | undefined
  baseUrl?: string | undefined
  /** GitLab's host for `glab api --hostname` when it is not gitlab.com and the call has no checkout to infer it from. A `baseUrl`
   * (what `detectProvider` returns) wins for GitLab too: full API URLs work for a host with a port, `--hostname` does not. */
  hostname?: string | undefined
  token?: (() => string | undefined) | undefined
}

/** The adapter of `kind`. Throws `TypeError` when a dependency that kind needs is missing. */
export function createProvider(kind: ProviderKind, deps: ProviderDeps): ReviewProvider {
  if (kind === "gitea") {
    if (!deps.baseUrl) throw new TypeError("[PR_REVIEW]: a Gitea provider needs the instance's base URL")
    return createGiteaProvider({ baseUrl: deps.baseUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.token ? { token: deps.token } : {}), ...(deps.git ? { git: deps.git } : {}) })
  }
  if (!deps.run) throw new TypeError(`[PR_REVIEW]: a ${kind} provider needs its CLI runner`)
  if (kind === "gitlab") return createGitlabProvider({ run: deps.run, ...(deps.hostname ? { hostname: deps.hostname } : {}), ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}), ...(deps.git ? { git: deps.git } : {}) })
  return createGithubProvider({ run: deps.run })
}

/**
 * The daemon's adapter for a detected GitLab or Gitea checkout: GitLab through the user's own `glab` (its stored login of that
 * host), Gitea over HTTP with the token read from `GITEA_TOKEN` at each call. MendCode never reads, prints or stores either token.
 */
export function forgeProvider(found: Extract<DetectedProvider, { kind: ProviderKind }>, deps: { git?: GitRun | undefined; run?: CommandRun | undefined; fetch?: typeof fetch | undefined; env?: Readonly<Record<string, string | undefined>> | undefined } = {}): ReviewProvider {
  if (found.kind === "gitea") return createProvider("gitea", { baseUrl: found.baseUrl, token: tokenFromEnv(GITEA_TOKEN_ENV, deps.env ?? process.env), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.git ? { git: deps.git } : {}) })
  if (found.kind === "gitlab") return createProvider("gitlab", { run: deps.run ?? glabProcess, ...(found.host === "gitlab.com" ? {} : { baseUrl: found.baseUrl }), ...(deps.git ? { git: deps.git } : {}) })
  throw new TypeError("[PR_REVIEW]: the daemon's GitHub path is gh itself, not an adapter")
}
