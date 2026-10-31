import { z } from "zod"
import type { GitRun } from "./context"
import type { Assignment, PrFacts, ReviewerEntry } from "./contracts"

/**
 * The repository's reviewer registry, `.mendcode/reviewers.yaml` on the base branch (docs/pr-review.md, decision 4 of the review
 * platform plan): who reviews here, which areas each covers, what each may do and how a pull request is routed. It is shared,
 * versioned and minimal: ids, logins, area globs, capabilities and an optional device. It never holds anyone's memory, profile or
 * credentials, so a global reviewer on a VPS knows who covers `src/api/**` without reading a developer's private data. The schema
 * is strict, so a `memory:` or `notes:` key is a problem, not something silently carried along.
 *
 * Read from the base branch like `review.yaml`: a pull request cannot add itself, or its author, as a reviewer. Routing is
 * deterministic (requested reviewers and assignees, labels, area globs, the global reviewer) and every assignment says why.
 */

export const REGISTRY_PATH = ".mendcode/reviewers.yaml"
const REGISTRY_LIMIT = 64 * 1024
const MAX_PROBLEMS = 10

const ReviewerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "lower-case letters, digits, '.', '_' or '-', at most 64")
/** The forge a checkout's registry is read for: the login syntax of its users. */
export type RegistryForge = "github" | "gitlab" | "gitea"
/**
 * A user's login as the forge spells it. GitHub: letters, digits and `-`, at most 39. GitLab and Gitea usernames may also hold
 * `_` and `.`, never `.` as the last character (GitLab's own pattern), at most 255.
 */
export const LOGIN_PATTERNS: Record<RegistryForge, { pattern: RegExp; text: string }> = {
  github: { pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, text: "a GitHub login (letters, digits and '-', at most 39)" },
  gitlab: { pattern: /^(?:[A-Za-z0-9_.][A-Za-z0-9._-]{0,253}[A-Za-z0-9_-]|[A-Za-z0-9_])$/, text: "a GitLab username (letters, digits, '_', '.' and '-', not ending with '.')" },
  gitea: { pattern: /^(?:[A-Za-z0-9_.][A-Za-z0-9._-]{0,253}[A-Za-z0-9_-]|[A-Za-z0-9_])$/, text: "a Gitea username (letters, digits, '_', '.' and '-', not ending with '.')" },
}
/** A device id as `device.ts` writes it (a UUID), or any short token a user wrote by hand. */
export const DeviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const Glob = z.string().min(1).max(300)
const Capability = z.enum(["review", "fix", "publish"])
/** Without a `capabilities` list a reviewer may review, fix and publish, as before the list was enforced (the repo config still decides). */
export const ALL_CAPABILITIES: ReviewerEntry["capabilities"] = ["review", "fix", "publish"]

const registryEntry = (forge: RegistryForge) => z.strictObject({
  id: ReviewerId,
  scope: z.enum(["global", "personal"]),
  login: z.string().regex(LOGIN_PATTERNS[forge].pattern, LOGIN_PATTERNS[forge].text).optional(),
  areas: z.array(Glob).max(50).default([]),
  /**
   * What the reviewer may do here: `review` (be assigned reviews), `fix` (automatic fix modes and `@mendcode fix`), `publish` (post
   * reviews and claims to the PR). The repository config (`fix.push`, `publishers`) still decides whether it happens.
   */
  capabilities: z.array(Capability).min(1).max(3).default(ALL_CAPABILITIES),
  device: z.string().regex(DeviceIdPattern).optional(),
})

const registrySchema = (forge: RegistryForge) => z.strictObject({
  version: z.literal(1).default(1),
  reviewers: z.array(registryEntry(forge)).max(200).default([]),
  routing: z.strictObject({
    /** The global reviewer every PR goes to; unset, the first global reviewer without areas (else the first global one). */
    default: ReviewerId.optional(),
    /** `always`: the default global reviewer takes every PR. `personal-only`: only a PR no personal reviewer matched (see `fallback`). */
    global: z.enum(["always", "personal-only"]).default("always"),
    /** With `personal-only`, who takes a PR no personal reviewer matched: a listed reviewer, or `none`. Unset: the default global one. */
    fallback: z.union([z.literal("none"), ReviewerId]).optional(),
    /** A label on the PR routes it to this reviewer. */
    labels: z.record(z.string().min(1).max(100), ReviewerId).default({}),
  }).default({ global: "always", labels: {} }),
})
type RegistryFile = z.infer<ReturnType<typeof registrySchema>>
const SCHEMAS = { github: registrySchema("github"), gitlab: registrySchema("gitlab"), gitea: registrySchema("gitea") } satisfies Record<RegistryForge, unknown>

