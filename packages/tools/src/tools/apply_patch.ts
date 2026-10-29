import { readFile, rm, stat } from "node:fs/promises"
import { z } from "zod"
import { defineTool } from "../tool"
import { atomicWrite, boundPreview, displayPath, errorMessage, exists, fail, renderDiff, resolvePath, succeed, truncateText, withFileLock } from "../util"

type Hunk = { header: string | undefined; oldLines: string[]; newLines: string[]; /** `*** End of File` followed it: its lines are the file's last. */ atEnd?: boolean }
type FileOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | undefined; hunks: Hunk[] }

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

class PatchError extends Error {}

function parsePatch(patch: string): FileOp[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop()
  if (lines[0]?.trim() !== BEGIN) throw new PatchError(`patch must start with "${BEGIN}"`)
  if (lines[lines.length - 1]?.trim() !== END) throw new PatchError(`patch must end with "${END}"`)
  const body = lines.slice(1, -1)
  const ops: FileOp[] = []
  let i = 0
  const isHeader = (line: string | undefined) => line !== undefined && /^\*\*\* (Add|Update|Delete) File: /.test(line)
  while (i < body.length) {
    const line = body[i] as string
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim()
      const content: string[] = []
      i++
      while (i < body.length && !isHeader(body[i])) {
        const row = body[i] as string
        if (!row.startsWith("+")) throw new PatchError(`add file ${path}: lines must start with "+" (got "${row}")`)
        content.push(row.slice(1))
        i++
      }
      ops.push({ kind: "add", path, lines: content })
    } else if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim() })
      i++
    } else if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim()
      i++
      let moveTo: string | undefined
      if (body[i]?.startsWith("*** Move to: ")) {
        moveTo = (body[i] as string).slice("*** Move to: ".length).trim()
        i++
      }
      const hunks: Hunk[] = []
      let current: Hunk | undefined
      while (i < body.length && !isHeader(body[i])) {
        const row = body[i] as string
        i++
        if (row.startsWith("*** End of File")) {
          if (current) current.atEnd = true
          continue
        }
        if (row.startsWith("@@")) {
          current = { header: row.slice(2).trim() || undefined, oldLines: [], newLines: [] }
          hunks.push(current)
          continue
        }
        if (!current) {
          current = { header: undefined, oldLines: [], newLines: [] }
          hunks.push(current)
        }
        const marker = row[0]
        const text = row.slice(1)
        if (row === "") {
          current.oldLines.push("")
          current.newLines.push("")
        } else if (marker === " ") {
          current.oldLines.push(text)
          current.newLines.push(text)
        } else if (marker === "-") {
          current.oldLines.push(text)
        } else if (marker === "+") {
          current.newLines.push(text)
        } else throw new PatchError(`update file ${path}: unexpected line "${row}"`)
      }
      if (hunks.length === 0) throw new PatchError(`update file ${path}: no hunks`)
      ops.push({ kind: "update", path, moveTo, hunks })
    } else {
      throw new PatchError(`unexpected line "${line}"`)
    }
  }
  if (ops.length === 0) throw new PatchError("patch contains no file operations")
  return ops
}

/** Every place from `from` on where `needle` sits, under the strictest comparison (exact, then trailing space, then both ends) that finds any. */
function findAll({ haystack, needle, from }: { haystack: string[]; needle: string[]; from: number }): number[] {
  const passes: Array<(s: string) => string> = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()]
  for (const normalize of passes) {
    const wanted = needle.map(normalize)
    const found: number[] = []
    for (let start = from; start + wanted.length <= haystack.length; start++) {
      let matched = true
      for (let k = 0; k < wanted.length; k++) {
        if (normalize(haystack[start + k] as string) !== wanted[k]) {
          matched = false
          break
        }
      }
      if (matched) found.push(start)
    }
    if (found.length > 0) return found
  }
  return []
}

/** Where the file most resembles the hunk's first meaningful line, with what it has there: the usual mismatch is one changed word, and this saves a re-read. */
function closestLine({ lines, wanted }: { lines: string[]; wanted: string[] }): string {
  const target = wanted.find((line) => line.trim() !== "")?.trim()
  if (!target) return ""
  let best = -1, bestShared = 7
  lines.forEach((line, index) => {
    const candidate = line.trim()
    let shared = 0
    while (shared < candidate.length && shared < target.length && candidate[shared] === target[shared]) shared++
    if (shared > bestShared) { best = index; bestShared = shared }
  })
  return best === -1 ? "" : `; closest line ${best + 1}: ${(lines[best] as string).trim().slice(0, 160)}`
}

/** A hunk's place in the file as it was before the patch: `length` lines from `start` become `lines`. */
type Placement = { hunk: number; start: number; length: number; lines: string[] }

/**
 * Where one hunk goes. Hunks are matched against the file as it is on disk, never against lines an earlier hunk wrote. In file
 * order the first match after the previous hunk wins; a hunk that is not there is looked for in the whole file and must fit
 * exactly one place that no other hunk has claimed.
 */
