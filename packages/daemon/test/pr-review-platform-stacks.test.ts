import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import { gitRun } from "../src/pr-review/context"
import type { PrFacts } from "../src/pr-review/contracts"
import { findingId } from "../src/pr-review/findings"
import { dedupeInherited, fingerprint, lineReader, remapFindings } from "../src/pr-review/fingerprint"
import { buildStackGraph, fixTarget, ownRange, restackAdvice, stackChanges, stackSummary } from "../src/pr-review/stacks"

/**
 * Platform scenarios for stacked PRs (docs/pr-review.md, "Stacked pull requests") on a real temp git repository: a child is
 * reviewed on its own commits, a parent update marks the child for revalidation, the parent's finding is not repeated on the
 * child, keeps its identity after the parent moved, and is fixed on the parent's branch. MendCode never restacks.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(args, cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")}: exit ${done.code}`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

/** main → parent (adds src/a.ts with a bug) → child (adds src/b.ts on top of the parent). */
async function stackedRepository() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-platform-stacks-")))
  temps.push(dir)
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.email", "t@example.com")
  await git(dir, "config", "user.name", "T")
  write(dir, "README.md", "stack\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-qm", "base")
  const trunk = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-qb", "parent")
  write(dir, "src/a.ts", "export function first(values: number[]) {\n  return values[1]\n}\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-qm", "parent")
  const parentHead = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-qb", "child")
  write(dir, "src/b.ts", "import { first } from \"./a\"\nexport const head = (rows: number[]) => first(rows) ?? 0\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-qm", "child")
  const childHead = await git(dir, "rev-parse", "HEAD")
  return { dir, trunk, parentHead, childHead }
}

const facts = (number: number, baseRef: string, headRef: string, base: string, head: string): PrFacts => ({
  number, baseRef, headRef, base, head, draft: false, labels: [], author: "alice", authorIsBot: false, fork: false, requested: [], assignees: [],
})
const finding = (file: string, line: number, summary: string): PrFinding => ({
  id: findingId({ path: file, line, category: "correctness", summary }), path: file, line, side: "RIGHT", severity: "major", category: "correctness",
  summary, detail: "values[1] is the second element.", evidence: [`${file}:${line}`], verdict: "confirmed",
})

