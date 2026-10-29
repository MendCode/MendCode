import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { runManaged } from "../process"
import { defineTool } from "../tool"
import { errorMessage, fail, looksBinary, succeed, truncateText } from "../util"

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const GIT_TIMEOUT_MS = 15_000
const MAX_FILES = 60
const MAX_HUNKS_PER_FILE = 12
const MAX_UNTRACKED_BYTES = 200_000
/** A numbered file diff stays readable in one tool result. */
const LIMITS = { maxBytes: 30_000, maxLines: 600 } as const
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

type Status = "modified" | "added" | "deleted" | "renamed" | "untracked"
type Hunk = { header: string; context: string; oldStart: number; oldEnd: number; newStart: number; newEnd: number; lines: string[] }
type FileReview = { path: string; oldPath?: string; status: Status; binary: boolean; additions: number; deletions: number; hunks: Hunk[] }

const LETTER: Record<Status, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?" }

async function git({ root, args, signal }: { root: string; args: string[]; signal: AbortSignal }) {
  const result = await runManaged({
    argv: ["git", "-C", root, "--no-pager", "-c", "core.quotepath=off", "-c", "core.safecrlf=false", ...args],
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  })
  return { ok: result.exitCode === 0 && !result.spawnError && !result.cancelled && !result.timedOut, output: result.output, cancelled: result.cancelled }
}

function range(start: number, count: number) {
  return { start, end: start + Math.max(0, count - 1) }
}

function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of lines) {
    const match = HUNK.exec(line)
    if (match) {
      const old = range(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]))
      const added = range(Number(match[3]), match[4] === undefined ? 1 : Number(match[4]))
      hunks.push({ header: line, context: match[5] ?? "", oldStart: old.start, oldEnd: old.end, newStart: added.start, newEnd: added.end, lines: [] })
    } else if (hunks.length && (/^[ +\\-]/.test(line) || line === "")) hunks.at(-1)!.lines.push(line)
  }
  for (const hunk of hunks) while (hunk.lines.at(-1) === "") hunk.lines.pop()
  return hunks
}

function countChanges(hunks: Hunk[]) {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++
      else if (line.startsWith("-")) deletions++
    }
  return { additions, deletions }
}

/** Splits `git diff` output into files; text before the first `diff --git` (warnings) is ignored. */
export function parseDiff(output: string): FileReview[] {
  const files: FileReview[] = []
  for (const chunk of output.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n")
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
    const head = lines.slice(0, firstHunk >= 0 ? firstHunk : lines.length)
    const field = (prefix: string) => head.find((line) => line.startsWith(prefix))?.slice(prefix.length)
    const plus = field("+++ b/")
    const renameTo = field("rename to ")
    const renameFrom = field("rename from ")
    const header = /^a\/(.*) b\/(.*)$/.exec(lines[0] ?? "")
    const path = plus ?? renameTo ?? header?.[2] ?? lines[0] ?? "?"
    const deleted = head.some((line) => line.startsWith("deleted file mode") || line === "+++ /dev/null")
    const added = head.some((line) => line.startsWith("new file mode"))
    const hunks = parseHunks(lines)
    const status: Status = renameTo ? "renamed" : deleted ? "deleted" : added ? "added" : "modified"
    files.push({
      path,
      ...(renameFrom ? { oldPath: renameFrom } : {}),
      status,
      binary: head.some((line) => line.startsWith("Binary files") || line === "GIT binary patch"),
      ...countChanges(hunks),
      hunks,
    })
  }
  return files
}

async function untrackedFile({ root, path }: { root: string; path: string }): Promise<FileReview> {
  const base = { path, status: "untracked" as const, additions: 0, deletions: 0, hunks: [] as Hunk[] }
  try {
    const full = join(root, path)
    const info = await stat(full)
    if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return { ...base, binary: false }
    if (await looksBinary(full)) return { ...base, binary: true }
    const text = await readFile(full, "utf8")
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n")
    if (lines.length === 0) return { ...base, binary: false }
    const hunk: Hunk = { header: `@@ -0,0 +1,${lines.length} @@`, context: "", oldStart: 0, oldEnd: 0, newStart: 1, newEnd: lines.length, lines: lines.map((line) => `+${line}`) }
    return { ...base, binary: false, additions: lines.length, hunks: [hunk] }
  } catch {
    return { ...base, binary: false }
  }
}

function span(start: number, end: number) {
  return start === end ? String(start) : `${start}-${end}`
}

function summary({ files, branch }: { files: FileReview[]; branch: string }) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const lines = [`review: ${files.length} ${files.length === 1 ? "file" : "files"} changed, +${additions} -${deletions}${branch ? ` (branch ${branch})` : ""}`]
  for (const file of files.slice(0, MAX_FILES)) {
    const rename = file.oldPath ? ` (from ${file.oldPath})` : ""
    lines.push("", `${LETTER[file.status]} ${file.path}${rename}${file.binary ? " binary" : ` +${file.additions} -${file.deletions}`}`)
    for (const [index, hunk] of file.hunks.slice(0, MAX_HUNKS_PER_FILE).entries())
      lines.push(`  hunk ${index + 1}: old ${span(hunk.oldStart, hunk.oldEnd)}, new ${span(hunk.newStart, hunk.newEnd)}${hunk.context ? `  ${hunk.context.trim()}` : ""}`)
    if (file.hunks.length > MAX_HUNKS_PER_FILE) lines.push(`  … ${file.hunks.length - MAX_HUNKS_PER_FILE} more hunks`)
  }
  if (files.length > MAX_FILES) lines.push("", `… ${files.length - MAX_FILES} more files`)
  lines.push("", "Pass path to read one file's diff with old/new line numbers, then comment on those lines.")
  return lines.join("\n")
}

