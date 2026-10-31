import type { PrFinding, PrJobSummary } from "@mendcode/protocol"
import type { GitRun } from "./context"
import type { PrFacts, StackGraph, StackNode } from "./contracts"

/**
 * Stacked pull requests as an explicit graph (docs/pr-review.md, R10). A PR is stacked on another when its base branch is that
 * PR's head branch, the way Graphite and `git town` stack branches. The graph is built from the provider's open PRs only, never
 * guessed from commit ancestry: two PRs whose heads share commits are not a stack unless one targets the other's branch.
 *
 * What the graph is for: a child is reviewed on its own commits (`ownRange`, from the merge base with the parent's head, not
 * the trunk), so the parent's changes are not reviewed twice; a move of the parent (update, rebase, retarget, merge) marks the
 * child and its descendants for revalidation (`stackChanges`). MendCode never restacks: rewriting someone else's branches is
 * the author's call, so `restackAdvice` only says what to run, which branch a fix belongs to, and which files would conflict.
 */

const SHA = /^[0-9a-f]{7,64}$/

/** A PR's head branch can parent another PR only when it lives in the base repository: a fork's `main` is not the repo's `main`. */
const canParent = (pr: PrFacts) => !pr.fork

/**
 * The stack graph of a repository's open PRs. Parent of a PR = the open, same-repository PR whose `headRef` equals its `baseRef`.
 * Forks are never parents (their branch only shares the name). Several same-repository candidates (one branch open as the head
 * of two PRs against different bases) leave the PR without a parent and listed in `ambiguous`: picking one would review the
 * wrong range. A cycle (A targets
 * B's branch and B targets A's) is listed in `cycles` and its links are cut, so no walk over the graph can loop; its members
 * become parentless heads of whatever hangs below them. `roots` are the parentless PRs outside any cycle, ascending.
 */
export function buildStackGraph(prs: readonly PrFacts[]): StackGraph {
  const unique = new Map<number, PrFacts>()
  for (const pr of prs) if (!unique.has(pr.number)) unique.set(pr.number, pr)
  const byHeadRef = new Map<string, number[]>()
  for (const pr of unique.values()) if (canParent(pr)) byHeadRef.set(pr.headRef, [...(byHeadRef.get(pr.headRef) ?? []), pr.number])
  const nodes = new Map<number, StackNode>()
  const ambiguous: StackGraph["ambiguous"] = []
  for (const pr of [...unique.values()].sort((a, b) => a.number - b.number)) {
    const candidates = (byHeadRef.get(pr.baseRef) ?? []).filter((number) => number !== pr.number).sort((a, b) => a - b)
    if (candidates.length > 1) ambiguous.push({ number: pr.number, candidates })
    nodes.set(pr.number, { number: pr.number, baseRef: pr.baseRef, headRef: pr.headRef, head: pr.head, base: pr.base, ...(candidates.length === 1 ? { parent: candidates[0] } : {}), children: [], depth: 0 })
  }
  const cycles = findCycles(nodes)
  for (const cycle of cycles) for (const number of cycle) delete nodes.get(number)!.parent
  for (const node of nodes.values()) if (node.parent !== undefined) nodes.get(node.parent)!.children.push(node.number)
  for (const node of nodes.values()) node.children.sort((a, b) => a - b)
  const inCycle = new Set(cycles.flat())
  const roots = [...nodes.values()].filter((node) => node.parent === undefined && !inCycle.has(node.number)).map((node) => node.number)
  const depthFrom = (number: number, depth: number) => {
    const node = nodes.get(number)!
    node.depth = depth
    for (const child of node.children) depthFrom(child, depth + 1)
  }
  for (const head of [...roots, ...inCycle]) depthFrom(head, 0)
  return { nodes, roots, cycles, ambiguous }
}

/** Each cycle once, as the numbers along the parent links starting from its smallest member. */
function findCycles(nodes: ReadonlyMap<number, StackNode>): number[][] {
  const cycles: number[][] = []
  const done = new Set<number>()
  for (const start of nodes.keys()) {
    const path: number[] = []
    const onPath = new Map<number, number>()
    let current: number | undefined = start
    while (current !== undefined && !done.has(current) && !onPath.has(current)) {
      onPath.set(current, path.length)
      path.push(current)
      current = nodes.get(current)?.parent
    }
    if (current !== undefined && onPath.has(current)) {
      const cycle = path.slice(onPath.get(current))
      const first = cycle.indexOf(Math.min(...cycle))
      cycles.push([...cycle.slice(first), ...cycle.slice(0, first)])
    }
    for (const number of path) done.add(number)
  }
  return cycles.sort((a, b) => a[0]! - b[0]!)
}