describe("platform stacks: a parent update revalidates the child without duplicate findings", () => {
  test("the child is reviewed on its own commits; after the parent moves it is revalidated, the inherited finding is dropped and the fix goes to the parent", async () => {
    const repo = await stackedRepository()
    const before = buildStackGraph([facts(1, "main", "parent", repo.trunk, repo.parentHead), facts(2, "parent", "child", repo.parentHead, repo.childHead)])
    expect(before.nodes.get(2)!.parent).toBe(1)
    expect(stackSummary(before, 2)).toEqual({ parent: 1, children: [], depth: 1 })
    const range = await ownRange({ node: before.nodes.get(2)!, graph: before, git: gitRun, directory: repo.dir })
    expect(range).toMatchObject({ ok: true, base: repo.parentHead, head: repo.childHead, parent: 1, restack: false })
    expect(await git(repo.dir, "diff", "--name-only", `${repo.parentHead}..${repo.childHead}`)).toBe("src/b.ts")

    // The parent's own review found the bug in src/a.ts:2.
    const parentFinding = finding("src/a.ts", 2, "first() returns the second value")

    // The parent gets a new commit that inserts a line above the bug; the child is not restacked.
    await git(repo.dir, "checkout", "-q", "parent")
    write(repo.dir, "src/a.ts", "// helpers\nexport function first(values: number[]) {\n  return values[1]\n}\n")
    await git(repo.dir, "commit", "-qam", "parent: comment")
    const parentMoved = await git(repo.dir, "rev-parse", "HEAD")
    const after = buildStackGraph([facts(1, "main", "parent", repo.trunk, parentMoved), facts(2, "parent", "child", parentMoved, repo.childHead)])
    const moved = stackChanges(before, after)
    expect(moved.changes).toEqual([expect.objectContaining({ number: 2, kinds: ["parent-updated"], previousParentHead: repo.parentHead, revalidate: [2] })])
    expect(moved.revalidate).toEqual([2])

    // Revalidating the child still reads only its own commits: the range starts at the parent head it was built on.
    const again = await ownRange({ node: after.nodes.get(2)!, graph: after, git: gitRun, directory: repo.dir, previousParentHead: moved.changes[0]!.previousParentHead })
    expect(again).toMatchObject({ ok: true, base: repo.parentHead, head: repo.childHead, restack: true })

    // The parent's finding keeps its identity after the parent moved: remapped to line 3 with the same fingerprint.
    const [remapped] = await remapFindings({ git: gitRun, directory: repo.dir, from: repo.parentHead, to: parentMoved, findings: [parentFinding] })
    expect(remapped).toMatchObject({ status: "moved", finding: { line: 3 }, previous: { id: parentFinding.id, line: 2 } })
    const onParent = lineReader({ git: gitRun, directory: repo.dir, commit: parentMoved })
    const onChild = lineReader({ git: gitRun, directory: repo.dir, commit: repo.childHead })
    expect(fingerprint(remapped!.finding, (await onParent("src/a.ts", 3))!)).toBe(fingerprint(parentFinding, (await onChild("src/a.ts", 2))!))

    // A child review that sees the same bug (e.g. a full review) reports only its own: the inherited one is dropped.
    const childOwn = finding("src/b.ts", 2, "head() treats a legitimate 0 as missing")
    const childSaw = [finding("src/a.ts", 2, "First() returns the second value."), childOwn]
    const lines = new Map<string, string | undefined>()
    for (const item of childSaw) lines.set(`child:${item.path}:${item.line}`, await onChild(item.path, item.line))
    lines.set(`parent:src/a.ts:3`, await onParent("src/a.ts", 3))
    const deduped = dedupeInherited({ child: childSaw, parent: [remapped!.finding], lineText: (item, side) => lines.get(`${side}:${item.path}:${item.line}`) })
    expect(deduped.kept).toEqual([childOwn])
    expect(deduped.inherited.map((entry) => entry.parentId)).toEqual([remapped!.finding.id])

    // Where the fix goes: the parent's branch, and the advice names the restack MendCode will not run.
    const fix = fixTarget({ graph: after, number: 2, finding: childSaw[0]!, owns: (number, item) => number === 1 && item.path === "src/a.ts" })
    expect(fix).toMatchObject({ number: 1, branch: "parent", inherited: true })
    const advice = restackAdvice({ graph: after, number: 2, change: moved.changes[0], fix })
    expect(advice).toContain(`git rebase --onto parent ${repo.parentHead.slice(0, 12)} child`)
    expect(advice).toContain("MendCode does not rewrite these branches")
    expect(advice).toContain("The fix belongs on #1 (parent)")
    // Nothing was rewritten: the child branch is where it was.
    expect(await git(repo.dir, "rev-parse", "child")).toBe(repo.childHead)
  })
  test("a retarget after the parent merged, a cycle and an ambiguous parent are each reported, never walked forever or guessed", () => {
    const sha = (c: string) => c.repeat(40)
    const before = buildStackGraph([facts(1, "main", "p", sha("1"), sha("2")), facts(2, "p", "c", sha("2"), sha("3"))])
    const retargeted = buildStackGraph([facts(2, "main", "c", sha("4"), sha("3"))])
    const change = stackChanges(before, retargeted, { merged: new Set([1]) })
    expect(change.changes[0]!.kinds).toEqual(["retargeted", "parent-merged"])
    const cycle = buildStackGraph([facts(5, "b", "a", sha("5"), sha("6")), facts(6, "a", "b", sha("6"), sha("5"))])
    expect(cycle.cycles).toEqual([[5, 6]])
    expect(cycle.nodes.get(5)!.parent).toBeUndefined()
    const ambiguous = buildStackGraph([facts(7, "main", "x", sha("7"), sha("8")), facts(8, "dev", "x", sha("7"), sha("9")), facts(9, "x", "y", sha("8"), sha("a"))])
    expect(ambiguous.ambiguous).toEqual([{ number: 9, candidates: [7, 8] }])
    expect(ambiguous.nodes.get(9)!.parent).toBeUndefined()
  })
})
