import type { PrFinding } from "@mendcode/protocol"
import type { PrEditor, ResolveReport, ReviewSnapshot } from "./describe"
import type { ReviewState } from "./state"

/**
 * `@mendcode resolve` and `@mendcode approve` (docs/pr-review.md): what MendCode does with a review it already made. Resolve closes
 * only the threads of MendCode's own findings that the last review marked fixed; approve submits an approval only when the
 * repository enabled it and the last review of this very head confirmed nothing. Neither calls the model.
 */

export const APPROVE_OFF = "`@mendcode approve` is off for this repository: set `commands.approve: true` in `.mendcode/review.yaml` on the base branch."

const where = (finding: PrFinding) => `\`${finding.path}:${finding.line}\` ${finding.summary.replace(/\s+/g, " ").slice(0, 120)}`

/** The confirmed findings that keep a head from being approved: the last review's own and any published one still open. */
export function confirmedOpen({ review, state }: { review: ReviewSnapshot; state: ReviewState }): PrFinding[] {
  const open = new Map<string, PrFinding>()
  for (const finding of review.result.findings) if (finding.verdict === "confirmed" && !state.published[finding.id]?.resolved) open.set(finding.id, finding)
  for (const [id, entry] of Object.entries(state.published)) if (entry.finding?.verdict === "confirmed" && !entry.resolved) open.set(id, entry.finding)
  return [...open.values()]
}

/** Why this head is not approved, or undefined when it may be. `review`: the last finished review of this head, when there is one. */
export function approveBlock({ enabled, review, head, state }: { enabled: boolean; review: ReviewSnapshot | undefined; head: string; state: ReviewState }): string | undefined {
  if (!enabled) return APPROVE_OFF
  if (!review || review.head !== head) return `MendCode has no finished review of ${head.slice(0, 12)} yet, so it does not approve it. \`@mendcode review\` reviews it; ask again after.`
  const open = confirmedOpen({ review, state })
  if (!open.length) return undefined
  return `Not approved: the last review of ${head.slice(0, 12)} has ${open.length} confirmed finding${open.length === 1 ? "" : "s"} still open:\n${open.slice(0, 8).map((finding) => `- ${where(finding)}`).join("\n")}${open.length > 8 ? `\n- and ${open.length - 8} more` : ""}`
}

export const approveText = (head: string) => `Approved ${head.slice(0, 12)}: MendCode's last review of this head has no confirmed findings. This is MendCode's verdict on that review, not a human approval.`

/** The reply to `@mendcode resolve`. */
export function resolveText({ editor, report }: { editor: PrEditor; report: ResolveReport }): string {
  if (!report.resolved && !report.failed) return "No thread of MendCode is waiting: none of its open threads has a finding the last review marked fixed."
  const lines: string[] = []
  if (report.resolved) lines.push(`Resolved ${report.resolved} thread${report.resolved === 1 ? "" : "s"} whose findings the last review marked fixed.`)
  if (report.failed) lines.push(`${report.failed} thread${report.failed === 1 ? "" : "s"} could not be resolved: this account may not resolve review threads on ${editor.name}; the author or a maintainer can.`)
  return lines.join(" ")
}

export const unsupportedText = (command: "describe" | "resolve" | "approve", name: string, why: string) => `\`@mendcode ${command}\` is not supported on ${name}: ${why}.`