function placeHunk({ path, lines, hunk, number, cursor, placed }: { path: string; lines: string[]; hunk: Hunk; number: number; cursor: number; placed: Placement[] }): number {
  const headerAt = hunk.header === undefined ? undefined : findAll({ haystack: lines, needle: [hunk.header], from: 0 })
  if (headerAt?.length === 0) throw new PatchError(`update ${path}: context "${hunk.header}" not found`)
  if (hunk.oldLines.length === 0) return lines.length
  const claimedBy = (start: number) => placed.find((other) => other.length > 0 && start < other.start + other.length && other.start < start + hunk.oldLines.length)
  // A hunk marked as the end of the file goes where its lines end the file, whatever matches earlier.
  if (hunk.atEnd) {
    const last = lines.length - hunk.oldLines.length
    if (last >= cursor && findAll({ haystack: lines, needle: hunk.oldLines, from: last }).includes(last) && !claimedBy(last)) return last
  }
  const after = headerAt === undefined ? cursor : headerAt.find((at) => at >= cursor)
  if (after !== undefined) {
    const forward = findAll({ haystack: lines, needle: hunk.oldLines, from: headerAt === undefined ? after : after + 1 }).find((start) => !claimedBy(start))
    if (forward !== undefined) return forward
  }
  const anywhere = findAll({ haystack: lines, needle: hunk.oldLines, from: 0 }).filter((start) => headerAt === undefined || start > (headerAt[0] as number))
  const free = anywhere.filter((start) => !claimedBy(start))
  if (free.length === 1) return free[0] as number
  if (free.length > 1) {
    throw new PatchError(`update ${path}: hunk ${number} is out of file order and matches ${free.length} places (lines ${free.map((start) => start + 1).join(", ")}); add context lines to make it unique or put the hunks in file order`)
  }
  if (anywhere.length > 0) {
    throw new PatchError(`update ${path}: hunk ${number} overlaps hunk ${claimedBy(anywhere[0] as number)!.hunk} (line ${(anywhere[0] as number) + 1}); merge them into one hunk`)
  }
  const preview = hunk.oldLines.slice(0, 3).join("\\n")
  throw new PatchError(`update ${path}: hunk does not match the file (looking for "${preview}")${closestLine({ lines, wanted: hunk.oldLines })}`)
}

function applyHunks({ path, original: onDisk, hunks, renamed }: { path: string; original: string; hunks: Hunk[]; renamed: boolean }): string {
  // A file whose every line ends in CRLF is patched as LF (the patch itself is LF) and written back with CRLF; a mixed file is left as it is.
  const crlf = onDisk.includes("\r\n") && !/(?:^|[^\r])\n/.test(onDisk)
  const original = crlf ? onDisk.replace(/\r\n/g, "\n") : onDisk
  const endsWithNewline = original.endsWith("\n")
  const lines = original.split("\n")
  if (endsWithNewline) lines.pop()
  const placed: Placement[] = []
  let cursor = 0
  for (const [index, hunk] of hunks.entries()) {
    const number = index + 1
    const start = placeHunk({ path, lines, hunk, number, cursor, placed })
    cursor = start + hunk.oldLines.length
    // A hunk that changes nothing is an anchor: models send a context-only hunk to say where the next one goes (measured: 6 of 9
    // rejected patches were this shape, each costing a regenerated patch). It moves the cursor and claims no lines; a patch that
    // changes nothing in the whole file is still refused below.
    if (hunk.oldLines.length === hunk.newLines.length && hunk.oldLines.every((line, k) => line === hunk.newLines[k])) continue
    placed.push({ hunk: number, start, length: hunk.oldLines.length, lines: hunk.newLines })
  }
  const result: string[] = []
  let copied = 0
  for (const placement of [...placed].sort((a, b) => a.start - b.start || a.hunk - b.hunk)) {
    result.push(...lines.slice(copied, placement.start), ...placement.lines)
    copied = placement.start + placement.length
  }
  result.push(...lines.slice(copied))
  const updated = result.join("\n") + (endsWithNewline || result.length === 0 ? "\n" : "")
  if (!renamed && updated === original) throw new PatchError(`update ${path}: the patch leaves the file exactly as it is (no hunk adds or removes a line, or its "-" and "+" lines differ only in whitespace); mark the lines to change with "-" and "+"`)
  return crlf ? updated.replace(/\n/g, "\r\n") : updated
}

type Planned = { write: Map<string, string>; remove: Set<string>; summary: string[]; preview: string[]; /** The permission bits a moved file takes to its new path. */ modes: Map<string, number> }

