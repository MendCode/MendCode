import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PrReviewConfigView } from "@mendcode/protocol"
import { CONFIG_PATH } from "./config"
import { checkLayer, effectiveConfig, patchLayer, restrictLayer, type ConfigLayer, type EffectiveConfig } from "./config-layers"
import { gitRun, type GitRun } from "./context"
import type { ProviderKind } from "./contracts"
import { createProfileStore, type ProfileKey, type ProfileStore } from "./profile-store"

/**
 * The `pr.review` configuration actions (`config-show`, `config-preview`, `config-apply`, `config-revert`, `config-history`) and
 * the `review_config` tool behind them (docs/pr-review.md, conversational config). `scope` decides the target and is never
 * guessed: without it nothing is read as either and the answer names both targets and what exists, so "my review" can never
 * change the repository's reviewer.
 *
 * - `global`: the checkout's `.mendcode/review.yaml` working-tree file. Apply and revert write that file only; they never stage,
 *   commit or push, and the repository's reviewer uses it once it is committed and on the base branch. Its version is the number
 *   of commits that touched the file, plus one while the working tree differs from `HEAD` (an integer, as the view needs, and
 *   readable with `git log -- .mendcode/review.yaml`). History lists those commits oldest = 1, and the uncommitted state.
 * - `personal`: this user's profile for (provider, repository, login) in the profile store, versioned by the store. Its
 *   effective config sits over the repository's committed file (`origin/HEAD`, else `HEAD`), which it may only narrow.
 *
 * A patch's top-level keys replace, `null` removes a key (global) or an override (personal). Every answer is a
 * `PrReviewConfigView` checked with the protocol schema; problems block an apply or revert only when they are about the result.
 */

export type ConfigControlAction = "config-show" | "config-preview" | "config-apply" | "config-revert" | "config-history"
export type ConfigScope = "global" | "personal"
export type ConfigControlRequest = {
  action: ConfigControlAction
  scope?: ConfigScope | undefined
  /** The checkout (any directory inside it). */
  directory: string
  patch?: Record<string, unknown> | undefined
  version?: number | undefined
  /** The history line of an apply; unset, one is made from the patch's keys. */
  summary?: string | undefined
  /** `config-revert` only: before, after and problems of the revert without writing (the tool's approval preview). */
  dryRun?: boolean | undefined
}
export type ConfigControlDeps = {
  dataDir: string
  /** `owner/repo` of the checkout on the provider (`gh repo view`); undefined when it cannot say. */
  repo(directory: string): Promise<string | undefined>
  /** The user's login on the provider (`gh api user`); undefined when it cannot say. */
  login(directory: string): Promise<string | undefined>
  git?: GitRun | undefined
  now?: (() => number) | undefined
  provider?: ProviderKind | undefined
  profiles?: ProfileStore | undefined
}
export type ConfigControlResult =
  | { ok: true; text: string; config: PrReviewConfigView }
  | { ok: false; text: string; problems: string[]; config?: PrReviewConfigView | undefined }

const MAX_PATCH_KEYS = 40
const TEXT_LIMIT = 65_536
const VIEW_PROBLEMS = 20
const PROBLEM_LENGTH = 400
const VALUE_WIDTH = 140

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text
const failure = (text: string, problems: string[] = [text], config?: PrReviewConfigView): ConfigControlResult => ({ ok: false, text, problems, ...(config ? { config } : {}) })

/** The view, bounded to the protocol's limits and checked by its schema (a mismatch is a bug here, so it throws). */
function view(input: { scope: ConfigScope; target: string; repo?: string | undefined; login?: string | undefined; version: number; effective: EffectiveConfig; before?: string | undefined; after?: string | undefined; problems?: string[]; history?: Array<{ version: number; at: number; summary: string }> }): PrReviewConfigView {
  const problems = [...new Set(input.problems ?? [])]
  return PrReviewConfigView.parse({
    scope: input.scope,
    target: clip(input.target, 4096),
    ...(input.repo ? { repo: clip(input.repo, 200) } : {}),
    ...(input.login ? { login: clip(input.login, 100) } : {}),
    version: input.version,
    effective: input.effective.config as Record<string, unknown>,
    origins: input.effective.origins,
    ...(input.before !== undefined ? { before: clip(input.before, TEXT_LIMIT) } : {}),
    ...(input.after !== undefined ? { after: clip(input.after, TEXT_LIMIT) } : {}),
    ...(problems.length ? { problems: [...problems.slice(0, VIEW_PROBLEMS - (problems.length > VIEW_PROBLEMS ? 1 : 0)).map((problem) => clip(problem, PROBLEM_LENGTH)), ...(problems.length > VIEW_PROBLEMS ? [`… ${problems.length - VIEW_PROBLEMS + 1} more problems`] : [])] } : {}),
    ...(input.history ? { history: input.history.slice(0, 50).map((entry) => ({ ...entry, summary: clip(entry.summary, 200) })) } : {}),
  })
}

