import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import { gitRun } from "../src/pr-review/context"
import { findingId } from "../src/pr-review/findings"
import { dedupeInherited, fingerprint, lineReader, normalizeSummary, parseZeroContextDiff, remapFindings } from "../src/pr-review/fingerprint"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}

const finding = (input: Partial<PrFinding> & { path: string; line: number }): PrFinding => {
  const base = { side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, summary: "off by one", detail: "the loop skips the first value", evidence: [], ...input }
  return { ...base, id: findingId(base) }
}

const SOURCE = ["function total(values) {", "  let sum = 0", "  for (let i = 1; i < values.length; i++) sum += values[i]", "  return sum", "}", "", "function mean(values) {", "  return total(values) / values.length", "}"].join("\n") + "\n"

async function repo() {
  const dir = temp("pr-review-fp-")
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "math.js"), SOURCE)
  writeFileSync(path.join(dir, "other.js"), "export const x = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  return { dir, from: await git(dir, "rev-parse", "HEAD") }
}
async function commit(dir: string, message: string) {
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", message)
  return git(dir, "rev-parse", "HEAD")
}

describe("fingerprint", () => {
  test("stays the same when the line moves or is reindented, and changes with the code or the category", () => {
    const at3 = finding({ path: "math.js", line: 3 })
    const at9 = finding({ path: "math.js", line: 9, summary: "Off by one." })
    expect(at3.id).not.toBe(at9.id)
    expect(fingerprint(at3, "  for (let i = 1; i < n; i++)")).toBe(fingerprint(at9, "for (let i = 1;   i < n; i++)  "))
    expect(fingerprint(at3, "for (let i = 1; i < n; i++)")).not.toBe(fingerprint(at3, "for (let i = 0; i < n; i++)"))
    expect(fingerprint(at3, "x")).not.toBe(fingerprint({ ...at3, category: "performance" }, "x"))
  })

  test("summary normalisation drops quoted line numbers and final punctuation", () => {
    expect(normalizeSummary("Off by one at line 42.")).toBe(normalizeSummary("off by one at line 7"))
    expect(normalizeSummary("see math.js:12")).toBe("see math.js:#")
  })
})

