import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { redactSecrets, type MemoryEntry } from "@mendcode/protocol"
import { HOSTED_WORKFLOW_FILE } from "../github"
import { CONFIG_PATH } from "./config"
import { effectiveConfig } from "./config-layers"
import { gitRun, type GitRun } from "./context"
import type { ProviderKind } from "./contracts"
import { DeviceIdentity, devicePath } from "./device"
import { parseClaims, resolveClaims } from "./ownership"
import { levelOf, WRITE_LEVELS, type Permission } from "./permissions"
import { createProfileStore, type ProfileStore } from "./profile-store"
import { checkoutForge, forgeName, remoteRepoOf } from "./providers"
import { parseRegistry, REGISTRY_PATH, type RegistryForge } from "./registry"

/**
 * `review_config setup`: what a sit-down PR reviewer setup with a developer starts from (docs/pr-review-setup.md). One read-only
 * report for the session's checkout: the forge, the user's login and permission, the repository's config on the base branch
 * (`.mendcode/review.yaml`, `.mendcode/reviewers.yaml`), whether the hosted workflow is installed, this daemon's watches, other
 * devices' claims on open PRs, the user's personal profile, and the signals of the user's role (permission, CODEOWNERS,
 * MAINTAINERS, reviewers.yaml, recent PR activity, saved memories that state a role). It ends with what the setup still lacks and
 * the questions to ask, so the model asks and confirms instead of assuming.
 *
 * Nothing here writes: no git state, no profile, no memory, no device identity, no forge call that changes anything. Every change
 * the developer then chooses goes through the paths that ask them (`review_config` preview/apply, `/pr` commands they type,
 * `remember` proposals). Forge reads are GitHub's (`gh`); on GitLab and Gitea the login, permission and activity are not read
 * here and the developer is asked instead. A signal that cannot be read says so; it is never guessed.
 */

export type SetupGh = (argv: string[], cwd: string) => Promise<{ code: number; out: string }>
/** Saved memories a session of `directory` may see (the profile's user memories and the project's). */
export type SetupMemory = { visible(input: { directory: string }): MemoryEntry[] }

export type ReviewSetupDeps = {
  dataDir: string
  gh: SetupGh
  git?: GitRun | undefined
  memory?: SetupMemory | undefined
  /** The user's `memoryEnabled` for `directory` (with its project override); false: memory is not read at all. */
  memoryEnabled?: ((directory: string) => boolean) | undefined
  profiles?: ProfileStore | undefined
  now?: (() => number) | undefined
}

export type SetupWatch = { directory: string; role?: string | undefined; login?: string | undefined; state: string; publish: string }
export type SetupClaim = { number: number; reviewer: string; device: string; expiresAt: number }
export type SetupMemoryLine = { id: string; scope: string; category?: string | undefined; text: string }
export type SetupRole = { inferred: string; basis: string[]; remembered: SetupMemoryLine[]; known: boolean }

export type ReviewSetupReport = {
  directory: string
  root?: string | undefined
  forge: { kind?: ProviderKind | undefined; name?: string | undefined; reason: string }
  repo?: string | undefined
  login?: string | undefined
  loginProblem?: string | undefined
  permission: Permission
  base: {
    ref?: string | undefined
    review: { exists: boolean; enabled: boolean; preset: string; language: string; fixMode: string; push: boolean; publishers: string; tokensPerPr: number | null; problems: string[] }
    workingTreeDiffers: boolean
    registry: { exists: boolean; reviewers: Array<{ id: string; scope: string; login?: string | undefined; areas: string[] }>; routing: string; problems: string[] }
  }
  hosted: { onBase: boolean; inWorkingTree: boolean }
  watches: SetupWatch[]
  claims: { read: boolean; reason?: string | undefined; others: SetupClaim[] }
  personal: { path?: string | undefined; exists: boolean; version: number; reason?: string | undefined }
  codeowners: { file?: string | undefined; patterns: string[] }
  maintainers: { file?: string | undefined; lines: string[] }
  activity?: { authored: number; reviewed: number; limit: number } | undefined
  role: SetupRole
  missing: string[]
  questions: string[]
}

