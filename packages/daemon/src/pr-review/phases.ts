import type { PrFinding, PrStopReason } from "@mendcode/protocol"
import type { ReviewConfig } from "./config"
import type { ReviewContext } from "./context"
import type { JobCheckpoint, PhaseFacts, PhasePlan } from "./contracts"

/**
 * The stages a review goes through (docs/pr-review.md, phases; locked decision 9). A stage is never a new model call with its own
 * tools: the stages before `corroboration` are instructions in the one review pass, `corroboration` is the verify pass, `fix` is the
 * fix session (only when `fix.mode` is not `review`) and `validation` is a deterministic gate (complete, verified, checks passed, no
 * open confirmed finding when fixing). So a phase cannot widen what a review may do: its config has an id, a prompt and a condition,
 * nothing else, and the controls (`analysis`, `corroboration`, `validation`, `fix` when enabled) cannot be removed by a list.
 *
 * - `none`: no visible stages; the plan still holds the operational states the job moves through, and the UI hides them.
 * - `fixed`: `phases.list` as given (in its order), with the controls added back where the list leaves them out.
 * - `dynamic` (default): the preset discovery → analysis → corroboration → fix → validation, the list's changes to it, and stages
 *   chosen from evidence (migrations, security, contracts, stack), each recorded with its reason.
 */

export const PRESET_PHASES = ["discovery", "analysis", "corroboration", "fix", "validation"] as const
export const DYNAMIC_PHASES = ["migrations", "security", "contracts", "stack"] as const
/** Stages a list cannot remove: without them a review publishes unverified findings or closes without validation. */
const REQUIRED = new Set(["analysis", "corroboration", "validation"])

/** What each built-in stage asks of the review pass; a list entry's `prompt` replaces it. */
export const PHASE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  discovery: "First map the change's scope: what each changed file does, which callers and contracts it reaches and what it leaves untouched; then review in that order.",
  migrations: "Check migrations and schema changes: reversibility, data loss, locks on large tables, defaults for existing rows, and that code and schema can deploy in either order.",
  security: "Check security: authentication and permission checks on every new path, secrets never logged or returned, input validated at the boundary, crypto used as its library intends.",
  contracts: "Check contracts: changes to protocol, API or schema types stay compatible with existing clients and stored data, or the break is versioned and every caller updated.",
  stack: "This pull request is stacked on another one: review only its own commits; a problem that comes from the parent belongs to the parent's review.",
}

/** Built-ins first by their place; a stage of the user's own sits after analysis and before corroboration (it runs in the review pass). */
const RANK: Readonly<Record<string, number>> = { discovery: 0, analysis: 1, corroboration: 3, fix: 4, validation: 5 }
const rankOf = (id: string) => RANK[id] ?? 2

