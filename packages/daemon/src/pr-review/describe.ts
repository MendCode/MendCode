import type { PrReviewResult, PrWalkthrough } from "@mendcode/protocol"

/**
 * `@mendcode describe` (docs/pr-review.md): the pull request's description from what the review pass already wrote (the
 * walkthrough, the change type), with no model call of its own. MendCode owns only the part between its two markers: a description
 * a person wrote is kept, the section is appended once and replaced on every later run. The title changes only when the repository
 * allows it (`commands.describe_title`), and a label is added only when the repository already has one for the change type.
 */

export const DESCRIBE_START = "<!-- mendcode:describe:start -->"
export const DESCRIBE_END = "<!-- mendcode:describe:end -->"
/** GitHub's limit is 65,536 characters; a description that would not fit with the section is left as it is. */
const BODY_LIMIT = 60_000
const TITLE_LIMIT = 72

/** The pull request as an editor reads it. */
export type PrSnapshot = { title: string; body: string; labels: string[]; head?: string | undefined }
/** What the forge takes as an edit: each field left out stays as it is. */
export type PrEdit = { title?: string; body?: string; labels?: string[] }
export type EditResult = { ok: true } | { ok: false; reason: string }

/**
 * A forge's side of the commands that write to a pull request. A method a forge cannot do is absent, and the command says it is not
 * supported there instead of pretending (`name` is the forge in that sentence).
 */
export type PrEditor = {
  name: string
  read(): Promise<PrSnapshot | undefined>
  /** Names of the labels the repository has; undefined when they cannot be read (no label is added then). */
  repoLabels?(): Promise<string[] | undefined>
  edit?(input: PrEdit): Promise<EditResult>
  approve?(input: { head: string; body: string }): Promise<EditResult>
  /** Resolves the threads of findings the last review marked fixed. */
  resolveFixed?(input: { state: import("./state").ReviewState }): Promise<ResolveReport>
}
export type ResolveReport = { resolved: number; failed: number; state: import("./state").ReviewState }

/** The review a command builds on: its head and everything it found. */
export type ReviewSnapshot = { head: string; result: PrReviewResult }

