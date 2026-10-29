import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChangedFile } from "@mendcode/protocol"

export type DiffResult = { ok: true; text: string } | { ok: false; error: string }

type Hunk = { oldStart: number; lines: Array<{ kind: " " | "-" | "+"; text: string; noEol?: true }> }

function parseHunks(diff: string): Hunk[] | string {
  const hunks: Hunk[] = []
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw)
    if (header) { hunks.push({ oldStart: Number(header[1]), lines: [] }); continue }
    const hunk = hunks.at(-1)
    if (!hunk) { if (raw.trim()) return "the diff does not start with a hunk header"; continue }
    if (raw.startsWith("\\")) { const last = hunk.lines.at(-1); if (last) last.noEol = true; continue }
    const kind = raw[0]
    if (kind === " " || kind === "-" || kind === "+") hunk.lines.push({ kind, text: raw.slice(1) })
    else if (raw !== "") return `unexpected diff line "${raw.slice(0, 40)}"`
  }
  return hunks
}

/** Applies one file's hunks (the `ChangedFile.diff` text) to `original`; each hunk must match exactly, near where it says. */
export function applyFileDiff(original: string, diff: string): DiffResult {
  const hunks = parseHunks(diff)
  if (typeof hunks === "string") return { ok: false, error: hunks }
  const finalNewline = original === "" || original.endsWith("\n")
  const lines = original === "" ? [] : original.replace(/\n$/, "").split("\n")
  let delta = 0
  let endsWithNewline = finalNewline
  for (const [index, hunk] of hunks.entries()) {
    const before = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text)
    const after = hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text)
    // A hunk with no old lines inserts after line oldStart; any other starts at that line.
    const expected = Math.max(0, before.length === 0 ? hunk.oldStart + delta : hunk.oldStart - 1 + delta)
    let found = -1
    for (let distance = 0; distance <= lines.length && found < 0; distance++) {
      for (const at of distance === 0 ? [expected] : [expected - distance, expected + distance]) {
        if (at < 0 || at + before.length > lines.length) continue
        if (before.every((text, offset) => lines[at + offset] === text)) { found = at; break }
      }
    }
    if (found < 0) return { ok: false, error: `hunk ${index + 1} does not match the current file` }
    lines.splice(found, before.length, ...after)
    delta += after.length - before.length
    // A "\ No newline" marker on the last line of the new side decides whether the result ends with a newline.
    const newSideLast = hunk.lines.findLast((line) => line.kind !== "-")
    if (newSideLast && found + after.length >= lines.length) endsWithNewline = newSideLast.noEol !== true
  }
  return { ok: true, text: lines.length ? lines.join("\n") + (endsWithNewline ? "\n" : "") : "" }
}

export type PlannedChange = { path: string; oldPath?: string; action: "create" | "modify" | "delete" | "rename"; content?: string; note?: string }
export type PlanResult = { ok: true; changes: PlannedChange[] } | { ok: false; problems: string[] }

const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep)

/**
 * Works out, without writing, what applying a session's changes to `target` would do. All or nothing: a file that is
 * binary, cut short, outside the tree, or whose current content no longer matches the diff makes the plan fail.
 */
export async function planApply({ files, target }: { files: readonly ChangedFile[]; target: string }): Promise<PlanResult> {
  const problems: string[] = []
  const changes: PlannedChange[] = []
  const read = async (relative: string) => {
    try { return await readFile(path.join(target, relative), "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  for (const file of files) {
    const names = [file.path, ...(file.oldPath ? [file.oldPath] : [])]
    if (names.some((name) => !inside(target, path.resolve(target, name)))) { problems.push(`${file.path}: path leaves the target directory`); continue }
    if (file.binary) { problems.push(`${file.path}: binary files cannot be applied`); continue }
    if (file.truncated) { problems.push(`${file.path}: the recorded diff was cut short`); continue }
    const source = file.status === "renamed" && file.oldPath ? file.oldPath : file.path
    const current = await read(source)
    const adds = file.status === "added" || file.status === "untracked"
    if (adds && current !== undefined) {
      const created = applyFileDiff("", file.diff)
      if (created.ok && created.text === current) changes.push({ path: file.path, action: "create", note: "already present", content: current })
      else problems.push(`${file.path}: already exists with different content`)
      continue
    }
    if (current === undefined && !adds) { problems.push(`${source}: does not exist in the target`); continue }
    const applied = applyFileDiff(current ?? "", file.diff)
    if (!applied.ok) { problems.push(`${file.path}: ${applied.error}`); continue }
    if (file.status === "deleted") changes.push({ path: file.path, action: "delete" })
    else if (file.status === "renamed") changes.push({ path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), action: "rename", content: applied.text })
    else changes.push({ path: file.path, action: adds ? "create" : "modify", content: applied.text })
  }
  return problems.length ? { ok: false, problems } : { ok: true, changes }
}

/** Writes a plan made by `planApply`. */
export async function writePlan({ changes, target }: { changes: readonly PlannedChange[]; target: string }) {
  for (const change of changes) {
    const file = path.join(target, change.path)
    if (change.action === "delete") { await rm(file, { force: true }); continue }
    if (change.note === "already present") continue
    const mode = await stat(change.oldPath ? path.join(target, change.oldPath) : file).then((entry) => entry.mode & 0o777, () => undefined)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, change.content ?? "", mode === undefined ? undefined : { mode })
    if (change.oldPath && change.oldPath !== change.path) await rm(path.join(target, change.oldPath), { force: true })
  }
}