type ListEntry = ReviewConfig["phases"]["list"][number]
type Phase = PhasePlan["phases"][number]
type Decision = JobCheckpoint["decisions"][number]

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const
const matches = (pattern: string, file: string) => { try { return new Bun.Glob(pattern).match(file) } catch { return false } }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const listed = (files: readonly string[]) => `${files.slice(0, 3).map((file) => `\`${file}\``).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`

/** The facts a plan reads from a review's context: changed files and how many lines changed. Risk and stacking come from the caller. */
export function phaseFacts({ context, fixMode, stacked = false, risk }: { context: Pick<ReviewContext, "files">; fixMode: PhaseFacts["fixMode"]; stacked?: boolean; risk?: PhaseFacts["risk"] }): PhaseFacts {
  return { files: context.files.map((file) => file.path), changedLines: context.files.reduce((sum, file) => sum + file.touched.length, 0), stacked, fixMode, ...(risk ? { risk } : {}) }
}

/** Whether a list entry's `when` holds (every condition given must), and in words why or why not. */
export function conditionMet(when: ListEntry["when"], facts: PhaseFacts): { met: boolean; reason: string } {
  if (!when) return { met: true, reason: "no condition" }
  const parts: Array<{ met: boolean; text: string }> = []
  if (when.paths?.length) {
    const hit = facts.files.filter((file) => when.paths!.some((pattern) => matches(pattern, file)))
    parts.push({ met: hit.length > 0, text: hit.length ? `${listed(hit)} match ${when.paths.join(", ")}` : `no changed file matches ${when.paths.join(", ")}` })
  }
  if (when.min_lines !== undefined) parts.push({ met: facts.changedLines >= when.min_lines, text: `${plural(facts.changedLines, "changed line")} (at least ${when.min_lines} asked)` })
  if (when.risk) parts.push({ met: !!facts.risk && RISK_RANK[facts.risk] >= RISK_RANK[when.risk], text: facts.risk ? `risk ${facts.risk} (at least ${when.risk} asked)` : `risk unknown (at least ${when.risk} asked)` })
  return { met: parts.every((part) => part.met), reason: parts.map((part) => part.text).join("; ") || "no condition" }
}

const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic|flyway|liquibase)(\/|$)|\.sql$|(^|\/)schema\.(prisma|rb|sql)$/i
const SECURITY_PATH = /(^|[/._-])(auth|authn|authz|authentication|authorization|authorize|oauth|crypto|cryptography|secrets?|permissions?|credentials?|passwords?|jwt|rbac|acl)(?=[/._-]|$)/i
const CONTRACT_PATH = /(^|[/._-])(protocol|api|openapi|swagger|proto|schema|schemas|contracts?|graphql)(?=[/._-]|$)|\.(proto|graphql|gql|avsc)$/i

/** The evidence for one dynamic stage, or undefined when the change gives none. */
function evidenceFor(id: (typeof DYNAMIC_PHASES)[number], facts: PhaseFacts): string | undefined {
  const hit = (pattern: RegExp) => facts.files.filter((file) => pattern.test(file))
  if (id === "migrations") { const files = hit(MIGRATION_PATH); return files.length ? `${listed(files)} ${files.length === 1 ? "is a" : "are"} migration or schema path${files.length === 1 ? "" : "s"}` : undefined }
  if (id === "security") {
    const files = hit(SECURITY_PATH)
    if (files.length) return `${listed(files)} ${files.length === 1 ? "touches" : "touch"} authentication, permissions, secrets or crypto`
    return facts.risk === "high" ? "the change's risk is high" : undefined
  }
  if (id === "contracts") { const files = hit(CONTRACT_PATH); return files.length ? `${listed(files)} ${files.length === 1 ? "is a" : "are"} protocol, API or schema file${files.length === 1 ? "" : "s"}` : undefined }
  return facts.stacked ? "the pull request is stacked on another open pull request" : undefined
}

/**
 * Problems of a `phases.list` for `mode`, for a config preview and for `planPhases` (which then falls back to the preset): a
 * duplicate id (a stage cannot run twice, so the order has no cycle), `analysis` missing or disabled, built-in stages out of their
 * order, or a stage of the user's own after `corroboration` (its prompt runs in the review pass, before verification).
 */
export function checkPhaseList(list: readonly ListEntry[], mode: ReviewConfig["phases"]["mode"]): string[] {
  if (mode === "none") return []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (seen.has(entry.id)) problems.push(`\`${entry.id}\` is listed twice: a stage runs once, in one place`)
    seen.add(entry.id)
  }
  const analysis = list.find((entry) => entry.id === "analysis")
  if (analysis && !analysis.enabled) problems.push("`analysis` cannot be disabled: it is the review pass")
  if (mode === "fixed") {
    if (!analysis) problems.push("a fixed list needs `analysis`, the review pass")
    let last: ListEntry | undefined
    for (const entry of list) {
      if (last && rankOf(entry.id) < rankOf(last.id)) problems.push(rankOf(entry.id) === 2
        ? `\`${entry.id}\` comes after \`${last.id}\`: a stage of your own runs in the review pass, before corroboration`
        : `\`${entry.id}\` comes after \`${last.id}\`: the order is ${PRESET_PHASES.join(" → ")}`)
      last = entry
    }
  }
  return problems.slice(0, 12)
}

const ordered = (phases: Phase[]) => phases.map((phase, index) => ({ phase, index })).sort((a, b) => rankOf(a.phase.id) - rankOf(b.phase.id) || a.index - b.index).map((entry) => entry.phase)

/** A built-in stage's prompt: the list's, else the built-in instruction (none for the operational stages). */
const promptOf = (id: string, entry: ListEntry | undefined) => entry?.prompt ?? PHASE_INSTRUCTIONS[id]
const phase = (id: string, entry: ListEntry | undefined, reason: string, source: Phase["source"]): Phase => { const prompt = promptOf(id, entry); return { id, ...(prompt ? { prompt } : {}), reason, source } }