/** Every PR below `number` in the graph, nearest first (breadth-first), never `number` itself. */
export function descendants(graph: StackGraph, number: number): number[] {
  const found: number[] = []
  const seen = new Set([number])
  const queue = [...(graph.nodes.get(number)?.children ?? [])]
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next)) continue
    seen.add(next)
    found.push(next)
    queue.push(...(graph.nodes.get(next)?.children ?? []))
  }
  return found
}

/** The parent chain of `number`, nearest first; bounded by the graph's size so even a hand-built cyclic graph ends. */
export function ancestors(graph: StackGraph, number: number): number[] {
  const found: number[] = []
  let current = graph.nodes.get(number)?.parent
  while (current !== undefined && !found.includes(current) && current !== number && found.length < graph.nodes.size) {
    found.push(current)
    current = graph.nodes.get(current)?.parent
  }
  return found
}

export type OwnRange =
  | {
    ok: true
    /** Diff `base..head` (or `base...head`, the same here: `base` is an ancestor of `head`). */
    base: string
    head: string
    /** The parent whose head the range starts from; unset for a PR on the trunk (or one whose parent is unknown). */
    parent?: number | undefined
    /** The child no longer contains its parent's current head: the parent moved and the child was not restacked. */
    restack: boolean
    reason: string
  }
  | { ok: false; reason: string }

const ok = async (git: GitRun, directory: string, args: string[]) => (await git(args, directory)).code === 0
const firstLine = async (git: GitRun, directory: string, args: string[]) => {
  const done = await git(args, directory)
  const line = done.out.trim().split("\n")[0] ?? ""
  return done.code === 0 && SHA.test(line) ? line : undefined
}

/**
 * The range of the PR's own commits. On the trunk: the merge base of its base and head, as a plain review. Stacked: the merge
 * base of the parent's head and the PR's head, so the parent's commits (already reviewed on the parent) are left out. When the
 * parent moved and the child was not restacked, the merge base falls back to the trunk and would drag the parent's old commits
 * in; `previousParentHead` (the parent head the child was built on, from the last snapshot) is then the base when the child
 * still contains it, which is exactly what `git rebase --onto <new parent> <old parent>` would replay. The commits must be
 * fetched in `directory`; a missing one is `ok: false`, never a guess.
 */
export async function ownRange({ node, graph, git, directory, previousParentHead }: { node: StackNode; graph: StackGraph; git: GitRun; directory: string; previousParentHead?: string | undefined }): Promise<OwnRange> {
  if (!await ok(git, directory, ["rev-parse", "--verify", "--quiet", `${node.head}^{commit}`])) return { ok: false, reason: `[PR_REVIEW]: #${node.number}'s head ${node.head.slice(0, 12)} is not fetched` }
  const parent = node.parent === undefined ? undefined : graph.nodes.get(node.parent)
  if (!parent) {
    const base = await firstLine(git, directory, ["merge-base", node.base, node.head])
    if (!base) return { ok: false, reason: `[PR_REVIEW]: no merge base between #${node.number}'s base ${node.base.slice(0, 12)} and head` }
    const why = graph.ambiguous.find((entry) => entry.number === node.number) ? `parent ambiguous (${graph.ambiguous.find((entry) => entry.number === node.number)!.candidates.map((n) => `#${n}`).join(", ")}): reviewed against its base` : graph.cycles.some((cycle) => cycle.includes(node.number)) ? "in a stack cycle: reviewed against its base" : "on its base branch"
    return { ok: true, base, head: node.head, restack: false, reason: why }
  }
  const contains = await ok(git, directory, ["merge-base", "--is-ancestor", parent.head, node.head])
  if (contains) return { ok: true, base: parent.head, head: node.head, parent: parent.number, restack: false, reason: `own commits on #${parent.number}` }
  if (previousParentHead && previousParentHead !== parent.head && await ok(git, directory, ["merge-base", "--is-ancestor", previousParentHead, node.head])) {
    return { ok: true, base: previousParentHead, head: node.head, parent: parent.number, restack: true, reason: `#${parent.number} moved and #${node.number} was not restacked: own commits since #${parent.number}'s previous head` }
  }
  const base = await firstLine(git, directory, ["merge-base", parent.head, node.head])
  if (!base) return { ok: false, reason: `[PR_REVIEW]: no merge base between #${node.number} and its parent #${parent.number}` }
  return { ok: true, base, head: node.head, parent: parent.number, restack: true, reason: `#${node.number} does not contain #${parent.number}'s head: needs a restack; the range may include commits #${parent.number} rewrote` }
}