/** One file's hunks with both line numbers on every row, so a comment can cite the exact line. */
function numbered(file: FileReview) {
  const digits = Math.max(2, String(Math.max(0, ...file.hunks.map((hunk) => Math.max(hunk.oldEnd, hunk.newEnd)))).length)
  const pad = (value: number | undefined) => (value === undefined ? " ".repeat(digits) : String(value).padStart(digits))
  const rename = file.oldPath ? ` from ${file.oldPath}` : ""
  const out = [`${file.path} (${file.status}${rename}, +${file.additions} -${file.deletions})`]
  if (file.binary) out.push("binary file: no textual diff")
  else if (file.hunks.length === 0) out.push("no textual changes")
  for (const hunk of file.hunks) {
    out.push(hunk.header)
    let oldN = hunk.oldStart
    let newN = hunk.newStart
    for (const line of hunk.lines) {
      if (line.startsWith("+")) out.push(`${pad(undefined)} ${pad(newN++)} │ ${line}`)
      else if (line.startsWith("-")) out.push(`${pad(oldN++)} ${pad(undefined)} │ ${line}`)
      else if (line.startsWith("\\")) out.push(`${pad(undefined)} ${pad(undefined)} │ ${line}`)
      else out.push(`${pad(oldN++)} ${pad(newN++)} │ ${line}`)
    }
  }
  return out.join("\n")
}

export default defineTool({
  name: "review",
  description:
    "Review the working tree through the shared Changes workspace. Actions: current/summary, file (includePatch), navigate by filePath/blockIndex or next-file/prev-file/next-block/prev-block, reload, comment_add, comment_list, comment_clear (filePath/staleOnly). comment_add needs filePath, blockIndex, body; line/side anchor it. No staging or code edits. Legacy path reads one numbered diff.",
  permission: "read",
  args: z.object({
    path: z.string().min(1).optional().describe("Legacy alias for filePath"),
    action: z.enum(["current", "summary", "file", "navigate", "reload", "comment_add", "comment_list", "comment_clear"]).optional(),
    filePath: z.string().min(1).max(1024).optional(),
    blockIndex: z.number().int().nonnegative().optional(),
    line: z.number().int().positive().optional(),
    side: z.enum(["old", "new", "both"]).optional(),
    body: z.string().trim().min(1).max(800).optional(),
    author: z.enum(["user", "agent", "assistant"]).optional(),
    direction: z.enum(["next-file", "prev-file", "next-block", "prev-block"]).optional(),
    includePatch: z.boolean().optional(),
    staleOnly: z.boolean().optional(),
  }),
  async execute(args, context) {
    const path = args.path ?? args.filePath
    if (context.review) {
      const title = `Review ${args.action ?? (path ? "file" : "summary")}`
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      try {
        const result = await context.review.run(args)
        const clipped = truncateText({ text: result.output, limits: LIMITS })
        return succeed({ title, output: clipped.text, truncated: clipped.truncated, meta: result.meta })
      } catch (error) { return fail({ title, message: errorMessage(error) }) }
    }
    if (args.action) return fail({ title: `Review ${args.action}`, message: "shared review workspace is unavailable" })
    const title = path ? `review ${path}` : "review"
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const top = await git({ root: context.cwd, args: ["rev-parse", "--show-toplevel"], signal: context.signal })
      if (top.cancelled) return fail({ title, message: "cancelled" })
      if (!top.ok) return fail({ title, message: "not a git repository" })
      const root = top.output.trim()
      const branch = (await git({ root, args: ["rev-parse", "--abbrev-ref", "HEAD"], signal: context.signal })).output.trim()
      const hasHead = (await git({ root, args: ["rev-parse", "--verify", "--quiet", "HEAD"], signal: context.signal })).ok
      const diff = await git({ root, args: ["diff", hasHead ? "HEAD" : EMPTY_TREE, "-M", "--no-color", "--no-ext-diff", "--unified=3"], signal: context.signal })
      if (diff.cancelled) return fail({ title, message: "cancelled" })
      if (!diff.ok) return fail({ title, message: `git diff failed: ${diff.output.trim().split("\n")[0] ?? "unknown error"}` })
      const untracked = await git({ root, args: ["ls-files", "--others", "--exclude-standard", "-z"], signal: context.signal })
      const files = parseDiff(diff.output)
      const known = new Set(files.map((file) => file.path))
      const names = untracked.ok ? untracked.output.split("\0").filter((name) => name && !known.has(name)) : []
      for (const name of names.slice(0, MAX_FILES)) files.push(await untrackedFile({ root, path: name }))
      files.sort((a, b) => a.path.localeCompare(b.path))
      const meta = { files: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) }
      if (files.length === 0) return succeed({ title, output: "no changes in the working tree", meta })
      if (!path) {
        const capped = truncateText({ text: summary({ files, branch: branch === "HEAD" ? "" : branch }), limits: LIMITS })
        return succeed({ title, output: capped.text, truncated: capped.truncated, meta })
      }
      const wanted = path.replace(/^\.\//, "")
      const file = files.find((entry) => entry.path === wanted)
      if (!file) return fail({ title, message: `${wanted} has no changes; changed files: ${files.slice(0, 20).map((entry) => entry.path).join(", ")}${files.length > 20 ? ", …" : ""}` })
      const capped = truncateText({ text: numbered(file), limits: LIMITS })
      return succeed({ title, output: capped.text, truncated: capped.truncated, meta: { ...meta, additions: file.additions, deletions: file.deletions, hunks: file.hunks.length } })
    } catch (error) {
      return fail({ title, message: `review failed: ${errorMessage(error)}` })
    }
  },
})
