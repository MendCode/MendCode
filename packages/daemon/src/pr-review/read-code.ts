import { parseDiffRows } from "@mendcode/protocol/wire"
import type { FileDiff } from "./context"
import type { CodeRead } from "./contracts"
import { diffLines } from "./triage"

/**
 * Code the cheap readers read (docs/pr-review.md, "Readers read the code"): the pieces shared by the reader's prompt (readers.ts) and
 * what the review pass gets in place of a file's whole diff (context.ts). A reader returns, per file, what changed and the risk
 * spots it found as new-side line ranges; a range is kept only when both ends are lines of the diff, and the review pass gets the
 * hunks those ranges touch. Nothing here decides a finding: the ranges are hints, and the verify pass checks every finding against the code.
 */

/** A code file whose diff is larger than this is not sent to a reader (a cheap model cannot hold it): the review pass gets it whole. */
export const CODE_FILE_CHARS = 48_000
/** A file whose diff is at most this long goes to the review pass whole next to its summary: choosing hunks would save nothing. */
export const SMALL_FILE_CHARS = 2_400
/** The most risk spots kept for one file, and the longest range (in lines) one spot may cover. */
export const MAX_RISKS = 8
export const MAX_RISK_SPAN = 300

const lineOf = (text: string) => text.replace(/\n$/, "").split("\n")
const firstHunk = (lines: readonly string[]) => lines.findIndex((line) => line.startsWith("@@"))

/** The file's hunks with the new-side number in front of every added and context line, so a reader can cite lines it can see. */
export function annotateDiff(text: string): string {
  const lines = lineOf(text)
  const first = firstHunk(lines)
  if (first < 0) return ""
  return parseDiffRows(lines.slice(first)).map((row) => row.kind === "add" || row.kind === "context" ? `${String(row.new).padStart(5)} ${row.text}` : row.kind === "del" ? `      ${row.text}` : row.text).join("\n")
}

export type RawRisk = { start: number; end: number; kind: string; why: string }

/**
 * The risk spots whose both ends are new-side lines of the diff and whose span is bounded; `dropped` counts the invalid ones.
 * More valid spots than `MAX_RISKS` set `overflow`: the caller sends the file whole rather than hide a flagged hunk.
 */
export function validRisks(file: Pick<FileDiff, "right">, risks: readonly RawRisk[]): { kept: RawRisk[]; dropped: number; overflow: boolean } {
  const kept = risks.filter((risk) => Number.isInteger(risk.start) && Number.isInteger(risk.end) && risk.start <= risk.end && risk.end - risk.start < MAX_RISK_SPAN && file.right.has(risk.start) && file.right.has(risk.end))
  return { kept: kept.slice(0, MAX_RISKS), dropped: risks.length - kept.length, overflow: kept.length > MAX_RISKS }
}

/** The file's header and only the hunks that contain a line of a risk spot, with how many hunks it has. */
export function riskHunks(text: string, risks: ReadonlyArray<Pick<RawRisk, "start" | "end">>): { header: string; body: string; shown: number; total: number } {
  const lines = lineOf(text)
  const first = firstHunk(lines)
  if (first < 0) return { header: text, body: "", shown: 0, total: 0 }
  const rows = parseDiffRows(lines.slice(first))
  const total = rows.filter((row) => row.kind === "hunk").length
  const wanted = new Set(rows.filter((row) => row.new !== undefined && risks.some((risk) => row.new! >= risk.start && row.new! <= risk.end)).map((row) => row.hunk))
  const body = rows.filter((row) => wanted.has(row.hunk)).map((row) => row.text).join("\n")
  return { header: `${lines.slice(0, first).join("\n")}\n`, body: body ? `${body}\n` : "", shown: wanted.size, total }
}

/**
 * What the review pass sees of a file a reader read: the diff header, the reader's summary and risk spots (unverified), then the
 * whole diff when it is small, else only the hunks the risk spots touch. The real diff stays in `files`, so a finding on any line
 * of the file still checks against it.
 */
export function codeReadText(file: FileDiff, read: CodeRead, by: string): string {
  const { stats } = diffLines(file)
  const small = file.text.length <= SMALL_FILE_CHARS
  const spots = read.risks.length
    ? `Risk spots the reader flagged (new-side lines, hints):\n${read.risks.map((risk) => `- ${risk.start === risk.end ? risk.start : `${risk.start}-${risk.end}`} [${risk.kind}] ${risk.why}`).join("\n")}\n`
    : "The reader flagged no risk spot (a hint, not a clearance: it can miss things).\n"
  const hunks = small ? undefined : riskHunks(file.text, read.risks)
  const first = lineOf(file.text).findIndex((line) => line.startsWith("@@"))
  const header = hunks ? hunks.header : first < 0 ? file.text : `${lineOf(file.text).slice(0, first).join("\n")}\n`
  const body = hunks ? hunks.body : first < 0 ? "" : `${lineOf(file.text).slice(first).join("\n")}\n`
  const note = hunks ? `(${hunks.shown} of ${hunks.total} hunks shown: the ones with risk spots; the others were not flagged, open the file for them)\n` : ""
  return `${header}(+${stats.added.toLocaleString("en-US")} -${stats.removed.toLocaleString("en-US")} lines; read by ${by}${small ? "; small, shown whole" : ""})\nReader summary (${by}, unverified): ${read.changed}\n${spots}${body}${note}`
}