export type ReviewerRegistry = {
  version: 1
  reviewers: ReviewerEntry[]
  routing: { default?: string | undefined; global: "always" | "personal-only"; fallback?: string | undefined; labels: Record<string, string> }
}

/** The reviewer a repository without `reviewers.yaml` has: today's single repository reviewer, which the repo config still governs. */
export const IMPLICIT_GLOBAL: ReviewerEntry = { id: "global", scope: "global", areas: [], capabilities: ["review", "fix", "publish"] }
export const DEFAULT_REGISTRY: ReviewerRegistry = { version: 1, reviewers: [IMPLICIT_GLOBAL], routing: { default: "global", global: "always", labels: {} } }

export type ParsedRegistry = { registry: ReviewerRegistry; problems: string[]; source: "file" | "default" }

/** The first line from which no longer prefix parses (Bun's YAML error names no line); the same search as `config.ts`. */
function errorLine(text: string): number {
  const lines = text.split("\n").slice(0, 2000)
  let line = lines.length
  for (let end = lines.length; end >= 1; end--) {
    try { Bun.YAML.parse(lines.slice(0, end).join("\n")); break } catch { line = end }
  }
  return line
}

/** References the schema cannot check: unique ids, a login for every personal reviewer, routing targets that exist. */
function semanticProblems(parsed: RegistryFile): string[] {
  const problems: string[] = []
  const ids = new Map<string, RegistryFile["reviewers"][number]>()
  parsed.reviewers.forEach((entry, index) => {
    if (ids.has(entry.id)) problems.push(`reviewers.${index}.id: duplicate reviewer "${entry.id}"`)
    else ids.set(entry.id, entry)
    if (entry.scope === "personal" && !entry.login) problems.push(`reviewers.${index}.login: a personal reviewer needs the login it belongs to`)
  })
  const known = (field: string, id: string) => { if (!ids.has(id)) problems.push(`${field}: unknown reviewer "${id}"`) }
  const { routing } = parsed
  if (routing.default !== undefined) {
    known("routing.default", routing.default)
    if (ids.get(routing.default)?.scope === "personal") problems.push(`routing.default: "${routing.default}" is a personal reviewer; the default must be global`)
  }
  if (routing.fallback !== undefined && routing.fallback !== "none") known("routing.fallback", routing.fallback)
  for (const [label, id] of Object.entries(routing.labels)) known(`routing.labels.${label}`, id)
  return problems
}

/** The default global reviewer: `routing.default`, else the first global one without areas, else the first global one. */
const defaultGlobalOf = (reviewers: readonly ReviewerEntry[], chosen: string | undefined) => {
  const globals = reviewers.filter((entry) => entry.scope === "global")
  return chosen ?? (globals.find((entry) => !entry.areas.length) ?? globals[0])?.id
}

/**
 * One YAML text as a registry. No file (or an empty list of reviewers) is the implicit global reviewer. A problem names the YAML
 * line or the field, and the whole registry falls back to the default: a typo never routes half a team. `forge` is the checkout's
 * (GitHub when unset): a `login` is checked against that forge's username syntax.
 */