/** The controls every plan holds, whatever the list says, with the decision when a list tried to drop one. */
function controls(facts: PhaseFacts, byId: ReadonlyMap<string, ListEntry>, decisions: Decision[]): Phase[] {
  const ids = ["analysis", "corroboration", ...(facts.fixMode !== "review" ? ["fix"] : []), "validation"]
  return ids.map((id) => {
    const entry = byId.get(id)
    const why = id === "analysis" ? "the review pass" : id === "corroboration" ? "the verify pass: nothing unverified is published" : id === "fix" ? `fix.mode is ${facts.fixMode}` : "the closing gate: complete, verified, checks passed"
    if (entry && !entry.enabled) decisions.push({ phase: id, action: "kept", reason: `disabled in phases.list, but it is ${why}, a control a list cannot remove` })
    else if (entry?.when && !conditionMet(entry.when, facts).met) decisions.push({ phase: id, action: "kept", reason: `its condition does not hold (${conditionMet(entry.when, facts).reason}), but it is ${why}, a control a condition cannot skip` })
    if (id === "validation" && entry?.prompt) decisions.push({ phase: id, action: "kept", reason: "validation is deterministic: its prompt is not sent to a model" })
    return phase(id, id === "validation" ? undefined : entry, entry ? `listed in phases.list; ${why}` : why, entry ? "config" : "preset")
  })
}

/**
 * The plan of one review from the repository's `phases` and the change's facts. Never throws: an invalid list (`checkPhaseList`)
 * falls back to the preset stages and the decisions say why, so a typo in `.mendcode/review.yaml` never stops a review.
 */
export function planPhases({ config, facts }: { config: ReviewConfig["phases"]; facts: PhaseFacts }): PhasePlan {
  const decisions: Decision[] = []
  if (config.mode === "none") {
    const operational = controls(facts, new Map(), decisions).map((entry) => ({ ...entry, reason: `${entry.reason} (an operational state; phases: none shows no stages)` }))
    return { mode: "none", phases: operational, decisions: [] }
  }
  const problems = checkPhaseList(config.list, config.mode)
  if (problems.length) {
    decisions.push({ phase: "plan", action: "skipped", reason: `phases.list was not used (${problems.join("; ")}); the preset stages ran instead` })
    return { mode: config.mode, phases: ordered([phase("discovery", undefined, "the preset", "preset"), ...controls(facts, new Map(), decisions)]), decisions }
  }
  const list = config.list
  const byId = new Map(list.map((entry) => [entry.id, entry]))
  const phases: Phase[] = controls(facts, byId, decisions)
  const fixListed = byId.get("fix")
  if (fixListed && facts.fixMode === "review") decisions.push({ phase: "fix", action: "skipped", reason: "fix.mode is review: the reviewer does not fix" })

  const own = (entry: ListEntry, source: Phase["source"]) => {
    if (!entry.enabled) { decisions.push({ phase: entry.id, action: "skipped", reason: "disabled in phases.list" }); return }
    const condition = conditionMet(entry.when, facts)
    if (!condition.met) { decisions.push({ phase: entry.id, action: "skipped", reason: `its condition does not hold: ${condition.reason}` }); return }
    const reason = entry.when ? `listed in phases.list; ${condition.reason}` : "listed in phases.list"
    phases.push(phase(entry.id, entry, reason, source))
    decisions.push({ phase: entry.id, action: "added", reason })
  }

  if (config.mode === "fixed") {
    const discovery = byId.get("discovery")
    if (discovery) own(discovery, "config")
    for (const entry of list) if (rankOf(entry.id) === 2) own(entry, "config")
    for (const entry of phases) if (!byId.has(entry.id) && (REQUIRED.has(entry.id) || entry.id === "fix")) decisions.push({ phase: entry.id, action: "kept", reason: `not in phases.list, but it is a control a list cannot remove (${entry.reason})` })
    return { mode: "fixed", phases: ordered(phases), decisions }
  }

  // dynamic: the preset's discovery, the evidence-driven stages, then the list's own stages.
  const discovery = byId.get("discovery")
  if (discovery) own(discovery, "config")
  else if (facts.changedLines <= 30 && facts.files.length <= 2) decisions.push({ phase: "discovery", action: "skipped", reason: `a small change (${plural(facts.files.length, "file")}, ${plural(facts.changedLines, "changed line")}) needs no separate scope map` })
  else phases.push(phase("discovery", undefined, `the preset; ${plural(facts.files.length, "changed file")}`, "preset"))
  for (const id of DYNAMIC_PHASES) {
    const entry = byId.get(id)
    if (entry && !entry.enabled) { decisions.push({ phase: id, action: "skipped", reason: "disabled in phases.list" }); continue }
    const condition = entry?.when ? conditionMet(entry.when, facts) : undefined
    const evidence = condition ? (condition.met ? `phases.list condition: ${condition.reason}` : undefined) : evidenceFor(id, facts)
    if (!evidence) { if (condition) decisions.push({ phase: id, action: "skipped", reason: `its condition does not hold: ${condition.reason}` }); continue }
    phases.push(phase(id, entry, evidence, "dynamic"))
    decisions.push({ phase: id, action: "added", reason: evidence })
  }
  for (const entry of list) if (rankOf(entry.id) === 2 && !(DYNAMIC_PHASES as readonly string[]).includes(entry.id)) own(entry, "config")
  return { mode: "dynamic", phases: ordered(phases), decisions }
}