async function plan({ ops, cwd }: { ops: FileOp[]; cwd: string }): Promise<Planned> {
  const write = new Map<string, string>()
  const remove = new Set<string>()
  const modes = new Map<string, number>()
  const touched = new Set<string>()
  const summary: string[] = []
  const preview: string[] = []
  const touch = (abs: string, shown: string) => {
    if (touched.has(abs)) throw new PatchError(`${shown} is modified more than once in the patch`)
    touched.add(abs)
  }
  for (const op of ops) {
    const abs = resolvePath({ cwd, path: op.path })
    const shown = displayPath({ cwd, path: abs })
    touch(abs, shown)
    if (op.kind === "add") {
      if (await exists(abs)) throw new PatchError(`add ${shown}: file already exists`)
      write.set(abs, op.lines.length === 0 ? "" : `${op.lines.join("\n")}\n`)
      summary.push(`A ${shown}`)
      preview.push(`*** Add File: ${shown}`, ...op.lines.map((line) => `+${line}`))
    } else if (op.kind === "delete") {
      if (!(await exists(abs))) throw new PatchError(`delete ${shown}: file does not exist`)
      remove.add(abs)
      summary.push(`D ${shown}`)
      preview.push(`*** Delete File: ${shown}`)
    } else {
      let original: string
      try {
        original = await readFile(abs, "utf8")
      } catch {
        throw new PatchError(`update ${shown}: file does not exist`)
      }
      const updated = applyHunks({ path: shown, original, hunks: op.hunks, renamed: op.moveTo !== undefined })
      if (op.moveTo) {
        const dest = resolvePath({ cwd, path: op.moveTo })
        const destShown = displayPath({ cwd, path: dest })
        touch(dest, destShown)
        if (await exists(dest)) throw new PatchError(`move ${shown}: ${destShown} already exists`)
        write.set(dest, updated)
        modes.set(dest, (await stat(abs)).mode & 0o777)
        remove.add(abs)
        summary.push(`M ${shown} -> ${destShown}`)
        preview.push(`*** Update File: ${shown} -> ${destShown}`, renderDiff({ before: original, after: updated }))
      } else {
        write.set(abs, updated)
        summary.push(`M ${shown}`)
        preview.push(`*** Update File: ${shown}`, renderDiff({ before: original, after: updated }))
      }
    }
  }
  return { write, remove, summary, preview, modes }
}

async function commit({ planned }: { planned: Planned }): Promise<void> {
  const backups = new Map<string, { content: string; mode: number } | null>()
  const paths = [...planned.write.keys(), ...planned.remove]
  for (const path of paths) backups.set(path, (await exists(path)) ? { content: await readFile(path, "utf8"), mode: (await stat(path)).mode & 0o777 } : null)
  try {
    for (const [path, content] of planned.write) await atomicWrite({ path, content, ...(planned.modes.has(path) ? { mode: planned.modes.get(path)! } : {}) })
    for (const path of planned.remove) await rm(path)
  } catch (error) {
    for (const [path, backup] of backups) {
      if (backup === null) await rm(path, { force: true })
      else await atomicWrite({ path, content: backup.content, mode: backup.mode })
    }
    throw error
  }
}

export default defineTool({
  name: "apply_patch",
  description:
    'Apply a multi-file patch. Format: "*** Begin Patch", then "*** Add File: p" (+lines), "*** Update File: p" (optional "*** Move to: q", "@@ context" hunks with " ", "-", "+" lines) or "*** Delete File: p", then "*** End Patch". All-or-nothing.',
  permission: "write",
  args: z.object({ patch: z.string().describe("The full patch text") }),
  async preview({ patch }, context) {
    try {
      const planned = await plan({ ops: parsePatch(patch), cwd: context.cwd })
      return boundPreview(planned.preview.join("\n"))
    } catch {
      return undefined
    }
  },
  async execute({ patch }, context) {
    const title = "Apply patch"
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const ops = parsePatch(patch)
      // Every file the patch reads or writes is held for the whole plan and commit: another session's edit cannot land in between.
      const files = ops.flatMap((op) => [resolvePath({ cwd: context.cwd, path: op.path }), ...(op.kind === "update" && op.moveTo ? [resolvePath({ cwd: context.cwd, path: op.moveTo })] : [])])
      const planned = await withFileLock(files, async () => {
        const planned = await plan({ ops, cwd: context.cwd })
        if (context.signal.aborted) return undefined
        await commit({ planned })
        return planned
      })
      if (!planned) return fail({ title, message: "cancelled" })
      const capped = truncateText({ text: planned.summary.join("\n"), ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      // The model wrote the patch and is told only which files changed; the card shows the diff, as edit's does.
      return {
        ...succeed({
          title: `Apply patch (${ops.length} ${ops.length === 1 ? "file" : "files"})`,
          output: capped.text,
          truncated: capped.truncated,
          meta: { files: ops.length },
        }),
        display: boundPreview(planned.preview.join("\n")),
      }
    } catch (error) {
      if (error instanceof PatchError) return fail({ title, message: `${error.message}; no files changed` })
      return fail({ title, message: `patch failed: ${errorMessage(error)}` })
    }
  },
})