const ACTIVITY_LIMIT = 30
const CLAIM_COMMENTS = 100
const MEMORY_LINES = 6
const MEMORY_TEXT = 240
const LIST_LIMIT = 10
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
const MAINTAINER_FILES = ["MAINTAINERS", "MAINTAINERS.md", "OWNERS", ".github/MAINTAINERS.md"]
/** Words that make a saved memory a statement about someone's role (English and Spanish, the product owner's languages). */
const ROLE_WORDS = /\b(role|rol|maintainer|maintainers|mantenedor|owner|owns|codeowner|admin|lead|tech lead|líder|lider|reviewer|revisor|contributor|colaborador|intern|new to|onboarding|nuevo|manager|responsable)\b/i

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const StoredWatch = z.object({
  directory: z.string(),
  role: z.enum(["all", "requested"]).optional(),
  login: z.string().max(255).optional(),
  publish: z.enum(["allowed", "denied"]).optional(),
  paused: z.string().optional(),
  ended: z.object({ reason: z.string() }).passthrough().optional(),
  repo: z.string().max(200).optional(),
}).passthrough()
const WatchesFile = z.object({ watches: z.array(z.unknown()) }).passthrough()
const IssueComment = z.object({ body: z.string().nullable().optional(), user: z.object({ login: z.string() }).passthrough().nullable().optional() }).passthrough()

/** This daemon's repo watches of the checkout (or of the same repository), read from watches.json without touching it. */
export function watchesOf(dataDir: string, root: string, repo: string | undefined): SetupWatch[] {
  const file = path.join(dataDir, "pr-review", "watches.json")
  if (!existsSync(file)) return []
  let parsed: z.infer<typeof WatchesFile>
  try {
    const read = WatchesFile.safeParse(JSON.parse(readFileSync(file, "utf8")))
    if (!read.success) return []
    parsed = read.data
  } catch { return [] }
  const inside = (directory: string) => directory === root || directory.startsWith(`${root}${path.sep}`)
  return parsed.watches.flatMap((raw) => {
    const watch = StoredWatch.safeParse(raw)
    if (!watch.success) return []
    const data = watch.data
    if (!inside(data.directory) && !(repo && data.repo?.toLowerCase() === repo.toLowerCase())) return []
    return [{
      directory: data.directory,
      ...(data.role ? { role: data.role } : {}),
      ...(data.login ? { login: data.login } : {}),
      state: data.ended ? `ended (${clip(data.ended.reason, 120)})` : data.paused ? `paused (${clip(data.paused, 120)})` : "active",
      publish: data.publish === "allowed" ? "posting allowed" : data.publish === "denied" ? "posting denied" : "posting not answered yet",
    }]
  })
}

/** Saved user and project memories that state a role or name the login, redacted and clipped; none when memory is off. */
export function roleMemories(memory: SetupMemory | undefined, directory: string, login: string | undefined): SetupMemoryLine[] {
  if (!memory) return []
  const named = login ? new RegExp(`(^|[^A-Za-z0-9-])@?${login.replace(/[-]/g, "\\-")}([^A-Za-z0-9-]|$)`, "i") : undefined
  const entries = memory.visible({ directory })
    .filter((entry) => entry.status === "saved" && (entry.scope === "user" || entry.scope === "project"))
    .filter((entry) => ROLE_WORDS.test(entry.text) || (named?.test(entry.text) ?? false))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || b.updatedAt - a.updatedAt)
  return entries.slice(0, MEMORY_LINES).map((entry) => ({
    id: entry.memoryId as string,
    scope: entry.scope === "user" ? "global" : "project",
    ...(entry.category ? { category: entry.category } : {}),
    text: clip(redactSecrets(entry.text.replace(/\s+/g, " ").trim()).text, MEMORY_TEXT),
  }))
}