const PREFIX: Record<PrWalkthrough["type"], string> = { "bug fix": "fix", feature: "feat", refactor: "refactor", performance: "perf", tests: "test", docs: "docs", build: "build", chore: "chore" }
/** Label names a repository commonly uses for each change type, most specific first. */
const LABELS: Record<PrWalkthrough["type"], readonly string[]> = {
  "bug fix": ["bug", "bugfix", "fix", "bug fix"],
  feature: ["enhancement", "feature", "feat"],
  refactor: ["refactor", "refactoring"],
  performance: ["performance", "perf"],
  tests: ["tests", "test", "testing"],
  docs: ["documentation", "docs"],
  build: ["build", "dependencies"],
  chore: ["chore", "maintenance"],
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const RISK_MARK: Record<PrWalkthrough["risk"]["level"], string> = { low: "🟢", medium: "🟡", high: "🔴" }
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``

/** The MendCode section, markers included. */
export function describeSection({ walkthrough, head }: { walkthrough: PrWalkthrough; head: string }): string {
  const changes = walkthrough.changes.map((change) => `- **${change.layer.replace(/[*]/g, "")}** (${change.files.slice(0, 6).map(code).join(", ")}${change.files.length > 6 ? `, and ${change.files.length - 6} more` : ""}): ${change.summary.replace(/\n/g, " ")}`)
  return [
    DESCRIBE_START,
    "## Summary by MendCode",
    walkthrough.overview,
    `**Change:** ${capital(walkthrough.type)} · **Merge risk:** ${RISK_MARK[walkthrough.risk.level]} ${capital(walkthrough.risk.level)} · ${walkthrough.risk.reason}`,
    changes.length ? `**Changes**\n\n${changes.join("\n")}` : "",
    `<sub>Written by MendCode from its review of ${code(head.slice(0, 12))}. \`@mendcode describe\` replaces only this section.</sub>`,
    DESCRIBE_END,
  ].filter(Boolean).join("\n\n")
}

/** Where MendCode's section sits in `body`: the last start marker and the first end marker after it. */
function sectionAt(body: string): { from: number; to: number } | undefined {
  const from = body.lastIndexOf(DESCRIBE_START)
  if (from < 0) return undefined
  const end = body.indexOf(DESCRIBE_END, from)
  return end < 0 ? undefined : { from, to: end + DESCRIBE_END.length }
}

/** The description with MendCode's section replaced (or appended once); everything outside the markers is kept byte for byte. */
export function mergeDescription(body: string, section: string): string {
  const at = sectionAt(body)
  if (at) return `${body.slice(0, at.from)}${section}${body.slice(at.to)}`
  return body.trim() ? `${body.replace(/\s+$/, "")}\n\n${section}\n` : `${section}\n`
}

/** The description a review reads as the author's own: MendCode's section left out. */
export function withoutDescribeSection(body: string): string {
  const at = sectionAt(body)
  return at ? `${body.slice(0, at.from)}${body.slice(at.to)}`.replace(/\n{3,}/g, "\n\n").trim() : body
}

/** A conventional title from the change type and the overview's first sentence, at most 72 characters. */
export function describeTitle(walkthrough: PrWalkthrough): string {
  const sentence = walkthrough.overview.trim().split(/(?<=[.!?])\s|\n/)[0]!.replace(/[.!?]+$/, "").replace(/\s+/g, " ")
  const lowered = /^[A-Z][a-z]/.test(sentence) ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : sentence
  const head = `${PREFIX[walkthrough.type]}: `
  const room = TITLE_LIMIT - head.length
  if (lowered.length <= room) return `${head}${lowered}`
  const cut = lowered.slice(0, room - 1)
  return `${head}${cut.slice(0, Math.max(cut.lastIndexOf(" "), room >> 1)).trimEnd()}…`
}

/** The one label to add for the change type: the first usual name the repository has, none when the PR already carries one. */
export function labelFor({ type, repoLabels, onPullRequest }: { type: PrWalkthrough["type"]; repoLabels: readonly string[] | undefined; onPullRequest: readonly string[] }): string | undefined {
  if (!repoLabels) return undefined
  const known = new Map(repoLabels.map((name) => [name.toLowerCase(), name]))
  const present = new Set(onPullRequest.map((name) => name.toLowerCase()))
  if (LABELS[type].some((name) => present.has(name))) return undefined
  for (const name of LABELS[type]) { const found = known.get(name); if (found) return found }
  return undefined
}

export type DescribeReport = { ok: boolean; text: string }

/**
 * Writes the description section, and the title and the label where allowed. `settings.describeTitle`: the repository's
 * `commands.describe_title`. One edit call carries everything that changed; nothing is sent when nothing did.
 */
export async function runDescribe({ review, current, editor, settings }: { review: ReviewSnapshot; current: PrSnapshot; editor: PrEditor; settings: { describeTitle: boolean } }): Promise<DescribeReport> {
  const walkthrough = review.result.walkthrough
  if (!walkthrough) return { ok: false, text: `The review of ${review.head.slice(0, 12)} wrote no walkthrough (a partial or stopped review does), so there is nothing to describe from. \`@mendcode review full\` reviews the head whole.` }
  if (!editor.edit) return { ok: false, text: `\`@mendcode describe\` is not supported on ${editor.name}: its adapter cannot edit a pull request.` }
  if (current.head && current.head !== review.head) return { ok: false, text: `The pull request moved past ${review.head.slice(0, 12)}; its new head is reviewed on its own, and \`@mendcode describe\` after that review describes it.` }
  const body = mergeDescription(current.body, describeSection({ walkthrough, head: review.head }))
  const edit: PrEdit = {}
  const notes: string[] = []
  if (body.length > BODY_LIMIT) notes.push("the description is too long to add MendCode's section")
  else if (body !== current.body) edit.body = body
  else notes.push("the description is up to date")
  if (settings.describeTitle) {
    const title = describeTitle(walkthrough)
    if (title !== current.title) { edit.title = title; notes.push("title replaced") } else notes.push("title unchanged")
  } else notes.push("title kept (`commands.describe_title` is off)")
  const label = labelFor({ type: walkthrough.type, repoLabels: await editor.repoLabels?.().catch(() => undefined), onPullRequest: current.labels })
  if (label) { edit.labels = [label]; notes.push(`label \`${label}\` added`) } else notes.push("no label added (the repository has none for this change type, or it already has one)")
  if (edit.body !== undefined) notes.unshift(mergeNote(current.body))
  if (!Object.keys(edit).length) return { ok: true, text: `Nothing to change: ${notes.join("; ")}.` }
  const done = await editor.edit(edit)
  if (!done.ok) return { ok: false, text: `${editor.name} refused the edit (${done.reason.slice(0, 200)}); nothing was changed.` }
  return { ok: true, text: `Described ${review.head.slice(0, 12)}: ${notes.join("; ")}.` }
}

const mergeNote = (before: string) => sectionAt(before) ? "MendCode's section of the description replaced" : "MendCode's section added to the description"