/** One line per top-level key: its effective value and the layer it came from. */
export function describeEffective(effective: EffectiveConfig): string[] {
  return Object.entries(effective.config).map(([key, value]) => `  ${key}: ${clip(JSON.stringify(value), VALUE_WIDTH)}  (${effective.origins[key as keyof typeof effective.origins]})`)
}

const yamlOf = (layer: ConfigLayer) => Object.keys(layer).length ? Bun.YAML.stringify(layer, null, 2).replace(/[ \t]+$/gm, "") + "\n" : ""
const jsonOf = (layer: ConfigLayer) => `${JSON.stringify(layer, null, 2)}\n`

/** A YAML text as a raw layer: `null` (empty or comments only) is `{}`; a parse error names its message. */
function parseYaml(text: string | undefined): { raw?: unknown; problem?: string } {
  if (text === undefined || !text.trim()) return { raw: {} }
  try { return { raw: Bun.YAML.parse(text) ?? {} } } catch (error) {
    return { problem: `[PR_REVIEW]: ${CONFIG_PATH} is not valid YAML (${error instanceof Error ? error.message.replace(/^YAML Parse error:\s*/, "") : "parse error"}); fix it by hand first` }
  }
}

function checkPatch(patch: Record<string, unknown> | undefined): string | undefined {
  if (!patch || !Object.keys(patch).length) return "[PR_REVIEW]: the patch is empty: name the keys to set (or null to remove)"
  if (Object.keys(patch).length > MAX_PATCH_KEYS) return `[PR_REVIEW]: the patch names more than ${MAX_PATCH_KEYS} keys`
  return undefined
}

