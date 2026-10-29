import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { isSkippedSegment, WALK_LIMITS } from "./util"

/** Shared by every pattern of one call: what the walk has listed so far and whether it stopped early. */
export type WalkBudget = { maxEntries: number; budgetMs: number; startedAt: number; entries: number; partial: boolean }

export const newWalkBudget = (limits: { maxEntries: number; budgetMs: number } = WALK_LIMITS): WalkBudget => ({ ...limits, startedAt: Date.now(), entries: 0, partial: false })

/** Directories outside any project that hold caches and application data: a search of the home folder leaves them out unless the pattern names them. */
export const heavyDirectories = (): string[] => (process.platform === "darwin" ? [join(homedir(), "Library")] : [])

const MAGIC = /[*?[\]{}!\\]/
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** True when `name` stands in the pattern as a whole path segment or brace alternative. */
const namesSegment = (pattern: string, name: string) => new RegExp(`(?:^|[/{,])${escapeRegExp(name)}(?:$|[/},])`).test(pattern)

/**
 * Files under `base` that match `pattern`, found by a walk the tool bounds itself:
 * - it starts at the pattern's fixed directories (`src/lib/**` reads only `src/lib`) and, without `**`, stays at the pattern's depth;
 * - `node_modules`, `.git`, the `heavy` directories and hidden entries are never listed unless the pattern names them, so their
 *   size costs nothing (a filter applied to the matches of a full scan still pays for the scan);
 * - breadth first, so a walk that runs out of `budget` has seen the shallow files; it then sets `budget.partial` and returns.
 * Symbolic links are neither followed nor returned.
 */
export async function walkGlob({ pattern, base, budget, signal, heavy = heavyDirectories(), onFile }: { pattern: string; base: string; budget: WalkBudget; signal: AbortSignal; heavy?: string[]; onFile(path: string): void }): Promise<void> {
  const absolute = pattern.startsWith("/")
  const segments = pattern.split("/").filter((segment) => segment !== "")
  if (segments.length === 0) return
  let fixed = 0
  while (fixed < segments.length - 1 && !MAGIC.test(segments[fixed] as string)) fixed++
  const prefix = `${absolute ? "/" : ""}${segments.slice(0, fixed).join("/")}`
  const lead = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`
  const normalized = `${lead}${segments.slice(fixed).join("/")}`
  const matcher = new Bun.Glob(normalized)
  // A brace alternative may hold a slash (`{a/b,c}/*.ts`): the depth is then not the number of segments.
  const maxDepth = normalized.includes("**") || /\{[^}]*\//.test(normalized) ? undefined : segments.length - fixed
  const hidden = [...normalized.matchAll(/(?:^|[/{,])(\.[^/{},]*)(\{?)/g)]
    .filter((found) => found[1] !== "." && found[1] !== "..")
    .map((found) => new Bun.Glob(`${found[1]}${found[2] ? "*" : ""}`))
  const named = (name: string) => namesSegment(normalized, name)
  const heavySet = new Set(heavy)

  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: resolve(base, prefix || "."), rel: "", depth: 1 }]
  for (let head = 0; head < queue.length; head++) {
    if (signal.aborted) return
    if (budget.entries >= budget.maxEntries || Date.now() - budget.startedAt > budget.budgetMs) {
      budget.partial = true
      return
    }
    const { dir, rel, depth } = queue[head] as { dir: string; rel: string; depth: number }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    budget.entries += entries.length
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith(".") && !hidden.some((glob) => glob.match(name))) continue
      const childRel = rel === "" ? name : `${rel}/${name}`
      if (entry.isDirectory()) {
        if (maxDepth !== undefined && depth >= maxDepth) continue
        const full = join(dir, name)
        if ((isSkippedSegment(name) || heavySet.has(full)) && !named(name)) continue
        queue.push({ dir: full, rel: childRel, depth: depth + 1 })
      } else if (entry.isFile() && (maxDepth === undefined || depth === maxDepth) && matcher.match(`${lead}${childRel}`)) {
        onFile(join(dir, name))
      }
    }
  }
}
