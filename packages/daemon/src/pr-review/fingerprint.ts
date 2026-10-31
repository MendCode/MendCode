import { createHash } from "node:crypto"
import type { PrFinding } from "@mendcode/protocol"
import type { GitRun } from "./context"
import { findingId } from "./findings"

/**
 * A finding's identity across SHAs (docs/pr-review.md, R10). `PrFinding.id` hashes the line number, so it changes as soon as a
 * line is inserted above the finding; that id stays what a publish keys on for one head. The fingerprint hashes what the
 * finding is about instead (path, the flagged code line with whitespace normalised, category, the summary normalised), so a
 * finding found again after a rebase, a restack or an unrelated edit is recognised, and a child PR does not repeat what its
 * parent already reported. `remapFindings` moves known findings to their lines on a new head from `git diff -U0` hunks and
 * says honestly when a line was touched (`needs-recheck`) instead of guessing where it went.
 */

/** Indentation and runs of spaces do not change what a line does; a reformat should not make a new finding. */
export const normalizeLine = (text: string) => text.trim().replace(/\s+/g, " ")

/** Case, spacing, final punctuation and line numbers quoted in the text (`line 42`, `:42`) do not change what a finding says. */
export const normalizeSummary = (text: string) => text.toLowerCase().replace(/\b(lines?)\s+\d+(?:\s*[-–]\s*\d+)?/g, "$1 #").replace(/:\d+(?::\d+)?\b/g, ":#").replace(/\s+/g, " ").trim().replace(/[.!;,]+$/, "")

/** sha1 of path, the normalised code line, category and normalised summary. Unchanged by the line moving; changed by a rename. */
export function fingerprint(finding: Pick<PrFinding, "path" | "category" | "summary">, lineText: string): string {
  return createHash("sha1").update(`${finding.path}\n${normalizeLine(lineText)}\n${finding.category}\n${normalizeSummary(finding.summary)}`).digest("hex")
}

export type RemapStatus = "unchanged" | "moved" | "needs-recheck" | "deleted"
export type RemappedFinding = {
  /** The finding on `to`: path and lines moved and the `id` recomputed for them; the original when `deleted`. */
  finding: PrFinding
  /** Where it was on `from`, so a published comment or a thread can be traced to its new place. */
  previous: { id: string; path: string; line: number; endLine?: number | undefined }
  status: RemapStatus
  reason: string
}

type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number }
type FileChange = { oldPath: string; newPath?: string | undefined; hunks: Hunk[] }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** A path from a `---`/`+++`/`rename` line: prefix and the tab git appends to names with spaces removed, quotes undone. */
function diffPath(raw: string, prefix: string): string {
  let value = raw.replace(/\t$/, "")
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try { value = JSON.parse(value) as string } catch { value = value.slice(1, -1) }
  }
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value
}

/** `git diff -U0 -M` output to per-file hunks keyed by the old path. A file added on `to` is not keyed: nothing on `from` maps to it. */
export function parseZeroContextDiff(diff: string): Map<string, FileChange> {
  const files = new Map<string, FileChange>()
  for (const part of diff.split(/^(?=diff --git )/m).filter((text) => text.startsWith("diff --git "))) {
    const lines = part.replace(/\n$/, "").split("\n")
    let oldPath: string | undefined
    let newPath: string | undefined
    let added = false
    const hunks: Hunk[] = []
    for (const line of lines) {
      if (line.startsWith("rename from ")) oldPath = diffPath(line.slice("rename from ".length), "")
      else if (line.startsWith("rename to ")) newPath = diffPath(line.slice("rename to ".length), "")
      else if (line.startsWith("new file mode")) added = true
      else if (line.startsWith("--- ")) { if (line !== "--- /dev/null") oldPath ??= diffPath(line.slice(4), "a/") }
      else if (line.startsWith("+++ ")) newPath = line === "+++ /dev/null" ? undefined : newPath ?? diffPath(line.slice(4), "b/")
      else {
        const match = HUNK.exec(line)
        if (match) hunks.push({ oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]) })
      }
    }
    if (added) continue
    if (!oldPath) {
      // A mode-only or binary change without ---/+++ lines: both sides are named in the header.
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]!)
      if (!header) continue
      oldPath = header[1]!
      newPath ??= header[2]!
    }
    const deleted = lines.some((line) => line.startsWith("deleted file mode")) || lines.includes("+++ /dev/null")
    files.set(oldPath, { oldPath, newPath: deleted ? undefined : newPath ?? oldPath, hunks })
  }
  return files
}

/**
 * Where old lines `line`..`end` are after the hunks: `moved` by the net size of the hunks above them, or `touched` when a hunk
 * replaced or deleted one of them or inserted between them. A touched finding gets the hunk's new start as its best guess.
 */
function mapLines(hunks: readonly Hunk[], line: number, end: number): { touched: boolean; line: number; end: number } {
  let offset = 0
  for (const hunk of hunks) {
    const insertion = hunk.oldCount === 0
    const oldEnd = hunk.oldStart + hunk.oldCount - 1
    const overlaps = insertion ? hunk.oldStart >= line && hunk.oldStart < end : hunk.oldStart <= end && oldEnd >= line
    if (overlaps) {
      const at = Math.max(1, hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart)
      return { touched: true, line: at, end: at + (end - line) }
    }
    const above = insertion ? hunk.oldStart < line : oldEnd < line
    if (above) offset += hunk.newCount - hunk.oldCount
  }
  return { touched: false, line: line + offset, end: end + offset }
}