describe("remapFindings", () => {
  test("an insertion above moves the finding down, keeps its text and recomputes its id", async () => {
    const { dir, from } = await repo()
    writeFileSync(path.join(dir, "math.js"), "// header\n// license\n" + SOURCE)
    const to = await commit(dir, "header")
    const original = finding({ path: "math.js", line: 3, endLine: 4 })
    const [mapped] = await remapFindings({ git: gitRun, directory: dir, from, to, findings: [original] })
    expect(mapped).toMatchObject({ status: "moved", previous: { id: original.id, path: "math.js", line: 3, endLine: 4 } })
    expect(mapped!.finding).toMatchObject({ path: "math.js", line: 5, endLine: 6 })
    expect(mapped!.finding.id).toBe(findingId({ path: "math.js", line: 5, category: "correctness", summary: "off by one" }))
    const before = await lineReader({ git: gitRun, directory: dir, commit: from })("math.js", 3)
    const after = await lineReader({ git: gitRun, directory: dir, commit: to })("math.js", 5)
    expect(fingerprint(mapped!.finding, after!)).toBe(fingerprint(original, before!))
  })

  test("a line the new commit rewrote is needs-recheck; lines above an edit and untouched files are unchanged", async () => {
    const { dir, from } = await repo()
    writeFileSync(path.join(dir, "math.js"), SOURCE.replace("let i = 1", "let i = 0").replace("/ values.length", "/ Math.max(1, values.length)"))
    const to = await commit(dir, "fix")
    const results = await remapFindings({ git: gitRun, directory: dir, from, to, findings: [finding({ path: "math.js", line: 3 }), finding({ path: "math.js", line: 1 }), finding({ path: "other.js", line: 1 }), finding({ path: "math.js", line: 9 })] })
    expect(results.map((entry) => entry.status)).toEqual(["needs-recheck", "unchanged", "unchanged", "unchanged"])
    expect(results[0]!.finding.line).toBe(3)
  })

  test("an insertion inside a multi-line finding is needs-recheck; a deletion above moves it up", async () => {
    const { dir, from } = await repo()
    writeFileSync(path.join(dir, "math.js"), SOURCE.replace("  let sum = 0\n", "").replace("  return sum\n", "  return sum\n  // done\n"))
    const to = await commit(dir, "edits")
    const results = await remapFindings({ git: gitRun, directory: dir, from, to, findings: [finding({ path: "math.js", line: 4, endLine: 5 }), finding({ path: "math.js", line: 3 }), finding({ path: "math.js", line: 8 })] })
    expect(results[0]!.status).toBe("needs-recheck")
    expect(results[1]).toMatchObject({ status: "moved", finding: { line: 2 } })
    expect(await lineReader({ git: gitRun, directory: dir, commit: to })("math.js", 2)).toBe("  for (let i = 1; i < values.length; i++) sum += values[i]")
    expect(results[2]).toMatchObject({ status: "unchanged", finding: { line: 8 } })
    expect(await lineReader({ git: gitRun, directory: dir, commit: to })("math.js", 8)).toBe("  return total(values) / values.length")
  })

  test("a rename carries the finding to the new path; a deleted file marks it deleted", async () => {
    const { dir, from } = await repo()
    await git(dir, "mv", "math.js", "stats.js")
    unlinkSync(path.join(dir, "other.js"))
    const to = await commit(dir, "rename and delete")
    const [renamed, deleted] = await remapFindings({ git: gitRun, directory: dir, from, to, findings: [finding({ path: "math.js", line: 8 }), finding({ path: "other.js", line: 1 })] })
    expect(renamed).toMatchObject({ status: "moved", finding: { path: "stats.js", line: 8 }, previous: { path: "math.js" } })
    expect(deleted).toMatchObject({ status: "deleted", finding: { path: "other.js" } })
  })

  test("a rename with an edit above the finding moves both path and line", async () => {
    const { dir, from } = await repo()
    await git(dir, "mv", "math.js", "stats.js")
    writeFileSync(path.join(dir, "stats.js"), "// moved\n" + SOURCE)
    const to = await commit(dir, "rename with edit")
    const [mapped] = await remapFindings({ git: gitRun, directory: dir, from, to, findings: [finding({ path: "math.js", line: 8 })] })
    expect(mapped).toMatchObject({ status: "moved", finding: { path: "stats.js", line: 9 } })
  })

  test("an unreadable range makes every finding needs-recheck instead of a claimed move", async () => {
    const { dir, from } = await repo()
    const results = await remapFindings({ git: gitRun, directory: dir, from, to: "f".repeat(40), findings: [finding({ path: "math.js", line: 3 })] })
    expect(results[0]!.status).toBe("needs-recheck")
  })

  test("the zero-context parser keys renames by the old path and skips added files", () => {
    const diff = ["diff --git a/old name.ts b/new name.ts", "similarity index 90%", "rename from old name.ts", "rename to new name.ts", "--- a/old name.ts", "+++ b/new name.ts", "@@ -2 +2,2 @@", "-a", "+b", "+c", "diff --git a/added.ts b/added.ts", "new file mode 100644", "--- /dev/null", "+++ b/added.ts", "@@ -0,0 +1 @@", "+x"].join("\n")
    const files = parseZeroContextDiff(diff)
    expect([...files.keys()]).toEqual(["old name.ts"])
    expect(files.get("old name.ts")).toEqual({ oldPath: "old name.ts", newPath: "new name.ts", hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }] })
  })
})

describe("dedupeInherited", () => {
  test("drops the child findings the parent already reported, wherever the line sits, and keeps the rest", () => {
    const parentFinding = finding({ path: "math.js", line: 3 })
    const childSame = finding({ path: "math.js", line: 10, summary: "Off by one." })
    const childNew = finding({ path: "math.js", line: 12, summary: "division by zero on an empty list" })
    const childUnreadable = finding({ path: "gone.js", line: 1 })
    const text = new Map<string, string>([[`parent:${parentFinding.id}`, "  for (let i = 1; i < values.length; i++) sum += values[i]"], [`child:${childSame.id}`, "for (let i = 1; i < values.length; i++) sum += values[i]"], [`child:${childNew.id}`, "  return total(values) / values.length"]])
    const result = dedupeInherited({ child: [childSame, childNew, childUnreadable], parent: [parentFinding], lineText: (entry, side) => text.get(`${side}:${entry.id}`) })
    expect(result.kept.map((entry) => entry.id)).toEqual([childNew.id, childUnreadable.id])
    expect(result.inherited).toEqual([{ finding: childSame, parentId: parentFinding.id, fingerprint: fingerprint(parentFinding, text.get(`parent:${parentFinding.id}`)!) }])
  })
})