export type StackChangeKind = "parent-updated" | "rebased" | "retargeted" | "parent-merged" | "parent-closed"
export type StackChange = {
  number: number
  kinds: StackChangeKind[]
  /** The parent in the previous and in the next graph (a retarget or a parent merge changes it). */
  parent: { before?: number | undefined; after?: number | undefined }
  /** The parent head the PR was built on, for `ownRange`'s `previousParentHead`. */
  previousParentHead?: string | undefined
  /** The PR itself and every PR below it in the next graph: their ranges or their parent's content changed. */
  revalidate: number[]
  reason: string
}

/**
 * What moved in a stack between two snapshots, per PR still open in `next`:
 * - `parent-updated`: same parent, whose head moved (new commits, or the parent was rebased).
 * - `rebased`: the PR's own head and base both moved under the same base branch (a restack, a rebase or a merge of the base).
 * - `retargeted`: its base branch changed (by hand, or by the provider after the parent merged).
 * - `parent-merged` / `parent-closed`: the parent is no longer open; `merged` says which closed PRs were merged, the provider
 *   being the only one that knows.
 * PRs new in `next` are not changes (they get their first review anyway). `revalidate` of the whole result is the union, in
 * the order found, so a caller queues each PR once.
 */
export function stackChanges(previous: StackGraph, next: StackGraph, options: { merged?: ReadonlySet<number> | undefined } = {}): { changes: StackChange[]; revalidate: number[] } {
  const changes: StackChange[] = []
  for (const node of [...next.nodes.values()].sort((a, b) => a.depth - b.depth || a.number - b.number)) {
    const before = previous.nodes.get(node.number)
    if (!before) continue
    const kinds: StackChangeKind[] = []
    const reasons: string[] = []
    const oldParent = before.parent === undefined ? undefined : previous.nodes.get(before.parent)
    if (before.baseRef !== node.baseRef) { kinds.push("retargeted"); reasons.push(`base ${before.baseRef} → ${node.baseRef}`) }
    if (oldParent && !next.nodes.has(oldParent.number)) {
      const merged = options.merged?.has(oldParent.number) === true
      kinds.push(merged ? "parent-merged" : "parent-closed")
      reasons.push(`#${oldParent.number} ${merged ? "merged" : "closed"}`)
    } else if (oldParent && node.parent === oldParent.number && next.nodes.get(oldParent.number)!.head !== oldParent.head) {
      kinds.push("parent-updated")
      reasons.push(`#${oldParent.number} head ${oldParent.head.slice(0, 7)} → ${next.nodes.get(oldParent.number)!.head.slice(0, 7)}`)
    }
    if (before.baseRef === node.baseRef && before.head !== node.head && before.base !== node.base && !kinds.includes("parent-updated")) {
      kinds.push("rebased")
      reasons.push(`head and base moved (base ${before.base.slice(0, 7)} → ${node.base.slice(0, 7)})`)
    } else if (kinds.includes("parent-updated") && before.head !== node.head) {
      kinds.push("rebased")
      reasons.push(`own head ${before.head.slice(0, 7)} → ${node.head.slice(0, 7)}`)
    }
    if (!kinds.length && before.parent !== node.parent) { kinds.push("retargeted"); reasons.push(`parent ${before.parent === undefined ? "none" : `#${before.parent}`} → ${node.parent === undefined ? "none" : `#${node.parent}`}`) }
    if (!kinds.length) continue
    changes.push({ number: node.number, kinds, parent: { before: before.parent, after: node.parent }, ...(oldParent ? { previousParentHead: oldParent.head } : {}), revalidate: [node.number, ...descendants(next, node.number)], reason: reasons.join("; ") })
  }
  const revalidate: number[] = []
  for (const change of changes) for (const number of change.revalidate) if (!revalidate.includes(number)) revalidate.push(number)
  return { changes, revalidate }
}

/** What a job summary shows of the PR's place in its stack; undefined for a PR that is not stacked. */
export function stackSummary(graph: StackGraph, number: number): PrJobSummary["stack"] {
  const node = graph.nodes.get(number)
  if (!node || (node.parent === undefined && node.children.length === 0)) return undefined
  return { ...(node.parent !== undefined ? { parent: node.parent } : {}), children: node.children.slice(0, 50), depth: node.depth }
}

export type FixTarget = { number: number; branch: string; inherited: boolean; reason: string }

/**
 * The branch a fix for `finding` belongs to: the nearest PR, from `number` up its parents, whose own range changed the line
 * (`owns` answers that from each PR's `ownRange` diff, matched by fingerprint so line moves between heads do not matter).
 * A finding in the parent's own range is fixed on the parent and reaches the child by a restack; none owning it, the PR itself.
 */
export function fixTarget({ graph, number, finding, owns }: { graph: StackGraph; number: number; finding: PrFinding; owns: (pr: number, finding: PrFinding) => boolean }): FixTarget {
  const node = graph.nodes.get(number)
  if (!node) throw new RangeError(`[PR_REVIEW]: #${number} is not in the stack graph`)
  if (owns(number, finding)) return { number, branch: node.headRef, inherited: false, reason: `${finding.path}:${finding.line} is in #${number}'s own changes` }
  for (const ancestor of ancestors(graph, number)) {
    const owner = graph.nodes.get(ancestor)!
    if (owns(ancestor, finding)) return { number: ancestor, branch: owner.headRef, inherited: true, reason: `${finding.path}:${finding.line} comes from #${ancestor} (${owner.headRef}); fix it there, then restack #${number}` }
  }
  return { number, branch: node.headRef, inherited: false, reason: `no PR in the stack changed ${finding.path}:${finding.line}; fix it on #${number}` }
}

/**
 * Files a restack of `head` onto `onto` would conflict in, without touching any branch or the worktree: a three-way merge in
 * memory (`git merge-tree --write-tree --merge-base`, git 2.40+) of `base..head` replayed onto `onto`. `ok: false` when git
 * could not run it (old git, missing commits); the caller then says the conflict state is unknown, never "no conflicts".
 */
export async function restackConflicts({ git, directory, onto, base, head }: { git: GitRun; directory: string; onto: string; base: string; head: string }): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  const done = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, onto, head], directory)
  const lines = done.out.split("\n").map((line) => line.trim()).filter(Boolean)
  if (done.code === 0) return { ok: true, files: [] }
  if (done.code === 1 && lines[0] && SHA.test(lines[0])) return { ok: true, files: [...new Set(lines.slice(1))].sort() }
  return { ok: false, reason: `[PR_REVIEW]: git merge-tree could not simulate the restack (exit ${done.code})` }
}