export function parseRegistry(text: string | undefined, forge: RegistryForge = "github"): ParsedRegistry {
  if (text === undefined || !text.trim()) return { registry: DEFAULT_REGISTRY, problems: [], source: "default" }
  const fail = (problems: string[]): ParsedRegistry => ({ registry: DEFAULT_REGISTRY, problems: problems.slice(0, MAX_PROBLEMS).map((problem) => `[PR_REVIEW]: ${REGISTRY_PATH} ${problem}; the implicit global reviewer used`), source: "default" })
  if (text.length > REGISTRY_LIMIT) return fail([`is larger than ${REGISTRY_LIMIT / 1024} KB`])
  let raw: unknown
  try { raw = Bun.YAML.parse(text) } catch (error) {
    return fail([`line ${errorLine(text)}: ${error instanceof Error ? error.message.replace(/^YAML Parse error:\s*/, "") : "invalid YAML"}`])
  }
  const parsed = SCHEMAS[forge].safeParse(raw ?? {})
  if (!parsed.success) return fail(parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`))
  const problems = semanticProblems(parsed.data)
  if (problems.length) return fail(problems)
  if (!parsed.data.reviewers.length) return { registry: DEFAULT_REGISTRY, problems: [], source: "default" }
  const reviewers: ReviewerEntry[] = parsed.data.reviewers.map((entry) => ({ id: entry.id, scope: entry.scope, ...(entry.login ? { login: entry.login } : {}), areas: entry.areas, capabilities: [...new Set(entry.capabilities)], ...(entry.device ? { device: entry.device } : {}) }))
  const { routing } = parsed.data
  const fallbackId = routing.fallback
  const chosen = defaultGlobalOf(reviewers, routing.default)
  return {
    registry: { version: 1, reviewers, routing: { ...(chosen ? { default: chosen } : {}), global: routing.global, ...(fallbackId ? { fallback: fallbackId } : {}), labels: routing.labels } },
    problems: [],
    source: "file",
  }
}

/**
 * The registry on `ref` (the PR's base, never its head), read with `git show`; a missing file is the implicit global reviewer.
 * `forge`: the checkout's forge, whose username syntax a `login` follows (GitHub when unset).
 */
export async function readRegistry({ directory, ref, git, forge }: { directory: string; ref: string; git: GitRun; forge?: RegistryForge | undefined }): Promise<ParsedRegistry> {
  const done = await git(["show", `${ref}:${REGISTRY_PATH}`], directory)
  return parseRegistry(done.code === 0 ? done.out : undefined, forge)
}

/** Whether `entry` may do `capability`; no entry (a reviewer the registry no longer lists) keeps today's behaviour: it may. */
export const mayDo = (entry: Pick<ReviewerEntry, "capabilities"> | undefined, capability: ReviewerEntry["capabilities"][number]) => !entry || entry.capabilities.includes(capability)
/** Why `entry` does not do `capability`, in a sentence a person reads (a session notice, a PR reply). */
export const lacksText = (entry: Pick<ReviewerEntry, "id">, capability: ReviewerEntry["capabilities"][number]) =>
  `reviewer \`${entry.id}\` has no \`${capability}\` capability in \`${REGISTRY_PATH}\` on the base branch`

const sameLogin = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.replace(/^@/, "").toLowerCase()

/**
 * A reviewer named by a requester (`@mendcode review @alice`, `/pr review --reviewer backend`): its id or its login. Only a reviewer
 * the registry lists can be named, so neither a comment nor the PR's own content can authorise a reviewer the base branch does not
 * know. A login with several personal reviewers is ambiguous and refused: the requester names the id.
 */
export function resolveReviewer(registry: ReviewerRegistry, name: string): { ok: true; reviewer: ReviewerEntry } | { ok: false; reason: string } {
  const byId = registry.reviewers.find((entry) => entry.id === name)
  if (byId) return { ok: true, reviewer: byId }
  const byLogin = registry.reviewers.filter((entry) => sameLogin(entry.login, name))
  if (byLogin.length === 1) return { ok: true, reviewer: byLogin[0]! }
  if (byLogin.length > 1) return { ok: false, reason: `[PR_REVIEW]: ${name} has ${byLogin.length} reviewers here (${byLogin.map((entry) => entry.id).join(", ")}); name one by id` }
  return { ok: false, reason: `[PR_REVIEW]: ${JSON.stringify(name.slice(0, 100))} is not a reviewer in ${REGISTRY_PATH}` }
}

const globMatch = (pattern: string, file: string) => { try { return new Bun.Glob(pattern).match(file) } catch { return false } }
/** The reviewer's first area glob some changed file matches. */
const areaHit = (entry: ReviewerEntry, files: readonly string[]) => entry.areas.find((area) => files.some((file) => globMatch(area, file)))
const who = (entry: ReviewerEntry) => entry.login ? `${entry.id}: @${entry.login}` : entry.id

/**
 * Which reviewers take a pull request and why, from shared facts only (the PR, its changed files, the base branch's registry).
 * In registry order, one assignment per reviewer, reasons joined:
 * - a requested reviewer or an assignee whose login maps to a personal reviewer ("review requested from @alice", "assigned to
 *   @alice"); a login with several personal reviewers goes to those whose areas the change touches, else the first listed;
 * - a label route ("label security → sec");
 * - an area glob a changed file matches ("touches src/api/** (backend: @alice)");
 * - `target`, a reviewer a requester named (`requesterLogin` asked): only a listed one, an unknown name adds nothing;
 * - the default global reviewer, always, unless `routing.global` is `personal-only`: then only when no personal reviewer was
 *   assigned, and as `routing.fallback` says.
 * A reviewer without the `review` capability is never assigned a review. Requested logins the registry does not list are ignored.
 */
export function route({ facts, files, registry, requesterLogin, target }: { facts: PrFacts; files: readonly string[]; registry: ReviewerRegistry; requesterLogin?: string | undefined; target?: string | undefined }): Assignment[] {
  const reviewing = registry.reviewers.filter((entry) => entry.capabilities.includes("review"))
  const reasons = new Map<string, { reasons: string[]; areas: string[] }>()
  const add = (entry: ReviewerEntry, reason: string, area?: string) => {
    const found = reasons.get(entry.id) ?? { reasons: [], areas: [] }
    if (!found.reasons.includes(reason)) found.reasons.push(reason)
    if (area && !found.areas.includes(area)) found.areas.push(area)
    reasons.set(entry.id, found)
  }
  const personalOf = (login: string) => {
    const own = reviewing.filter((entry) => entry.scope === "personal" && sameLogin(entry.login, login))
    if (own.length <= 1) return own
    const touching = own.filter((entry) => areaHit(entry, files))
    return touching.length ? touching : own.slice(0, 1)
  }
  const asked = [...new Set(facts.requested.map((login) => login.toLowerCase()))].sort()
  for (const login of asked) for (const entry of personalOf(login)) add(entry, `review requested from @${entry.login}`)
  const assigned = [...new Set(facts.assignees.map((login) => login.toLowerCase()))].sort()
  for (const login of assigned) for (const entry of personalOf(login)) add(entry, `assigned to @${entry.login}`)
  for (const label of [...new Set(facts.labels)].sort()) {
    const entry = reviewing.find((candidate) => candidate.id === registry.routing.labels[label])
    if (entry) add(entry, `label ${label} → ${entry.id}`)
  }
  for (const entry of reviewing) {
    const area = areaHit(entry, files)
    if (area) add(entry, `touches ${area} (${who(entry)})`, area)
  }
  if (target !== undefined) {
    const named = resolveReviewer(registry, target)
    if (named.ok && named.reviewer.capabilities.includes("review")) add(named.reviewer, requesterLogin ? `@${requesterLogin.replace(/^@/, "")} asked for ${named.reviewer.id}` : `asked for ${named.reviewer.id}`)
  }
  const defaultGlobal = reviewing.find((entry) => entry.id === registry.routing.default && entry.scope === "global")
  const personalAssigned = reviewing.some((entry) => entry.scope === "personal" && reasons.has(entry.id))
  if (registry.routing.global === "always") {
    if (defaultGlobal) add(defaultGlobal, "the repository's global reviewer")
  } else if (!personalAssigned && registry.routing.fallback !== "none") {
    const fallback = reviewing.find((entry) => entry.id === (registry.routing.fallback ?? registry.routing.default))
    if (fallback) add(fallback, "no personal reviewer matches; fallback")
  }
  return reviewing.flatMap((entry) => {
    const found = reasons.get(entry.id)
    return found ? [{ reviewer: entry.id, scope: entry.scope, reason: found.reasons.join("; "), areas: found.areas }] : []
  })
}

/** Whether this daemon (its device id and gh login) runs `reviewer`: a pinned device must be this one; otherwise the login must match (a global reviewer without a login runs wherever the repository's watch runs). */
export function runsHere(reviewer: ReviewerEntry, here: { device: string; login?: string | undefined }): boolean {
  if (reviewer.device) return reviewer.device === here.device
  if (reviewer.scope === "personal") return sameLogin(reviewer.login, here.login)
  return !reviewer.login || sameLogin(reviewer.login, here.login)
}