const patchSummary = (patch: Record<string, unknown>) => {
  const set = Object.keys(patch).filter((key) => patch[key] !== null)
  const removed = Object.keys(patch).filter((key) => patch[key] === null)
  return [set.length ? `set ${set.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")
}

export function createConfigControl(deps: ConfigControlDeps) {
  const git = deps.git ?? gitRun
  const now = deps.now ?? Date.now
  const provider = deps.provider ?? "github"
  const profiles = deps.profiles ?? createProfileStore({ dataDir: deps.dataDir, now })

  const rootOf = async (directory: string) => {
    const done = await git(["rev-parse", "--show-toplevel"], directory)
    return done.code === 0 && done.out.trim() ? done.out.trim() : undefined
  }
  const showAt = async (root: string, ref: string) => {
    const done = await git(["show", `${ref}:${CONFIG_PATH}`], root)
    return done.code === 0 ? done.out : undefined
  }

  /** The global file as git and the working tree know it. */
  const globalState = async (root: string) => {
    const file = path.join(root, CONFIG_PATH)
    const working = existsSync(file) ? readFileSync(file, "utf8") : undefined
    const logged = await git(["log", "--format=%H%x09%ct%x09%s", "--", CONFIG_PATH], root)
    const commits = (logged.code === 0 ? logged.out : "").split("\n").filter(Boolean).map((line) => {
      const [sha = "", at = "0", ...subject] = line.split("\t")
      return { sha, at: Number(at) * 1000, summary: subject.join("\t").trim() || sha.slice(0, 12) }
    }).reverse()
    const head = commits.length ? await showAt(root, "HEAD") : undefined
    const dirty = working !== head
    const version = commits.length + (dirty ? 1 : 0)
    const history = [
      ...commits.map((commit, index) => ({ version: index + 1, at: commit.at, summary: commit.summary })),
      ...(dirty ? [{ version, at: working !== undefined ? Math.floor(statSync(file).mtimeMs) : now(), summary: working !== undefined ? "uncommitted change in the working tree" : "file removed in the working tree" }] : []),
    ].reverse()
    return { file, working, commits, dirty, version, history }
  }

  /** The repository layer a personal reviewer stands on: the committed file of the default branch, else of `HEAD`. */
  const committedRepository = async (root: string): Promise<{ ref?: string | undefined; raw?: unknown; problem?: string | undefined }> => {
    for (const ref of ["origin/HEAD", "HEAD"]) {
      const text = await showAt(root, ref)
      if (text !== undefined) return { ref, ...parseYaml(text) }
    }
    return { raw: {} }
  }

  const writeGlobal = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    writeFileSync(temp, text, { mode: 0o644, flag: "wx" })
    renameSync(temp, file)
  }

  const personalKey = async (directory: string): Promise<{ key: ProfileKey } | { problem: string }> => {
    const [repo, login] = await Promise.all([deps.repo(directory).catch(() => undefined), deps.login(directory).catch(() => undefined)])
    if (!repo || !login) return { problem: `[PR_REVIEW]: a personal profile needs the repository and your ${provider} login; ${!repo ? "the repository of this checkout" : "your login"} could not be read (gh auth status)` }
    try { profiles.path({ provider, repo, login }) } catch (error) { return { problem: error instanceof Error ? error.message : String(error) } }
    return { key: { provider, repo, login } }
  }

  /** Both targets and what exists, for a request without `scope`. */
  async function ambiguity(directory: string): Promise<ConfigControlResult> {
    const root = await rootOf(directory)
    const global = root ? await globalState(root) : undefined
    const globalLine = !root ? `not available: ${directory} is not a git checkout`
      : global!.version === 0 ? `${global!.file} does not exist yet (the defaults apply)`
      : `${global!.file}, version ${global!.version} (${global!.commits.length} commit${global!.commits.length === 1 ? "" : "s"}${global!.dirty ? ", uncommitted changes in the working tree" : ""})`
    const personal = await personalKey(directory)
    const current = "key" in personal ? profiles.current(personal.key) : undefined
    const personalLine = "problem" in personal ? `not available: ${personal.problem.replace("[PR_REVIEW]: ", "")}`
      : current!.exists ? `your profile for ${personal.key.repo} as ${personal.key.login}, version ${current!.version} (${profiles.path(personal.key)})`
      : `no profile yet for ${personal.key.repo} as ${personal.key.login}; it would be ${profiles.path(personal.key)}`
    const text = [
      "Which reviewer's config? Say scope global or personal; nothing was read as either or changed.",
      `- global: the repository's reviewer, ${globalLine}. Applying writes that working-tree file only (never a commit); it counts once committed on the base branch.`,
      `- personal: your own reviewer, ${personalLine}. It may narrow the repository's config for your reviewer only.`,
    ].join("\n")
    return failure(text, ["[PR_REVIEW]: scope is required (global or personal)"])
  }

  async function globalAction(request: ConfigControlRequest): Promise<ConfigControlResult> {
    const root = await rootOf(request.directory)
    if (!root) return failure(`[PR_REVIEW]: ${request.directory} is not a git checkout; the global config is its .mendcode/review.yaml`)
    const repo = await deps.repo(request.directory).catch(() => undefined)
    const state = await globalState(root)
    const current = parseYaml(state.working)
    const currentEffective = effectiveConfig({ repository: current.problem ? undefined : current.raw })
    const base = { scope: "global" as const, target: state.file, repo }
    const notCommitted = "Written to the working tree only: not staged, not committed, not pushed. The repository's reviewer uses it once it is committed and on the base branch."

    if (request.action === "config-show" || request.action === "config-history") {
      const problems = [...(current.problem ? [current.problem] : []), ...currentEffective.problems]
      const config = view({ ...base, version: state.version, effective: currentEffective, problems, ...(request.action === "config-history" ? { history: state.history } : {}) })
      const text = request.action === "config-history"
        ? [`Global reviewer config history, ${state.file} (newest first):`, ...state.history.map((entry) => `  v${entry.version}  ${new Date(entry.at).toISOString()}  ${entry.summary}`), ...(state.history.length ? [] : ["  (no versions: the file was never committed and does not exist)"])].join("\n")
        : [`Global reviewer config, ${state.file}, version ${state.version}${state.dirty ? " (uncommitted changes)" : ""}; preset ${currentEffective.preset}. Effective values and origins:`, ...describeEffective(currentEffective), ...problems.map((problem) => `Problem: ${problem}`)].join("\n")
      return { ok: true, text, config }
    }

    let afterText: string
    let summary: string
    if (request.action === "config-revert") {
      if (request.version === undefined) return failure("[PR_REVIEW]: config-revert needs version (see config-history)")
      if (request.version === state.version) return failure(`[PR_REVIEW]: version ${request.version} is the current one; nothing to revert`)
      const commit = request.version >= 1 ? state.commits[request.version - 1] : undefined
      if (!commit) return failure(`[PR_REVIEW]: global version ${request.version} does not exist (committed versions are 1 to ${state.commits.length})`)
      const old = await showAt(root, commit.sha)
      afterText = old ?? `# Version ${request.version} removed ${CONFIG_PATH}; reverted to the defaults.\n`
      summary = `revert to version ${request.version}`
    } else {
      const patchProblem = checkPatch(request.patch)
      if (patchProblem) return failure(patchProblem)
      if (current.problem) return failure(current.problem)
      const raw = current.raw && typeof current.raw === "object" && !Array.isArray(current.raw) ? current.raw as ConfigLayer : undefined
      if (!raw) return failure(`[PR_REVIEW]: ${CONFIG_PATH} is not a mapping of keys; fix it by hand first`)
      afterText = yamlOf(patchLayer(raw, request.patch!))
      summary = request.summary ?? patchSummary(request.patch!)
    }

    const after = parseYaml(afterText)
    const checked = after.problem ? { layer: {}, problems: [after.problem] } : checkLayer(after.raw, "repository")
    const afterEffective = effectiveConfig({ repository: checked.layer })
    const blocking = request.action === "config-revert" ? (after.problem ? [after.problem] : []) : checked.problems
    const comments = state.working && /^\s*#/m.test(state.working) && request.action !== "config-revert" ? ["Comments in the file are not kept when MendCode rewrites it."] : []
    const preview = request.action === "config-preview" || (request.action === "config-revert" && request.dryRun === true)
    const blocked = blocking.length > 0
    if (!preview && !blocked) writeGlobal(state.file, afterText)
    const written = !preview && !blocked ? await globalState(root) : state
    const config = view({ ...base, version: written.version, effective: afterEffective, before: state.working ?? "", after: afterText, problems: [...checked.problems, ...afterEffective.problems.filter((problem) => !checked.problems.includes(problem))] })
    const lines = [
      preview ? `Preview (${summary}) of ${state.file}; nothing written.` : blocked ? `Not written (${summary}): fix the problems first.` : `Wrote ${state.file} (${summary}), now version ${written.version}. ${notCommitted}`,
      ...(preview ? [notCommitted.replace("Written to", "Applying writes")] : []),
      ...comments,
      "Effective after it:",
      ...describeEffective(afterEffective),
      ...[...new Set([...checked.problems, ...afterEffective.problems])].map((problem) => `Problem: ${problem}`),
    ]
    return blocked && !preview ? failure(lines.join("\n"), blocking, config) : { ok: true, text: lines.join("\n"), config }
  }

  async function personalAction(request: ConfigControlRequest): Promise<ConfigControlResult> {
    const resolved = await personalKey(request.directory)
    if ("problem" in resolved) return failure(resolved.problem)
    const { key } = resolved
    const root = await rootOf(request.directory)
    const repository = root ? await committedRepository(root) : { raw: {} }
    const repositoryRaw = repository.problem ? undefined : repository.raw
    const repositoryProblems = repository.problem ? [repository.problem] : []
    const stored = profiles.current(key)
    const storeProblems = stored.problem ? [stored.problem] : []
    const target = profiles.path(key)
    const base = { scope: "personal" as const, target, repo: key.repo, login: key.login }
    const standsOn = repository.ref ? `over the repository's ${CONFIG_PATH} at ${repository.ref}` : `over the defaults (no ${CONFIG_PATH} is committed)`
    const effectiveNow = effectiveConfig({ repository: repositoryRaw, personal: stored.config })

    if (request.action === "config-show" || request.action === "config-history") {
      const history = profiles.history(key)
      const problems = [...repositoryProblems, ...storeProblems, ...effectiveNow.problems]
      const config = view({ ...base, version: stored.version, effective: effectiveNow, problems, ...(request.action === "config-history" ? { history } : {}) })
      const text = request.action === "config-history"
        ? [`Your reviewer profile history for ${key.repo} as ${key.login}, ${target} (newest first):`, ...history.map((entry) => `  v${entry.version}  ${new Date(entry.at).toISOString()}  ${entry.summary}`), ...(history.length ? [] : ["  (no versions yet)"])].join("\n")
        : [`Your reviewer profile for ${key.repo} as ${key.login}, ${stored.exists ? `version ${stored.version}` : "none yet"} (${target}), ${standsOn}. Effective values and origins:`, ...describeEffective(effectiveNow), ...problems.map((problem) => `Problem: ${problem}`)].join("\n")
      return { ok: true, text, config }
    }

    let next: ConfigLayer
    let summary: string
    let blocking: string[]
    if (request.action === "config-revert") {
      if (request.version === undefined) return failure("[PR_REVIEW]: config-revert needs version (see config-history)")
      if (request.version === stored.version) return failure(`[PR_REVIEW]: version ${request.version} is the current one; nothing to revert`)
      const old = profiles.version(key, request.version)
      if (!old) return failure(`[PR_REVIEW]: your profile has no version ${request.version} in its kept history`)
      next = old.config
      summary = `revert to version ${request.version}`
      blocking = checkLayer(next, "personal").problems
    } else {
      const patchProblem = checkPatch(request.patch)
      if (patchProblem) return failure(patchProblem)
      next = patchLayer(stored.config, request.patch!)
      summary = request.summary ?? patchSummary(request.patch!)
      const structural = checkLayer(next, "personal").problems
      const upToRepository = effectiveConfig({ repository: repositoryRaw }).config
      const patched = Object.fromEntries(Object.keys(request.patch!).filter((name) => request.patch![name] !== null && name in next).map((name) => [name, next[name]]))
      // Only the keys this patch sets can block it: an older override the repository has since narrowed is shown, not a blocker.
      blocking = [...structural, ...restrictLayer(upToRepository, checkLayer(patched, "personal").layer, "personal").problems]
    }

    const afterEffective = effectiveConfig({ repository: repositoryRaw, personal: next })
    const preview = request.action === "config-preview" || (request.action === "config-revert" && request.dryRun === true)
    const blocked = blocking.length > 0
    const saved = !preview && !blocked ? request.action === "config-revert" ? profiles.revert(key, request.version!, summary) : profiles.save(key, { config: next, summary }) : undefined
    const problems = [...repositoryProblems, ...storeProblems, ...blocking, ...afterEffective.problems]
    const config = view({ ...base, version: saved?.version ?? stored.version, effective: afterEffective, before: jsonOf(stored.config), after: jsonOf(next), problems })
    const lines = [
      preview ? `Preview (${summary}) of your reviewer profile for ${key.repo} as ${key.login}; nothing saved.` : blocked ? `Not saved (${summary}): the repository does not allow it or the value is invalid.` : `Saved your reviewer profile for ${key.repo} as ${key.login} (${summary}), now version ${saved!.version}. The repository's global reviewer is unchanged.`,
      `It applies ${standsOn}. Effective after it:`,
      ...describeEffective(afterEffective),
      ...[...new Set(problems)].map((problem) => `Problem: ${problem}`),
    ]
    return blocked && !preview ? failure(lines.join("\n"), blocking, config) : { ok: true, text: lines.join("\n"), config }
  }

  return {
    async run(request: ConfigControlRequest): Promise<ConfigControlResult> {
      if (request.scope === undefined) return ambiguity(request.directory)
      if (request.scope !== "global" && request.scope !== "personal") return failure(`[PR_REVIEW]: scope must be global or personal, not ${JSON.stringify(String(request.scope).slice(0, 40))}`)
      try {
        return request.scope === "global" ? await globalAction(request) : await personalAction(request)
      } catch (error) {
        return failure(error instanceof Error ? (error.message.startsWith("[PR_REVIEW]:") ? error.message : `[PR_REVIEW]: ${error.message}`) : `[PR_REVIEW]: ${String(error)}`)
      }
    },
  }
}
export type ConfigControl = ReturnType<typeof createConfigControl>