/** CODEOWNERS patterns that name `@login`, from the first CODEOWNERS file on the base ref. */
export function codeownerPatterns(text: string, login: string): string[] {
  const mention = `@${login.toLowerCase()}`
  return text.split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean)
    .filter((line) => line.split(/\s+/).slice(1).some((owner) => owner.toLowerCase() === mention))
    .map((line) => line.split(/\s+/)[0]!)
}

/** A role from the signals; never a fact: the model confirms it with the developer. */
export function inferRole(input: { permission: Permission; codeowner: boolean; listedGlobal: boolean; listedPersonal: boolean; maintainer: boolean; activity?: { authored: number; reviewed: number } | undefined }): string {
  const { permission } = input
  if (permission === "admin") return "maintainer (repository admin)"
  if (permission === "maintain") return "maintainer"
  if (permission === "write") return input.codeowner || input.maintainer || input.listedGlobal ? "code owner / maintainer with write access" : (input.activity?.reviewed ?? 0) > 0 ? "contributor with write access who reviews PRs" : "contributor with write access"
  if (permission === "triage" || permission === "read") return "contributor without write access"
  if (permission === "none") return "outside contributor (no access to the repository)"
  if (input.codeowner || input.maintainer) return "code owner (permission not readable)"
  if (input.listedPersonal) return "personal reviewer listed in reviewers.yaml (permission not readable)"
  if ((input.activity?.authored ?? 0) + (input.activity?.reviewed ?? 0) > 0) return "contributor (permission not readable)"
  return "unknown"
}

