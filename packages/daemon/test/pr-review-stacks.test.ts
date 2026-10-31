import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import { gitRun, parseUnifiedDiff } from "../src/pr-review/context"
import type { PrFacts } from "../src/pr-review/contracts"
import { findingId } from "../src/pr-review/findings"
import { ancestors, buildStackGraph, descendants, fixTarget, ownRange, restackAdvice, restackConflicts, stackChanges, stackSummary } from "../src/pr-review/stacks"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}

const sha = (seed: string) => seed.repeat(40).slice(0, 40)

function pr(number: number, baseRef: string, headRef: string, extra: Partial<PrFacts> = {}): PrFacts {
  return { number, baseRef, headRef, head: sha(String(number % 10)), base: sha("b"), draft: false, labels: [], author: "dev", authorIsBot: false, fork: false, requested: [], assignees: [], ...extra }
}

const finding = (input: Partial<PrFinding> & { path: string; line: number }): PrFinding => {
  const base = { side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, summary: "off by one", detail: "the loop skips the first value", evidence: [], ...input }
  return { ...base, id: findingId(base) }
}

describe("buildStackGraph", () => {
  test("a linear stack of three hangs main ← #1 ← #2 ← #3 with depths 0, 1, 2", () => {
    const graph = buildStackGraph([pr(3, "feat-b", "feat-c"), pr(1, "main", "feat-a"), pr(2, "feat-a", "feat-b")])
    expect(graph.roots).toEqual([1])
    expect(graph.nodes.get(1)!.parent).toBeUndefined()
    expect(graph.nodes.get(1)).toMatchObject({ children: [2], depth: 0 })
    expect(graph.nodes.get(2)).toMatchObject({ parent: 1, children: [3], depth: 1 })
    expect(graph.nodes.get(3)).toMatchObject({ parent: 2, children: [], depth: 2 })
    expect(graph.cycles).toEqual([])
    expect(graph.ambiguous).toEqual([])
    expect(descendants(graph, 1)).toEqual([2, 3])
    expect(ancestors(graph, 3)).toEqual([2, 1])
  })

  test("two same-repository PRs heading the child's base branch make it ambiguous and parentless", () => {
    const graph = buildStackGraph([pr(1, "main", "shared"), pr(2, "release", "shared"), pr(3, "shared", "child")])
    expect(graph.ambiguous).toEqual([{ number: 3, candidates: [1, 2] }])
    expect(graph.nodes.get(3)!.parent).toBeUndefined()
    expect(graph.roots).toEqual([1, 2, 3])
    expect(restackAdvice({ graph, number: 3 })).toContain("ambiguous")
  })

  test("a cycle is reported once, its links are cut and walks over it end", () => {
    const graph = buildStackGraph([pr(5, "b", "a"), pr(6, "a", "b"), pr(7, "a", "c")])
    expect(graph.cycles).toEqual([[5, 6]])
    expect(graph.nodes.get(5)!.parent).toBeUndefined()
    expect(graph.nodes.get(6)!.parent).toBeUndefined()
    expect(graph.nodes.get(7)).toMatchObject({ parent: 5, depth: 1 })
    expect(graph.roots).toEqual([])
    expect(ancestors(graph, 7)).toEqual([5])
    expect(restackAdvice({ graph, number: 6 })).toContain("#5 → #6 → #5")
  })

  test("a fork's branch named like a base-repo branch never parents a base-repo PR", () => {
    const graph = buildStackGraph([pr(10, "main", "feature", { fork: true }), pr(11, "feature", "feature-2")])
    expect(graph.nodes.get(11)!.parent).toBeUndefined()
    expect(graph.ambiguous).toEqual([])
    expect(stackSummary(graph, 11)).toBeUndefined()
    const both = buildStackGraph([pr(10, "main", "feature", { fork: true }), pr(12, "main", "feature"), pr(11, "feature", "feature-2")])
    expect(both.nodes.get(11)!.parent).toBe(12)
    expect(both.ambiguous).toEqual([])
  })

  test("a fork PR can still be the child of a base-repo PR", () => {
    const graph = buildStackGraph([pr(1, "main", "feat-a"), pr(2, "feat-a", "patch", { fork: true })])
    expect(graph.nodes.get(2)!.parent).toBe(1)
  })

  test("stackSummary gives parent, children and depth, and nothing for a lone PR", () => {
    const graph = buildStackGraph([pr(1, "main", "feat-a"), pr(2, "feat-a", "feat-b"), pr(4, "main", "solo")])
    expect(stackSummary(graph, 1)).toEqual({ children: [2], depth: 0 })
    expect(stackSummary(graph, 2)).toEqual({ parent: 1, children: [], depth: 1 })
    expect(stackSummary(graph, 4)).toBeUndefined()
    expect(stackSummary(graph, 99)).toBeUndefined()
  })
})

