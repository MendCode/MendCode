import { createHash } from "node:crypto"
import { PR_CHANGE_TYPES, PR_CHECK_STATUSES, PR_FINDING_CATEGORIES, PR_FINDING_SEVERITIES, PR_MERGE_RISKS, PrFinding, PrPreMergeCheck, PrWalkthrough, PrWalkthroughChange } from "@mendcode/protocol"

/**
 * Findings as the review child writes them and as the reviewer keeps them (docs/pr-review.md). The model answers with JSON; this
 * module finds it in the answer, gives each finding its stable id and the RIGHT side, and checks it against `PrFinding`. Prose
 * never becomes a finding: an answer without valid JSON is one repair turn, then a failure.
 */

/** sha1 of path, line, category and summary: the same finding on a later head keeps its id, so it is never posted twice. */
export const findingId = (input: { path: string; line: number; category: string; summary: string }) => createHash("sha1").update(`${input.path}\n${input.line}\n${input.category}\n${input.summary}`).digest("hex")

/** The first JSON object of a model answer: a fenced ```json block, else the outermost braces. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((value): value is string => !!value && value.trim().startsWith("{"))
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch { /* the next candidate */ }
  }
  throw new Error("no JSON object in the answer")
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Model fields to a `PrFinding`: id and side added, a suggestion dropped unless it is a replacement string. */
function candidate(raw: unknown): unknown {
  const entry = record(raw)
  const path = typeof entry.path === "string" ? entry.path.replace(/^\.\//, "").replace(/^[ab]\//, "") : entry.path
  const line = entry.line
  const suggestion = record(entry.suggestion)
  return {
    ...(typeof path === "string" && typeof line === "number" && typeof entry.category === "string" && typeof entry.summary === "string" ? { id: findingId({ path, line, category: entry.category, summary: entry.summary }) } : { id: "" }),
    path, line, ...(entry.endLine !== undefined && entry.endLine !== null && entry.endLine !== line ? { endLine: entry.endLine } : {}), side: "RIGHT",
    severity: entry.severity, category: entry.category, summary: entry.summary, detail: entry.detail,
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    ...(typeof suggestion.replacement === "string" ? { suggestion: { replacement: suggestion.replacement } } : {}),
  }
}

/**
 * The walkthrough of an answer, or undefined. Unlike findings it never fails the answer: it is a description, not a claim to
 * publish, so a group or check that does not fit the schema is left out, and a walkthrough without an overview, type or risk is
 * dropped whole. A diagram is kept only as a fenced-or-bare Mermaid sequence diagram or flowchart.
 */
export function parseWalkthrough(raw: unknown): PrWalkthrough | undefined {
  const entry = record(raw)
  const risk = record(entry.risk)
  const diagram = typeof entry.diagram === "string" ? entry.diagram.trim().replace(/^```(?:mermaid)?[ \t]*\n/, "").replace(/\n?```$/, "").trim() : ""
  const lower = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : value
  const parsed = PrWalkthrough.safeParse({
    overview: entry.overview,
    changes: (Array.isArray(entry.changes) ? entry.changes : []).flatMap((change) => {
      const group = record(change)
      const item = PrWalkthroughChange.safeParse({ layer: group.layer, files: Array.isArray(group.files) ? group.files.filter((file) => typeof file === "string").slice(0, 40) : group.files, summary: group.summary })
      return item.success ? [item.data] : []
    }).slice(0, 12),
    ...(diagram && /^(?:sequenceDiagram|flowchart|graph)\b/.test(diagram) && diagram.length <= 3000 ? { diagram } : {}),
    type: lower(entry.type),
    risk: { level: lower(risk.level), reason: risk.reason },
    checks: (Array.isArray(entry.checks) ? entry.checks : []).flatMap((check) => {
      const item = PrPreMergeCheck.safeParse({ name: record(check).name, status: lower(record(check).status), explanation: record(check).explanation })
      return item.success ? [item.data] : []
    }).slice(0, 6),
  })
  return parsed.success ? parsed.data : undefined
}

export type ParsedFindings = { ok: true; summary: string; findings: PrFinding[]; walkthrough?: PrWalkthrough } | { ok: false; problems: string[] }

/** `{ summary, findings: [...] }` from an answer, every finding valid, or the problems a repair turn is told about. */
export function parseFindings(text: string): ParsedFindings {
  let value: unknown
  try { value = extractJson(text) } catch (error) { return { ok: false, problems: [error instanceof Error ? error.message : String(error)] } }
  const body = record(value)
  if (!Array.isArray(body.findings)) return { ok: false, problems: ["the object needs a `findings` array (empty when there is nothing to report)"] }
  const problems: string[] = []
  const findings: PrFinding[] = []
  body.findings.slice(0, 200).forEach((raw, index) => {
    const parsed = PrFinding.safeParse(candidate(raw))
    if (parsed.success) findings.push(parsed.data)
    else problems.push(`findings[${index}]: ${parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "finding"} ${issue.message}`).join("; ")}`)
  })
  if (problems.length) return { ok: false, problems: problems.slice(0, 12) }
  const walkthrough = parseWalkthrough(body.walkthrough)
  return { ok: true, summary: typeof body.summary === "string" ? body.summary.slice(0, 4000) : "", findings, ...(walkthrough ? { walkthrough } : {}) }
}

/** The shape the review child is asked to answer in, quoted in its prompt and in the repair turn. */
export const FINDINGS_SHAPE = `{"summary": "two or three sentences on what the change does and its risk", "findings": [{"path": "src/file.ts", "line": 42, "endLine": 44, "severity": "${PR_FINDING_SEVERITIES.join("|")}", "category": "${PR_FINDING_CATEGORIES.join("|")}", "summary": "one line, at most 160 characters", "detail": "why it is wrong and what happens, at most 1200 characters", "evidence": ["src/file.ts:42", "src/caller.ts:10"], "suggestion": {"replacement": "the exact new text of lines line..endLine, only when the fix stays inside them"}}], "walkthrough": {"overview": "two to four sentences: what changes and why, for a reader who has not opened the diff", "changes": [{"layer": "a short name for related files, such as Shared status reader", "files": ["src/file.ts"], "summary": "one sentence on what changed in them"}], "diagram": "sequenceDiagram ... (only when the change alters how components call each other; leave the key out otherwise)", "type": "${PR_CHANGE_TYPES.join("|")}", "risk": {"level": "${PR_MERGE_RISKS.join("|")}", "reason": "one or two sentences"}, "checks": [{"name": "Title|Description|Linked issues|Out of scope", "status": "${PR_CHECK_STATUSES.join("|")}", "explanation": "one or two sentences"}]}}`

/** Keeps a deterministic order and drops the second copy of an id. */
export function uniqueFindings(findings: readonly PrFinding[]): PrFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => !seen.has(finding.id) && (seen.add(finding.id), true))
}