/**
 * The advice text for a stacked PR: what moved, what to run, where a fix goes and what conflicts. Text only. MendCode does not
 * run it: a restack rewrites the author's branches (and every descendant's), which only the author decides; a conflict is
 * reported with its files and left to them.
 */
export function restackAdvice({ graph, number, change, conflicts, fix }: { graph: StackGraph; number: number; change?: StackChange | undefined; conflicts?: { ok: true; files: string[] } | { ok: false; reason: string } | undefined; fix?: FixTarget | undefined }): string {
  const node = graph.nodes.get(number)
  if (!node) return `#${number} is not an open PR in this stack.`
  const lines: string[] = []
  const below = descendants(graph, number)
  const parent = node.parent === undefined ? undefined : graph.nodes.get(node.parent)
  const ambiguous = graph.ambiguous.find((entry) => entry.number === number)
  if (ambiguous) lines.push(`#${number} targets ${node.baseRef}, the head branch of ${ambiguous.candidates.map((n) => `#${n}`).join(" and ")}: the stack parent is ambiguous, so it is reviewed against its base. Close or retarget one of them.`)
  const cycle = graph.cycles.find((entry) => entry.includes(number))
  if (cycle) lines.push(`#${number} is in a stack cycle (${[...cycle, cycle[0]].map((n) => `#${n}`).join(" → ")}): retarget one of them to the trunk.`)
  if (change) {
    lines.push(`#${number}: ${change.reason}.`)
    if (change.kinds.some((kind) => kind === "parent-updated" || kind === "parent-merged" || kind === "parent-closed") || (change.kinds.includes("retargeted") && parent)) {
      const upstream = change.previousParentHead ? change.previousParentHead.slice(0, 12) : `<#${number}'s old base>`
      lines.push(`To restack it: \`gt restack\` (Graphite) or \`git rebase --onto ${node.baseRef} ${upstream} ${node.headRef}\`${below.length ? `, then each of ${below.map((n) => `#${n}`).join(", ")} the same way` : ""}. MendCode does not rewrite these branches.`)
    }
    if (change.revalidate.length) lines.push(`Revalidated: ${change.revalidate.map((n) => `#${n}`).join(", ")}.`)
  }
  if (conflicts?.ok === true && conflicts.files.length) lines.push(`A restack of #${number}${parent ? ` onto #${parent.number}` : ""} conflicts in ${conflicts.files.join(", ")}: resolve them by hand; MendCode reports conflicts and never resolves them.`)
  else if (conflicts?.ok === true) lines.push(`A restack of #${number} applies without conflicts.`)
  else if (conflicts) lines.push(`Whether a restack of #${number} conflicts is unknown (${conflicts.reason}).`)
  if (fix) lines.push(fix.inherited ? `The fix belongs on #${fix.number} (${fix.branch}), not here: ${fix.reason}.` : `The fix belongs on #${fix.number} (${fix.branch}).`)
  return lines.join("\n")
}