describe("stackChanges", () => {
  const stack = (heads: { 1: string; 2: string; 3: string }, extra: Partial<Record<number, Partial<PrFacts>>> = {}) => {
    const prs = [pr(1, "main", "feat-a", { head: heads[1], base: sha("m") }), pr(2, "feat-a", "feat-b", { head: heads[2], base: heads[1] }), pr(3, "feat-b", "feat-c", { head: heads[3], base: heads[2] })]
    return buildStackGraph(prs.map((entry) => ({ ...entry, ...extra[entry.number] })))
  }
  const heads = { 1: sha("1"), 2: sha("2"), 3: sha("3") }

  test("a parent update lists the child and every descendant for revalidation", () => {
    const result = stackChanges(stack(heads), stack({ ...heads, 1: sha("4") }))
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ number: 2, kinds: ["parent-updated"], parent: { before: 1, after: 1 }, previousParentHead: sha("1"), revalidate: [2, 3] })
    expect(result.revalidate).toEqual([2, 3])
    expect(restackAdvice({ graph: stack({ ...heads, 1: sha("4") }), number: 2, change: result.changes[0] })).toContain(`git rebase --onto feat-a ${sha("1").slice(0, 12)} feat-b`)
  })

  test("a retarget of the middle PR is reported with its old and new parent", () => {
    const next = buildStackGraph([pr(1, "main", "feat-a", { head: heads[1] }), pr(2, "main", "feat-b", { head: heads[2], base: sha("m") }), pr(3, "feat-b", "feat-c", { head: heads[3], base: heads[2] })])
    const result = stackChanges(stack(heads), next)
    expect(result.changes).toEqual([expect.objectContaining({ number: 2, kinds: ["retargeted"], parent: { before: 1, after: undefined }, revalidate: [2, 3] })])
  })

  test("a rebase of the child onto a moved base is `rebased`, and a restack after a parent update is both", () => {
    const rebasedRoot = stackChanges(stack(heads), stack({ ...heads, 1: sha("5") }, { 1: { base: sha("n") } }))
    expect(rebasedRoot.changes[0]).toMatchObject({ number: 1, kinds: ["rebased"], revalidate: [1, 2, 3] })
    const restacked = stackChanges(stack(heads), stack({ ...heads, 1: sha("4"), 2: sha("6") }))
    expect(restacked.changes.find((change) => change.number === 2)).toMatchObject({ kinds: ["parent-updated", "rebased"] })
    expect(restacked.changes.find((change) => change.number === 3)).toMatchObject({ kinds: ["parent-updated"], revalidate: [3] })
    expect(restacked.revalidate).toEqual([2, 3])
  })

  test("a parent that left the open list is merged or closed as the provider says", () => {
    const next = buildStackGraph([pr(2, "main", "feat-b", { head: heads[2], base: sha("m") }), pr(3, "feat-b", "feat-c", { head: heads[3], base: heads[2] })])
    const merged = stackChanges(stack(heads), next, { merged: new Set([1]) })
    expect(merged.changes[0]).toMatchObject({ number: 2, kinds: ["retargeted", "parent-merged"], revalidate: [2, 3] })
    expect(stackChanges(stack(heads), next).changes[0]!.kinds).toContain("parent-closed")
  })

  test("nothing moved: no changes", () => {
    expect(stackChanges(stack(heads), stack(heads))).toEqual({ changes: [], revalidate: [] })
  })
})