export function createReviewSetup(deps: ReviewSetupDeps) {
  const git = deps.git ?? gitRun
  const now = deps.now ?? Date.now
  const profiles = deps.profiles ?? createProfileStore({ dataDir: deps.dataDir, now })
  const gh = async (argv: string[], cwd: string) => {
    const done = await deps.gh(argv, cwd).catch(() => ({ code: 1, out: "" }))
    return done.code === 0 ? done.out.trim() : undefined
  }
  const json = (text: string | undefined): unknown => { if (!text) return undefined; try { return JSON.parse(text) } catch { return undefined } }
  const show = async (root: string, ref: string | undefined, file: string) => {
    if (!ref) return undefined
    const done = await git(["show", `${ref}:${file}`], root)
    return done.code === 0 ? done.out : undefined
  }

  /** The default branch as the remote names it (`origin/main`), else `HEAD`; undefined without a commit. */
  const baseRef = async (root: string) => {
    const remote = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)
    if (remote.code === 0 && remote.out.trim()) return remote.out.trim()
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root)
    return head.code === 0 ? "HEAD" : undefined
  }

  const ownDevice = () => {
    try { const parsed = DeviceIdentity.safeParse(JSON.parse(readFileSync(devicePath(deps.dataDir), "utf8"))); return parsed.success ? parsed.data.id : undefined } catch { return undefined }
  }

  async function report(directory: string): Promise<ReviewSetupReport> {
    const top = await git(["rev-parse", "--show-toplevel"], directory)
    const root = top.code === 0 && top.out.trim() ? top.out.trim() : undefined
    const empty: ReviewSetupReport = {
      directory, forge: { reason: `${directory} is not a git checkout` }, permission: "unknown",
      base: { review: { exists: false, enabled: false, preset: "balanced", language: "English", fixMode: "review", push: false, publishers: "maintainers", tokensPerPr: 1_000_000, problems: [] }, workingTreeDiffers: false, registry: { exists: false, reviewers: [], routing: "implicit global reviewer", problems: [] } },
      hosted: { onBase: false, inWorkingTree: false }, watches: [], claims: { read: false, reason: "not a checkout", others: [] },
      personal: { exists: false, version: 0, reason: "not a checkout" }, codeowners: { patterns: [] }, maintainers: { lines: [] },
      role: { inferred: "unknown", basis: [], remembered: [], known: false }, missing: [], questions: [],
    }
    if (!root) {
      const remembered = deps.memoryEnabled?.(directory) === false ? [] : roleMemories(deps.memory, directory, undefined)
      const result = { ...empty, role: { ...empty.role, remembered, known: remembered.length > 0 } }
      return { ...result, missing: missingOf(result), questions: questionsOf(result) }
    }

    const found = await checkoutForge({ directory: root, git })
    const kind = found.kind
    const forge = { ...(kind ? { kind, name: forgeName(kind) } : {}), reason: found.reason }
    const github = kind === "github"
    const repo = github
      ? await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root) ?? (found.kind ? found.repo : undefined)
      : kind ? await remoteRepoOf({ directory: root, git, provider: kind }).catch(() => undefined) : undefined
    const rawLogin = github ? await gh(["api", "user", "--jq", ".login"], root) : undefined
    const login = rawLogin && LOGIN.test(rawLogin) ? rawLogin : undefined
    const loginProblem = !kind ? "no forge detected" : !github ? `${forgeName(kind)}: the login is not read by setup; ask the developer` : login ? undefined : "gh could not say the login (gh auth status)"

    const ref = await baseRef(root)
    const [reviewText, registryText, hostedText, owners, maintainers] = await Promise.all([
      show(root, ref, CONFIG_PATH),
      show(root, ref, REGISTRY_PATH),
      show(root, ref, HOSTED_WORKFLOW_FILE),
      (async () => { for (const file of CODEOWNERS_FILES) { const text = await show(root, ref, file); if (text !== undefined) return { file, text } } return undefined })(),
      (async () => { for (const file of MAINTAINER_FILES) { const text = await show(root, ref, file); if (text !== undefined) return { file, text } } return undefined })(),
    ])

    let raw: unknown = {}
    const reviewProblems: string[] = []
    if (reviewText !== undefined && reviewText.trim()) {
      try { raw = Bun.YAML.parse(reviewText) ?? {} } catch (error) { reviewProblems.push(`${CONFIG_PATH} on ${ref} is not valid YAML (${error instanceof Error ? error.message : "parse error"})`) }
    }
    const effective = effectiveConfig({ repository: reviewProblems.length ? undefined : raw })
    const workingFile = path.join(root, CONFIG_PATH)
    const working = existsSync(workingFile) ? readFileSync(workingFile, "utf8") : undefined
    const registryForge: RegistryForge = kind ?? "github"
    const registry = parseRegistry(registryText, registryForge)
    const config = effective.config

    const [permissionText, authoredText, reviewedText, commentsText] = github && repo && login ? await Promise.all([
      gh(["api", `repos/${repo}/collaborators/${login}/permission`], root),
      gh(["pr", "list", "--repo", repo, "--state", "all", "--author", login, "--limit", String(ACTIVITY_LIMIT), "--json", "number"], root),
      gh(["pr", "list", "--repo", repo, "--state", "all", "--search", `reviewed-by:${login}`, "--limit", String(ACTIVITY_LIMIT), "--json", "number"], root),
      gh(["api", `repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=${CLAIM_COMMENTS}`], root),
    ]) : [undefined, undefined, undefined, undefined]
    const permission: Permission = permissionText ? levelOf(json(permissionText)) : "unknown"
    const count = (text: string | undefined) => { const value = json(text); return Array.isArray(value) ? value.length : undefined }
    const authored = count(authoredText)
    const reviewed = count(reviewedText)
    const activity = authored !== undefined && reviewed !== undefined ? { authored, reviewed, limit: ACTIVITY_LIMIT } : undefined

    const comments = json(commentsText)
    const own = ownDevice()
    const claims: ReviewSetupReport["claims"] = !github ? { read: false, reason: `${kind ? forgeName(kind) : "this forge"}: claims are not read by setup`, others: [] }
      : !Array.isArray(comments) ? { read: false, reason: "the PR comments could not be read with gh", others: [] }
      : (() => {
          const parsed = parseClaims(comments.flatMap((comment) => { const item = IssueComment.safeParse(comment); return item.success && item.data.body ? [{ body: item.data.body, ...(item.data.user?.login ? { author: item.data.user.login } : {}) }] : [] }))
          const live = [...resolveClaims(parsed.filter((claim) => !repo || claim.repo.toLowerCase() === repo.toLowerCase()), now()).values()]
          return { read: true, others: live.filter((claim) => claim.owner !== own).slice(0, LIST_LIMIT).map((claim) => ({ number: claim.number, reviewer: claim.reviewer, device: claim.owner, expiresAt: claim.expiresAt })) }
        })()

    const personal: ReviewSetupReport["personal"] = (() => {
      if (!kind || !repo || !login) return { exists: false, version: 0, reason: !kind ? "no forge detected" : !repo ? "the repository could not be read" : "the login could not be read" }
      try {
        const key = { provider: kind, repo, login }
        const current = profiles.current(key)
        return { path: profiles.path(key), exists: current.exists, version: current.version, ...(current.problem ? { reason: current.problem } : {}) }
      } catch (error) { return { exists: false, version: 0, reason: error instanceof Error ? error.message : String(error) } }
    })()

    const patterns = owners && login ? codeownerPatterns(owners.text, login).slice(0, LIST_LIMIT) : []
    const maintainerLines = maintainers && login ? maintainers.text.split("\n").filter((line) => line.toLowerCase().includes(login.toLowerCase())).map((line) => clip(line.trim(), 160)).slice(0, 3) : []
    const listed = login ? registry.registry.reviewers.filter((entry) => entry.login?.toLowerCase() === login.toLowerCase()) : []
    const remembered = deps.memoryEnabled?.(directory) === false ? [] : roleMemories(deps.memory, directory, login)

    const basis = [
      ...(permission !== "unknown" && login && repo ? [`${login} has ${permission} permission on ${repo}`] : []),
      ...(patterns.length ? [`${owners!.file} lists @${login} for ${patterns.join(", ")}`] : []),
      ...(maintainerLines.length ? [`${maintainers!.file} mentions ${login}`] : []),
      ...listed.map((entry) => `${REGISTRY_PATH} lists ${login} as reviewer ${entry.id} (${entry.scope}${entry.areas.length ? `, areas ${entry.areas.join(", ")}` : ""})`),
      ...(activity && (activity.authored || activity.reviewed) ? [`recent PRs: authored ${activity.authored}${activity.authored >= ACTIVITY_LIMIT ? "+" : ""}, reviewed ${activity.reviewed}${activity.reviewed >= ACTIVITY_LIMIT ? "+" : ""}`] : []),
      ...remembered.map((line) => `${line.scope} memory ${line.id}: "${line.text}"`),
    ]
    const inferred = inferRole({ permission, codeowner: patterns.length > 0, maintainer: maintainerLines.length > 0, listedGlobal: listed.some((entry) => entry.scope === "global"), listedPersonal: listed.some((entry) => entry.scope === "personal"), activity })

    const result: ReviewSetupReport = {
      directory, root, forge, ...(repo ? { repo } : {}), ...(login ? { login } : {}), ...(loginProblem ? { loginProblem } : {}), permission,
      base: {
        ...(ref ? { ref } : {}),
        review: {
          exists: reviewText !== undefined, enabled: config.enabled, preset: effective.preset, language: config.template.language,
          fixMode: config.fix.mode, push: config.fix.push, publishers: Array.isArray(config.publishers) ? config.publishers.join(", ") : config.publishers,
          tokensPerPr: config.budget.tokens_per_pr ?? null, problems: [...reviewProblems, ...effective.problems].slice(0, LIST_LIMIT),
        },
        workingTreeDiffers: working !== reviewText,
        registry: {
          exists: registry.source === "file",
          reviewers: registry.registry.reviewers.slice(0, 20).map((entry) => ({ id: entry.id, scope: entry.scope, ...(entry.login ? { login: entry.login } : {}), areas: entry.areas.slice(0, 5) })),
          routing: registry.source === "file" ? `default ${registry.registry.routing.default ?? "(first global)"}, global ${registry.registry.routing.global}` : "implicit global reviewer",
          problems: registry.problems.slice(0, LIST_LIMIT),
        },
      },
      hosted: { onBase: hostedText !== undefined, inWorkingTree: existsSync(path.join(root, HOSTED_WORKFLOW_FILE)) },
      watches: watchesOf(deps.dataDir, root, repo),
      claims, personal,
      codeowners: { ...(owners ? { file: owners.file } : {}), patterns },
      maintainers: { ...(maintainers ? { file: maintainers.file } : {}), lines: maintainerLines },
      ...(activity ? { activity } : {}),
      role: { inferred, basis, remembered, known: basis.length > 0 },
      missing: [], questions: [],
    }
    return { ...result, missing: missingOf(result), questions: questionsOf(result) }
  }

  return {
    report,
    async run(directory: string): Promise<{ report: ReviewSetupReport; text: string }> {
      const result = await report(directory)
      return { report: result, text: setupText(result) }
    },
  }
}
export type ReviewSetup = ReturnType<typeof createReviewSetup>

