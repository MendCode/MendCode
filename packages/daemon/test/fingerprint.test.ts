import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { workspaceFingerprint } from "../src/loop-checks"

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-fp-")))
  cleanups.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

/** Changes a file's content and pushes its mtime forward, so the change is visible even within one clock tick. */
function edit(file: string, text: string, secondsLater: number) {
  writeFileSync(file, text)
  const at = new Date(Date.now() + secondsLater * 1000)
  utimesSync(file, at, at)
}

describe("workspace fingerprint", () => {
  test("in git: stable when nothing changes; an edit to an untracked file changes it (its content is not in the diff)", async () => {
    const dir = temp()
    git(dir, "init", "-q")
    writeFileSync(path.join(dir, "a.ts"), "one")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "init")
    writeFileSync(path.join(dir, "new.ts"), "draft")
    const first = await workspaceFingerprint(dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await workspaceFingerprint(dir)).toBe(first)
    edit(path.join(dir, "new.ts"), "draft v2", 5)
    expect(await workspaceFingerprint(dir)).not.toBe(first)
  })

  test("outside git: a bounded digest of files that notices edits and ignores dependency folders", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "a.ts"), "one")
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true })
    writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "dep")
    const first = await workspaceFingerprint(dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    edit(path.join(dir, "node_modules", "x", "index.js"), "dep v2", 5)
    expect(await workspaceFingerprint(dir)).toBe(first)
    edit(path.join(dir, "a.ts"), "two", 10)
    expect(await workspaceFingerprint(dir)).not.toBe(first)
  })

  test("a directory that does not exist has no fingerprint", async () => {
    expect(await workspaceFingerprint(path.join(tmpdir(), "mend-fp-missing-dir-xyz"))).toBeUndefined()
  })
})
