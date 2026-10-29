import type { DreamReport, DreamRun } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import { clip, spread } from "./deck"
import { truncateEnd } from "./session-list"

/**
 * The safety report of one Dream run (docs/dream.md): what it read, proposed and refused and why, the secrets it
 * redacted, what the model cost and whether the token budget stopped it. Pure rows; the row count depends on the run
 * and the detail level only, never on the width (rows are cut, not wrapped), so callers can size a scroll from it.
 */

export type ReportDetail = "summary" | "full"

const LABEL = 10
const SUMMARY_PROPOSALS = 3
const SUMMARY_REFUSALS = 2
const KIND_MARK: Record<DreamReport["proposed"][number]["kind"], { mark: string; fg: ColorName }> = { new: { mark: "+", fg: "success" }, update: { mark: "~", fg: "warning" }, archive: { mark: "-", fg: "error" } }
const OUTCOME_TONE: Record<DreamReport["proposed"][number]["outcome"], ColorName> = { saved: "success", pending: "warning", dropped: "muted" }
const TRIGGER_NOTE: Record<NonNullable<DreamRun["trigger"]>, string> = {
  manual: "you ran it",
  scheduled: "its daily window",
  recovered: "a missed window, run late (the daemon was down or the machine asleep)",
}

/** `820`, `4.1k`, `60k`. */
export function tokenCount(count: number): string {
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  return thousands >= 100 ? `${Math.round(thousands)}k` : `${Number(thousands.toFixed(1))}k`
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const memories = (count: number) => plural(count, "memory", "memories")

const labelled = (label: string, spans: Line, width: number): Line => clip([{ text: label.padEnd(LABEL), fg: "muted" }, ...spans], width)
const continued = (spans: Line, width: number): Line => clip([{ text: " ".repeat(LABEL) }, ...spans], width)
const dot: Span = { text: " · ", fg: "muted" }

function joined(parts: Line[]): Line {
  const out: Line = []
  parts.forEach((part, index) => out.push(...(index > 0 ? [dot] : []), ...part))
  return out
}

function readRows(report: DreamReport, detail: ReportDetail, width: number): Line[] {
  const { read } = report
  const reused = read.sessions.filter((session) => session.digest === "reused").length
  const sessions = `${plural(read.sessions.length, "session")}${reused ? ` (${reused} reused)` : ""}`
  const rows: Line[] = [labelled("read", joined([[{ text: sessions, fg: "text" }], [{ text: memories(read.memories), fg: "text" }], [{ text: `${tokenCount(read.promptChars)} chars sent`, fg: "muted" }]]), width)]
  if (detail === "full")
    for (const session of read.sessions) {
      const facts = [`${plural(session.messages, "msg")}`, session.digest, ...(session.redactions ? [`${session.redactions} redacted`] : [])].join(" · ")
      rows.push(continued([{ text: "· ", fg: "muted" }, { text: truncateEnd(session.title || session.sessionId, Math.max(8, width - LABEL - facts.length - 5)), fg: "body" }, { text: ` — ${facts}`, fg: session.redactions ? "warning" : "muted" }], width))
    }
  return rows
}

function proposedRows(report: DreamReport, detail: ReportDetail, width: number): Line[] {
  const { proposed } = report
  const count = (outcome: string) => proposed.filter((item) => item.outcome === outcome).length
  const summary = proposed.length === 0 ? [{ text: "nothing", fg: "muted" as const }] : [{ text: String(proposed.length), fg: "text" as const }, ...(["saved", "pending", "dropped"] as const).flatMap((outcome) => (count(outcome) ? [dot, { text: `${count(outcome)} ${outcome}`, fg: OUTCOME_TONE[outcome] }] : []))]
  const rows: Line[] = [labelled("proposed", summary, width)]
  const shown = detail === "full" ? proposed : proposed.slice(0, SUMMARY_PROPOSALS)
  for (const item of shown) {
    const { mark, fg } = KIND_MARK[item.kind]
    const where = `${item.category || "other"}${item.scope ? `/${item.scope}` : ""}`
    const left: Line = [{ text: `${mark} `, fg, bold: true }, { text: where, fg: "muted" }, { text: "  " }, { text: item.text.replace(/\s+/g, " "), fg: "body" }]
    rows.push(continued(spread(left, [{ text: item.outcome, fg: OUTCOME_TONE[item.outcome] }], width - LABEL), width))
  }
  if (shown.length < proposed.length) rows.push(continued([{ text: `+${proposed.length - shown.length} more · v shows the full report`, fg: "muted", dim: true }], width))
  return rows
}

function refusedRows(report: DreamReport, detail: ReportDetail, width: number): Line[] {
  const { refused } = report
  const rows: Line[] = [labelled("refused", refused.length === 0 ? [{ text: "nothing", fg: "muted" }] : [{ text: String(refused.length), fg: "warning" }, { text: " the model suggested, Dream did not take", fg: "muted" }], width)]
  const shown = detail === "full" ? refused : refused.slice(0, SUMMARY_REFUSALS)
  for (const item of shown) rows.push(continued([{ text: "! ", fg: "warning", bold: true }, { text: truncateEnd(item.item.replace(/\s+/g, " "), Math.max(10, Math.floor((width - LABEL) * 0.5))), fg: "body" }, { text: ` — ${item.reason}`, fg: "muted" }], width))
  if (shown.length < refused.length) rows.push(continued([{ text: `+${refused.length - shown.length} more · v shows the full report`, fg: "muted", dim: true }], width))
  return rows
}

function redactionRows(report: DreamReport, width: number): Line {
  const { evidence, proposals } = report.redactions
  if (evidence + proposals === 0) return labelled("redacted", [{ text: "no secrets found", fg: "muted" }], width)
  return labelled("redacted", joined([[{ text: `${evidence} in evidence`, fg: evidence ? "warning" : "muted" }], [{ text: `${proposals} in proposals`, fg: proposals ? "warning" : "muted" }], [{ text: "a proposal with a secret always waits for review", fg: "muted", dim: true }]]), width)
}

function modelRow(report: DreamReport, width: number): Line {
  const { model } = report
  if (model.calls === 0) return labelled("model", [{ text: "no call made", fg: "muted" }], width)
  return labelled("model", joined([[{ text: plural(model.calls, "call"), fg: "text" }], [{ text: `${tokenCount(model.inputTokens)} in`, fg: "text" }], [{ text: `${tokenCount(model.outputTokens)} out`, fg: "text" }], ...(model.estimated ? [[{ text: "estimated (chars / 4)", fg: "warning" as const }]] : [])]), width)
}

function budgetRow(report: DreamReport, width: number): Line {
  const { budget } = report
  const percent = Math.round((budget.used / budget.limit) * 100)
  const tone: ColorName = budget.stopped ? "error" : percent >= 80 ? "warning" : "text"
  const spans: Line = [{ text: `${tokenCount(budget.used)} / ${tokenCount(budget.limit)} tokens (${percent}%)`, fg: tone }]
  if (budget.stopped) spans.push(dot, { text: `stopped${budget.reason ? `: ${budget.reason}` : ""}`, fg: "error", bold: true })
  return labelled("budget", spans, width)
}

function consolidationRows(report: DreamReport, width: number): Line[] {
  const pass = report.consolidation
  if (!pass || pass.policy === "disabled") return []
  const kept = pass.decisions.filter((decision) => decision.outcome === "kept").length
  const parts: Line[] = [
    [{ text: pass.mode ?? "deterministic", fg: "text", bold: true }, { text: ` ${pass.policy}`, fg: "muted" }],
    ...(pass.semantic ? [[{ text: `${pass.semantic.model} · ${plural(pass.semantic.calls, "call")} · ${tokenCount(pass.semantic.inputTokens)} in ${tokenCount(pass.semantic.outputTokens)} out${pass.semantic.estimated ? " (estimated)" : ""}`, fg: "muted" as const }]] : []),
    [{ text: `${pass.applied} applied`, fg: pass.applied ? "success" : "muted" }, dot, { text: `${pass.archived} archived`, fg: "muted" }, ...(kept ? [dot, { text: `${kept} left for review`, fg: "warning" as const }] : [])],
  ]
  const rows: Line[] = [labelled("cleanup", joined(parts), width)]
  if (pass.semantic?.fallback) rows.push(continued([{ text: `host gates only for a batch: ${pass.semantic.fallback}`, fg: "warning", dim: true }], width))
  return rows
}

function evolutionRows(report: DreamReport, width: number): Line[] {
  const evolution = report.evolution
  if (!evolution) return []
  const { observed, suggested } = evolution
  const parts: Line[] = [
    [{ text: evolution.mode, fg: "text", bold: true }],
    [{ text: `saw ${plural(observed.corrections, "correction")}, ${plural(observed.preferences, "preference")} (${observed.recurring} recurring)`, fg: "muted" }],
  ]
  const made = suggested.memories + suggested.skills + suggested.instructions
  if (made) parts.push([{ text: `suggested ${[suggested.memories ? memories(suggested.memories) : "", suggested.skills ? plural(suggested.skills, "skill") : "", suggested.instructions ? plural(suggested.instructions, "instruction") : ""].filter(Boolean).join(", ")}`, fg: "text" }])
  if (evolution.applied) parts.push([{ text: `${evolution.applied} saved directly`, fg: "success" }])
  const rows: Line[] = [labelled("evolution", joined(parts), width)]
  if (suggested.workflows) rows.push(continued([{ text: `suggested ${plural(suggested.workflows, "workflow")}`, fg: "text" }], width))
  if (evolution.note) rows.push(continued([{ text: evolution.note, fg: "muted", dim: true }], width))
  return rows
}

/** The report's rows; `summary` caps proposals and refusals, `full` lists every session, proposal and refusal. */
export function reportRows(input: { run: DreamRun; detail: ReportDetail; width: number }): Line[] {
  const { run, detail, width } = input
  const report = run.report
  if (!report) return [[{ text: run.status === "running" ? "the report appears when the run ends" : "no safety report for this run (recorded before reports, or it ended before one was made)", fg: "muted", dim: true }]]
  const rows: Line[] = []
  if (run.trigger) rows.push(labelled("trigger", [{ text: run.trigger, fg: run.trigger === "recovered" ? "warning" : "text", bold: run.trigger === "recovered" }, { text: ` · ${TRIGGER_NOTE[run.trigger]}`, fg: "muted" }], width))
  rows.push(...readRows(report, detail, width), ...proposedRows(report, detail, width), ...refusedRows(report, detail, width), redactionRows(report, width), modelRow(report, width), budgetRow(report, width), ...consolidationRows(report, width), ...evolutionRows(report, width))
  for (const failure of report.failures) rows.push(labelled("failed", [{ text: truncateEnd(failure, Math.max(10, width - LABEL)), fg: "error" }], width))
  return rows
}