const mayCommit = (permission: Permission) => WRITE_LEVELS.has(permission)

/** What the setup still lacks, in the order it is usually fixed. */
export function missingOf(report: ReviewSetupReport): string[] {
  if (!report.root) return [`${report.directory} is not a git checkout: open the session in a clone of the repository first`]
  const missing: string[] = []
  const review = report.base.review
  if (!report.forge.kind) missing.push(`no forge detected (${report.forge.reason}); a self-hosted GitLab or Gitea needs git config mendcode.forge`)
  if (report.loginProblem && report.forge.kind === "github") missing.push(`your login: ${report.loginProblem}`)
  if (!review.exists) missing.push(`no ${CONFIG_PATH} on the base branch${report.base.ref ? ` (${report.base.ref})` : ""}: nothing is posted until it is committed there with enabled: true`)
  else if (!review.enabled) missing.push(`${CONFIG_PATH} on the base branch does not say enabled: true, so nothing is posted`)
  if (review.problems.length) missing.push(`${CONFIG_PATH} has problems: ${review.problems.slice(0, 3).join("; ")}`)
  if (report.base.workingTreeDiffers) missing.push(`the working tree's ${CONFIG_PATH} differs from the base branch: it counts only once committed and merged there`)
  if (report.base.registry.problems.length) missing.push(`${REGISTRY_PATH} has problems (the implicit global reviewer is used): ${report.base.registry.problems.slice(0, 2).join("; ")}`)
  const personalOnes = report.base.registry.reviewers.filter((entry) => entry.scope === "personal")
  const globalWithoutLogin = report.base.registry.reviewers.some((entry) => entry.scope === "global" && !entry.login)
  if (report.base.registry.exists && personalOnes.length && globalWithoutLogin) missing.push(`${REGISTRY_PATH} has personal reviewers but a global reviewer without login: every daemon watching with all, laptops included, runs it`)
  const active = report.watches.filter((watch) => watch.state === "active")
  if (!active.length && !report.hosted.onBase) missing.push("nothing reviews PRs automatically yet: no repo watch on this daemon and no hosted workflow on the base branch")
  if (report.hosted.inWorkingTree && !report.hosted.onBase) missing.push(`${HOSTED_WORKFLOW_FILE} is in the working tree but not on the base branch`)
  for (const watch of report.watches) {
    if (watch.state !== "active") missing.push(`the watch of ${watch.directory} is ${watch.state}`)
    else if (watch.publish === "posting not answered yet") missing.push(`the watch of ${watch.directory} has no posting consent yet (/pr publish on)`)
  }
  if (report.permission !== "unknown" && !mayCommit(report.permission)) missing.push(`${report.login ?? "your login"} has ${report.permission} permission: the repository's files need someone with write access to commit them${report.base.review.publishers === "maintainers" ? ", and with publishers: maintainers this login's reviews stay in its session" : ""}`)
  if (!report.role.remembered.length) missing.push(report.role.known ? "your role is inferred, not confirmed: confirm it with the developer" : "your role on this repository is unknown: ask the developer")
  return missing
}

