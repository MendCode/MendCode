import path from "node:path"
import type { SessionId } from "@mendcode/protocol"

/**
 * One tree (docs/one-tree.md): several sessions working in the same checkout, no worktrees. The daemon remembers in memory
 * which files each session wrote. When a tool result names a file another session wrote recently (a `git status`, a test or
 * typecheck failure, a diff), or a session writes such a file itself, the result gets one line saying whose it is, so the model
 * does not take that work for the user's or for its own unfinished work. Nothing is added while a session works alone, a file
 * is named to a session at most once every few minutes, and no file is read or scanned: only tool output already in hand.
 */

/** How long a file another session wrote counts as that session's work in progress. */
export const ONE_TREE_LIVE_MS = 30 * 60_000
/** A file already named to a session is not named to it again for this long. */
const RENOTE_MS = 10 * 60_000
/** At most this many files in one line; the rest are counted. */
const MAX_NAMED = 6
/** Files remembered per session (the oldest go first). */
const MAX_TRACKED = 400

type Deps = {
  now(): number
  /** `features.one_tree` (balanced and full). Off: nothing is recorded and nothing is said. */
  enabled(): boolean
  title(sessionId: SessionId): string | undefined
}

export type OneTreeInput = {
  sessionId: SessionId
  /** The session's working directory: relative paths in the arguments and the output are read from it. */
  cwd: string
  /** Files this call wrote (empty for a call that wrote nothing). */
  written: readonly string[]
  /** The tool's output as the model will read it. */
  output: string
}

/** True when `needle` stands in `text` as a whole path (alone, after `./`, or after git diff's `a/` and `b/`): not the tail of a longer path or the start of a longer name. */
export function mentionsPath(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text.slice(Math.max(0, at - 2), at)
    const after = text.slice(at + needle.length, at + needle.length + 2)
    const startsClean = at === 0 || /[\s"'`(\[<:=,]$/.test(before) || /(^|[\s"'`(])(\.|a|b)\/$/.test(text.slice(Math.max(0, at - 3), at))
    const endsClean = !/^[\w-]/.test(after) && !/^\.\w/.test(after) && !/^\/\w/.test(after)
    if (startsClean && endsClean) return true
  }
  return false
}

const ago = (ms: number) => (ms < 60_000 ? "now" : `${Math.round(ms / 60_000)} min ago`)

export function createOneTree(deps: Deps) {
  const written = new Map<SessionId, Map<string, number>>()
  const noted = new Map<SessionId, Map<string, number>>()

  function record(sessionId: SessionId, files: readonly string[], at: number) {
    if (!files.length) return
    const own = written.get(sessionId) ?? new Map<string, number>()
    for (const file of files) {
      own.delete(file)
      own.set(file, at)
    }
    for (const [file, when] of own) if (own.size > MAX_TRACKED || at - when > ONE_TREE_LIVE_MS) own.delete(file)
    written.set(sessionId, own)
  }

  return {
    /** Records what the call wrote and returns the line for this result, or undefined when it names nobody else's files. */
    note({ sessionId, cwd, written: paths, output }: OneTreeInput): string | undefined {
      if (!deps.enabled()) return undefined
      const now = deps.now()
      const mine = paths.map((file) => path.resolve(cwd, file))
      record(sessionId, mine, now)
      const seen = noted.get(sessionId) ?? new Map<string, number>()
      // What was told long enough ago can be told again, so it need not be kept; past the cap the oldest goes.
      for (const [file, at] of seen) if (now - at >= RENOTE_MS || seen.size > MAX_TRACKED) seen.delete(file)
      const hits: Array<{ shown: string; by: SessionId; at: number }> = []
      for (const [by, files] of written) {
        if (by === sessionId) continue
        // Another session's writes past the live window are nobody's work in progress any more: they go when read.
        for (const [file, at] of files) if (now - at > ONE_TREE_LIVE_MS) files.delete(file)
        if (!files.size) {
          written.delete(by)
          continue
        }
        for (const [file, at] of files) {
          if (now - (seen.get(file) ?? -Infinity) < RENOTE_MS) continue
          const relative = path.relative(cwd, file)
          const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
          if (!mine.includes(file) && !mentionsPath(output, file) && !(inside && mentionsPath(output, relative))) continue
          hits.push({ shown: inside ? relative : file, by, at })
          seen.set(file, now)
        }
      }
      if (seen.size) noted.set(sessionId, seen)
      else noted.delete(sessionId)
      if (!hits.length) return undefined
      hits.sort((a, b) => b.at - a.at)
      const named = hits.slice(0, MAX_NAMED).map((hit) => {
        const title = deps.title(hit.by)?.trim()
        return `${hit.shown} (${title ? (title.startsWith("a sub-agent") ? title : `«${title.slice(0, 40)}»`) : "another session"}, ${ago(now - hit.at)})`
      })
      const more = hits.length > MAX_NAMED ? ` and ${hits.length - MAX_NAMED} more` : ""
      return `[one tree] Other sessions are changing these files in this checkout: ${named.join("; ")}${more}. They are not the user's edits and not unfinished work of yours: leave them, do not revert or fix them, and commit only the files you changed.`
    },
    /** A deleted session's files stop being anyone's work. */
    forget(sessionId: SessionId) {
      written.delete(sessionId)
      noted.delete(sessionId)
    },
  }
}

export type OneTree = ReturnType<typeof createOneTree>