/** The finding at its new place, with the id `findingId` gives that place (what a publish on `to` keys on). */
function relocated(finding: PrFinding, path: string, line: number, end: number | undefined): PrFinding {
  const { endLine: _previousEnd, ...rest } = finding
  return { ...rest, path, line, ...(end !== undefined && end > line ? { endLine: end } : {}), id: findingId({ path, line, category: finding.category, summary: finding.summary }) }
}

/**
 * Each finding of `from` placed on `to`. `git diff -U0 -M from to` gives exact hunks: a line no hunk touched moves by the hunks
 * above it (and keeps its text, so its fingerprint); a touched line is `needs-recheck`, kept with its closest new line so a
 * reviewer looks at it again rather than dropping or silently keeping it; a renamed file carries the finding to the new path;
 * a deleted file marks it `deleted`. When the diff cannot be read, every finding is `needs-recheck`: never a claimed move.
 */
export async function remapFindings({ git, directory, from, to, findings }: { git: GitRun; directory: string; from: string; to: string; findings: readonly PrFinding[] }): Promise<RemappedFinding[]> {
  const previousOf = (finding: PrFinding): RemappedFinding["previous"] => ({ id: finding.id, path: finding.path, line: finding.line, ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}) })
  if (from === to) return findings.map((finding) => ({ finding, previous: previousOf(finding), status: "unchanged", reason: "same commit" }))
  const done = await git(["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv", from, to, "--"], directory)
  if (done.code !== 0) return findings.map((finding) => ({ finding, previous: previousOf(finding), status: "needs-recheck", reason: `[PR_REVIEW]: no diff ${from.slice(0, 12)}..${to.slice(0, 12)} (git exit ${done.code})` }))
  const files = parseZeroContextDiff(done.out)
  return findings.map((finding): RemappedFinding => {
    const previous = previousOf(finding)
    const change = files.get(finding.path)
    if (!change) return { finding, previous, status: "unchanged", reason: "file unchanged" }
    if (change.newPath === undefined) return { finding, previous, status: "deleted", reason: `${finding.path} deleted` }
    const mapped = mapLines(change.hunks, finding.line, finding.endLine ?? finding.line)
    const renamed = change.newPath !== finding.path
    const endLine = finding.endLine === undefined ? undefined : mapped.end
    const moved = relocated(finding, change.newPath, mapped.line, endLine)
    if (mapped.touched) return { finding: moved, previous, status: "needs-recheck", reason: `${finding.path}:${finding.line} changed${renamed ? ` (renamed to ${change.newPath})` : ""}` }
    if (!renamed && mapped.line === finding.line && endLine === finding.endLine) return { finding, previous, status: "unchanged", reason: "line not moved" }
    return { finding: moved, previous, status: "moved", reason: `${finding.path}:${finding.line} → ${change.newPath}:${mapped.line}` }
  })
}

/**
 * A reader of a commit's file lines for fingerprints: `git show <commit>:<path>` once per path, cached. Undefined for a missing
 * file or line (the finding's fingerprint is then unknown, and it is never treated as a duplicate).
 */
export function lineReader({ git, directory, commit }: { git: GitRun; directory: string; commit: string }): (path: string, line: number) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string[] | undefined>>()
  return async (path, line) => {
    if (!cache.has(path)) cache.set(path, git(["show", `${commit}:${path}`], directory).then((done) => done.code === 0 ? done.out.split("\n") : undefined))
    const lines = await cache.get(path)!
    return lines && line >= 1 && line <= lines.length ? lines[line - 1] : undefined
  }
}

/**
 * The child's findings without those its parent already reported. Inherited = same fingerprint as a parent finding: same path,
 * same code line text, same category, same summary, wherever the line sits on each head. `lineText` reads the line on the side
 * the finding belongs to (the child's head or the parent's); a finding whose line cannot be read is kept, since inheritance
 * cannot be shown.
 */
export function dedupeInherited({ child, parent, lineText }: { child: readonly PrFinding[]; parent: readonly PrFinding[]; lineText: (finding: PrFinding, side: "child" | "parent") => string | undefined }): { kept: PrFinding[]; inherited: Array<{ finding: PrFinding; parentId: string; fingerprint: string }> } {
  const known = new Map<string, string>()
  for (const finding of parent) {
    const text = lineText(finding, "parent")
    if (text !== undefined) known.set(fingerprint(finding, text), finding.id)
  }
  const kept: PrFinding[] = []
  const inherited: Array<{ finding: PrFinding; parentId: string; fingerprint: string }> = []
  for (const finding of child) {
    const text = lineText(finding, "child")
    const print = text === undefined ? undefined : fingerprint(finding, text)
    const parentId = print === undefined ? undefined : known.get(print)
    if (print !== undefined && parentId !== undefined) inherited.push({ finding, parentId, fingerprint: print })
    else kept.push(finding)
  }
  return { kept, inherited }
}