/** The questions for the developer, topology first; the model asks them one or two at a time. */
export function questionsOf(report: ReviewSetupReport): string[] {
  const repo = report.repo ?? "this repository"
  const github = report.forge.kind === "github"
  const role = report.role.known
    ? `Role: on ${repo} the signals point to ${report.role.inferred} (${report.role.basis.slice(0, 3).join("; ")}). Is that right, and do you set up the team's reviewer or only your own?`
    : `Role: nothing tells me your role on ${repo} yet. Are you a maintainer setting up the team's reviewer, a contributor who wants reviews of your own PRs, or new to the project?`
  const topology = [
    `Topology: who should review the PRs of ${repo}?`,
    ...(github ? ["(A) the hosted GitHub workflow only: no machine to keep on, but no fixes pushed, no checks, a provider API key as a repository secret;"] : []),
    "(B, recommended when laptops sleep) one always-on server as the global reviewer of every PR, plus optional personal reviewers on laptops;",
    "(C) personal reviewers only: each developer's MendCode, and a PR waits while its reviewer's laptop is off.",
  ].join(" ")
  const scope = report.permission !== "unknown" && !mayCommit(report.permission)
    ? `Global or individual: with ${report.permission} access you can set up your own personal reviewer here; the global one (${CONFIG_PATH}, ${REGISTRY_PATH}) needs a maintainer to commit it. Set up your personal reviewer, and draft the global files for a maintainer?`
    : `Global or individual: configure the global reviewer (shared by everyone, ${CONFIG_PATH} committed to the base branch) or only your own personal reviewer (this machine, may only narrow the repository's settings)?`
  return [
    role,
    scope,
    topology,
    `Posting: may MendCode post reviews on PRs as ${report.login ?? "your login"}? It posts only after /pr publish on (asked once per repository) and with enabled: true on the base branch; until then reviews stay in the session.`,
    `Language: reviews are in ${report.base.review.language} now. Keep English (the default), fix one language for everyone (template.language: a name), or auto (each PR author's language from the title and description, English fallback)? template.language is repository only.`,
    `Fixes: only review (fix.mode review, the default), fix confirmed findings once (fix-once) or until clean (fix-loop)? Pushing needs fix.push: true (and fix.personal for personal reviewers); a fix is never force-pushed or merged.`,
    `Budget: ${report.base.review.tokensPerPr === null ? "no internal cap" : `${report.base.review.tokensPerPr.toLocaleString("en-US")} tokens`} per PR head (budget.tokens_per_pr). Keep it, change it, or cap your personal reviewer lower?`,
  ]
}

