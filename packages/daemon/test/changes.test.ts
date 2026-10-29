import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NotGitError, readChanges } from "../src/changes"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sh(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "changes-"))
  dirs.push(dir)
  sh(dir, "init", "-q", "-b", "main")
  return dir
}

describe("readChanges", () => {
  test("reports modified, added, deleted, renamed and untracked files with counts and hunks", async () => {
    const dir = repo()
    writeFileSync(path.join(dir, "a.ts"), "one\ntwo\n")
    writeFileSync(path.join(dir, "gone.ts"), "bye\n")
    writeFileSync(path.join(dir, "old-name.ts"), "same content\nline 2\nline 3\n")
    sh(dir, "add", ".")
    sh(dir, "commit", "-q", "-m", "init")
    writeFileSync(path.join(dir, "a.ts"), "one\nTWO\nthree\n")
    rmSync(path.join(dir, "gone.ts"))
    sh(dir, "mv", "old-name.ts", "new-name.ts")
    writeFileSync(path.join(dir, "staged.ts"), "new\n")
    sh(dir, "add", "staged.ts")
    mkdirSync(path.join(dir, "sub"))
    writeFileSync(path.join(dir, "sub", "loose.txt"), "x\ny\n")
    const report = await readChanges(path.join(dir, "sub"))
    expect(report.branch).toBe("main")
    const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]))
    expect(byPath["a.ts"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 })
    expect(byPath["a.ts"]!.diff).toContain("-two\n+TWO\n+three")
    expect(byPath["gone.ts"]).toMatchObject({ status: "deleted", deletions: 1 })
    expect(byPath["new-name.ts"]).toMatchObject({ status: "renamed", oldPath: "old-name.ts" })
    expect(byPath["staged.ts"]).toMatchObject({ status: "added", additions: 1 })
    expect(byPath["sub/loose.txt"]).toMatchObject({ status: "untracked", additions: 2, diff: "@@ -0,0 +1,2 @@\n+x\n+y\n" })
  })

  test("works before the first commit and flags binary files", async () => {
    const dir = repo()
    writeFileSync(path.join(dir, "img.bin"), new Uint8Array([0, 1, 2, 0]))
    writeFileSync(path.join(dir, "readme.md"), "hi\n")
    sh(dir, "add", "readme.md")
    const report = await readChanges(dir)
    expect(report.files.map((f) => `${f.path}:${f.status}:${f.binary}`)).toEqual(["img.bin:untracked:true", "readme.md:added:false"])
  })

  test("an untracked symlink is reported without reading what it points to", async () => {
    const dir = repo()
    const outside = mkdtempSync(path.join(tmpdir(), "changes-outside-"))
    dirs.push(outside)
    writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE-THE-REPO\n")
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"))
    const report = await readChanges(dir)
    const link = report.files.find((file) => file.path === "link.txt")
    expect(link).toMatchObject({ status: "untracked", additions: 0 })
    expect(JSON.stringify(report)).not.toContain("TOP-SECRET-OUTSIDE-THE-REPO")
  })

  test("a directory outside any repository is a typed error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nogit-"))
    dirs.push(dir)
    await expect(readChanges(dir)).rejects.toBeInstanceOf(NotGitError)
  })
})