describe("ownRange and conflicts on a real repository", () => {
  /** main → feat-a (a.txt) → feat-b (b.txt): the child's own range must hold only b.txt. */
  async function stackedRepo() {
    const dir = temp("pr-review-stack-")
    await git(dir, "init", "-q", "-b", "main")
    writeFileSync(path.join(dir, "shared.txt"), "one\ntwo\nthree\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "base")
    const trunk = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "feat-a")
    writeFileSync(path.join(dir, "a.txt"), "parent change\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "parent")
    const parentHead = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "feat-b")
    writeFileSync(path.join(dir, "b.txt"), "child change\n")
    writeFileSync(path.join(dir, "shared.txt"), "one\nTWO child\nthree\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "child")
    const childHead = await git(dir, "rev-parse", "HEAD")
    return { dir, trunk, parentHead, childHead }
  }
  const graphOf = (trunk: string, parentHead: string, childHead: string) => buildStackGraph([pr(1, "main", "feat-a", { head: parentHead, base: trunk }), pr(2, "feat-a", "feat-b", { head: childHead, base: parentHead })])

  test("the child's own range starts at the parent's head and leaves the parent's commits out", async () => {
    const { dir, trunk, parentHead, childHead } = await stackedRepo()
    const graph = graphOf(trunk, parentHead, childHead)
    const range = await ownRange({ node: graph.nodes.get(2)!, graph, git: gitRun, directory: dir })
    expect(range).toEqual({ ok: true, base: parentHead, head: childHead, parent: 1, restack: false, reason: "own commits on #1" })
    if (!range.ok) throw new Error("range")
    const files = parseUnifiedDiff(await git(dir, "diff", `${range.base}...${range.head}`)).map((file) => file.path).sort()
    expect(files).toEqual(["b.txt", "shared.txt"])
    const root = await ownRange({ node: graph.nodes.get(1)!, graph, git: gitRun, directory: dir })
    expect(root).toMatchObject({ ok: true, base: trunk, head: parentHead, restack: false })
  })

  test("a parent amended after the child was built: the previous parent head bounds the range and a restack is flagged", async () => {
    const { dir, trunk, parentHead, childHead } = await stackedRepo()
    await git(dir, "checkout", "-q", "feat-a")
    writeFileSync(path.join(dir, "a.txt"), "parent change, amended\n")
    await git(dir, "commit", "-q", "-a", "--amend", "-m", "parent v2")
    const amended = await git(dir, "rev-parse", "HEAD")
    const graph = graphOf(trunk, amended, childHead)
    const withPrevious = await ownRange({ node: graph.nodes.get(2)!, graph, git: gitRun, directory: dir, previousParentHead: parentHead })
    expect(withPrevious).toMatchObject({ ok: true, base: parentHead, head: childHead, restack: true })
    const without = await ownRange({ node: graph.nodes.get(2)!, graph, git: gitRun, directory: dir })
    expect(without).toMatchObject({ ok: true, base: trunk, restack: true })
  })

  test("a head that is not fetched is a refusal, not a guess", async () => {
    const { dir, trunk, parentHead } = await stackedRepo()
    const graph = graphOf(trunk, parentHead, sha("e"))
    const range = await ownRange({ node: graph.nodes.get(2)!, graph, git: gitRun, directory: dir })
    expect(range.ok).toBe(false)
  })

  test("restackConflicts names the conflicting file and advice reports it without resolving", async () => {
    const { dir, trunk, parentHead, childHead } = await stackedRepo()
    await git(dir, "checkout", "-q", "feat-a")
    writeFileSync(path.join(dir, "shared.txt"), "one\nTWO parent\nthree\n")
    await git(dir, "commit", "-q", "-am", "parent edits shared")
    const moved = await git(dir, "rev-parse", "HEAD")
    const conflicts = await restackConflicts({ git: gitRun, directory: dir, onto: moved, base: parentHead, head: childHead })
    expect(conflicts).toEqual({ ok: true, files: ["shared.txt"] })
    const clean = await restackConflicts({ git: gitRun, directory: dir, onto: parentHead, base: trunk, head: childHead })
    expect(clean).toEqual({ ok: true, files: [] })
    const graph = graphOf(trunk, moved, childHead)
    const advice = restackAdvice({ graph, number: 2, conflicts })
    expect(advice).toContain("conflicts in shared.txt")
    expect(advice).toContain("never resolves")
    expect(await git(dir, "rev-parse", "feat-b")).toBe(childHead)
  })
})

describe("fixTarget", () => {
  test("a finding in the parent's own range is fixed on the parent's branch", () => {
    const graph = buildStackGraph([pr(1, "main", "feat-a"), pr(2, "feat-a", "feat-b"), pr(3, "feat-b", "feat-c")])
    const inParent = finding({ path: "a.ts", line: 3 })
    const target = fixTarget({ graph, number: 3, finding: inParent, owns: (number, entry) => number === 1 && entry.path === "a.ts" })
    expect(target).toMatchObject({ number: 1, branch: "feat-a", inherited: true })
    expect(restackAdvice({ graph, number: 3, fix: target })).toContain("The fix belongs on #1 (feat-a), not here")
    const own = fixTarget({ graph, number: 3, finding: finding({ path: "c.ts", line: 1 }), owns: (number) => number === 3 })
    expect(own).toMatchObject({ number: 3, branch: "feat-c", inherited: false })
  })
})