const SETUP_RULES = [
  "How to run this setup: ask the questions above one or two at a time and wait for the answers; confirm the role with the developer instead of assuming it, and ask when nothing is known (a new user).",
  "Apply each choice through the path that asks the developer: review_config preview then apply with scope global (writes the working-tree .mendcode/review.yaml only; the developer commits and merges it) or scope personal (their profile). Propose .mendcode/reviewers.yaml as text and write it only after they approve; they commit it.",
  "Watches and posting consent are commands the developer runs in a local session on the daemon's machine: /pr on, /pr watch-repo all|requested, /pr publish on. The hosted workflow is `mendcode github install --hosted ... [--write]`, run and committed by them.",
  "After the developer confirms their role, offer to remember it (remember, scope project); save it only if they agree. Never write memory silently.",
  "To review one PR now, call pr_review with action review (or the developer runs /pr review <number>). Never post an @mendcode comment, or anything else, on the forge from the developer's account to trigger a review, and never post without their consent.",
]

const yesNo = (value: boolean) => value ? "yes" : "no"

/** The report as the tool's answer: facts first, then what is missing, the questions and the rules. */
export function setupText(report: ReviewSetupReport): string {
  const review = report.base.review
  const lines = [
    `PR reviewer setup for ${report.repo ?? report.root ?? report.directory}. Read only: nothing was changed.`,
    "",
    "Checkout:",
    `  directory: ${report.root ?? `${report.directory} (not a git checkout)`}`,
    `  forge: ${report.forge.name ?? "unknown"} (${report.forge.reason})`,
    `  login: ${report.login ?? `not read (${report.loginProblem ?? "unknown"})`}; permission: ${report.permission}`,
    "",
    `Repository config on the base branch (${report.base.ref ?? "no commit"}):`,
    `  ${CONFIG_PATH}: ${review.exists ? `present; enabled ${review.enabled}, preset ${review.preset}, language ${review.language}, fix.mode ${review.fixMode}${review.push ? " with push" : ""}, publishers ${review.publishers}, budget.tokens_per_pr ${review.tokensPerPr ?? "null"}` : "absent (the defaults apply: enabled false)"}`,
    ...(report.base.workingTreeDiffers ? [`  working tree: ${CONFIG_PATH} differs from the base branch (uncommitted or unmerged)`] : []),
    `  ${REGISTRY_PATH}: ${report.base.registry.exists ? `present; ${report.base.registry.reviewers.map((entry) => `${entry.id} (${entry.scope}${entry.login ? `, @${entry.login}` : ""}${entry.areas.length ? `, ${entry.areas.join(" ")}` : ""})`).join(", ")}; routing ${report.base.registry.routing}` : "absent (one implicit global reviewer)"}`,
    `  hosted workflow ${HOSTED_WORKFLOW_FILE}: on the base branch ${yesNo(report.hosted.onBase)}, in the working tree ${yesNo(report.hosted.inWorkingTree)}`,
    "",
    "On this daemon:",
    ...(report.watches.length ? report.watches.map((watch) => `  watch ${watch.directory}: ${watch.state}, reviewers ${watch.role ?? "(repo config)"}${watch.login ? ` as @${watch.login}` : ""}, ${watch.publish}`) : ["  no repo watch of this repository"]),
    `  personal profile: ${report.personal.path ? report.personal.exists ? `version ${report.personal.version} (${report.personal.path})` : `none yet (would be ${report.personal.path})` : `not available (${report.personal.reason ?? "unknown"})`}${report.personal.path && report.personal.reason ? `; problem: ${report.personal.reason}` : ""}`,
    `  other devices' claims on open PRs: ${!report.claims.read ? `not read (${report.claims.reason})` : report.claims.others.length ? report.claims.others.map((claim) => `#${claim.number} ${claim.reviewer} on device ${claim.device} until ${new Date(claim.expiresAt).toISOString()}`).join("; ") : "none"}`,
    "",
    "Role signals (confirm them with the developer; none is proof):",
    ...(report.role.basis.length ? report.role.basis.map((line) => `  - ${line}`) : ["  - none: no permission, CODEOWNERS, MAINTAINERS, reviewers.yaml entry, PR activity or saved memory names a role"]),
    `  inferred: ${report.role.inferred}`,
    "",
    "Still missing:",
    ...(report.missing.length ? report.missing.map((line) => `  - ${line}`) : ["  - nothing: the repository is set up"]),
    "",
    "Questions for the developer:",
    ...report.questions.map((question, index) => `  ${index + 1}. ${question}`),
    "",
    "Rules:",
    ...SETUP_RULES.map((rule) => `  - ${rule}`),
  ]
  return lines.join("\n")
}