/** The plan a review without one runs: the review pass, the verify pass and the closing gate. */
export const DEFAULT_PHASE_PLAN: PhasePlan = { mode: "none", phases: [{ id: "analysis", reason: "the review pass", source: "preset" }, { id: "corroboration", reason: "the verify pass", source: "preset" }, { id: "validation", reason: "the closing gate", source: "preset" }], decisions: [] }

/** The instructions of the stages that run in the review pass (every stage before corroboration that has a prompt). */
export function reviewStages(plan: PhasePlan): Array<{ id: string; prompt: string }> {
  return plan.phases.filter((entry) => rankOf(entry.id) < RANK.corroboration! && entry.prompt).map((entry) => ({ id: entry.id, prompt: entry.prompt! }))
}
/** A stage's own prompt (`corroboration` for the verify pass, `fix` for the fix session), when the plan has one. */
export const phasePrompt = (plan: PhasePlan | undefined, id: string) => plan?.phases.find((entry) => entry.id === id)?.prompt
/**
 * The checkpoint phase of a review pass stopped between the parts of a large diff: `analysis 3/7` (three of seven parts reviewed),
 * which the job's page shows as is and `resumeReview` reads back to continue at part four.
 */
export const partPhase = (done: number, total: number) => `analysis ${done}/${total}`
export function parsePartPhase(phase: string | undefined): { done: number; total: number } | undefined {
  const match = /^analysis (\d{1,3})\/(\d{1,3})$/.exec(phase ?? "")
  if (!match) return undefined
  const done = Number(match[1])
  const total = Number(match[2])
  return total > 0 && done <= total ? { done, total } : undefined
}

/** The ids of the plan's stages before `id`, in order: what a job completed when it stops at `id`. */
export const phasesBefore = (plan: PhasePlan, id: string) => plan.phases.filter((entry) => rankOf(entry.id) < rankOf(id)).map((entry) => entry.id)

/**
 * The deterministic closing gate: never a model's word. A review closes when it is complete (no candidate left unverified) and
 * verified; after a fix also only when every check passed and no confirmed finding is still open. A failed gate is never `done`.
 */
export function validationGate({ complete, verified, checks, open = [] }: { complete: boolean; verified: boolean; checks?: ReadonlyArray<{ command: string; code: number }>; open?: readonly PrFinding[] }): { ok: boolean; reason: string } {
  if (!verified) return { ok: false, reason: "verification failed: nothing is confirmed" }
  if (!complete) return { ok: false, reason: "the review is incomplete: candidates are still unverified" }
  const failed = (checks ?? []).filter((check) => check.code !== 0)
  if (failed.length) return { ok: false, reason: `${plural(failed.length, "check")} did not pass: ${failed.slice(0, 3).map((check) => `\`${check.command}\` (exit ${check.code})`).join(", ")}` }
  if (open.length) return { ok: false, reason: `${plural(open.length, "confirmed finding")} still open` }
  return { ok: true, reason: checks?.length ? `complete and verified; ${plural(checks.length, "check")} passed` : "complete and verified" }
}

/**
 * The no-progress guard of a fix loop (`phases.max_rounds_without_progress`): a round makes progress when an open confirmed finding
 * of the round before is gone. After `max` rounds in a row without progress the loop stops, and says so in rounds.
 */
export function progressStop({ rounds, max }: { rounds: JobCheckpoint["rounds"]; max: number }): PrStopReason | undefined {
  let stale = 0
  for (let index = rounds.length - 1; index >= 1; index--) {
    const before = new Set(rounds[index - 1]!.open)
    const progress = rounds[index - 1]!.open.some((id) => !rounds[index]!.open.includes(id)) || rounds[index]!.open.length < before.size
    if (progress) break
    stale++
  }
  if (stale < max) return undefined
  const open = rounds.at(-1)?.open.length ?? 0
  return { kind: "no_progress", detail: `${plural(stale, "round")} in a row fixed no open confirmed finding`, unit: "rounds", used: stale, limit: max, resumable: false, remaining: `${plural(open, "confirmed finding")} open` }
}
