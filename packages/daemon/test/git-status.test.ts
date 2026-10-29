import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readGitStatus } from "../src/git-status"

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-git-status-"))
  dirs.push(dir)
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" })
    if (run.exitCode !== 0 && args[0] !== "merge") throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  }
  git("init", "-q", "-b", "main")
  return { dir, git, write: (name: string, text: string) => writeFileSync(path.join(dir, name), text) }
}

test("git status counts dirty, untracked and conflicted entries locally", async () => {
  const { dir, git, write } = repo()
  write("a.txt", "one\n")
  git("add", ".")
  git("commit", "-q", "-m", "first")
  write("new.txt", "x\n")
  write("a.txt", "two\n")
  expect(await readGitStatus(dir)).toMatchObject({ branch: "main", dirty: 2, untracked: 1, conflicts: 0 })
})

test("a merge conflict shows up as a conflict", async () => {
  const { dir, git, write } = repo()
  write("a.txt", "base\n")
  git("add", ".")
  git("commit", "-q", "-m", "base")
  git("checkout", "-q", "-b", "side")
  write("a.txt", "side\n")
  git("commit", "-q", "-am", "side")
  git("checkout", "-q", "main")
  write("a.txt", "main\n")
  git("commit", "-q", "-am", "main")
  git("merge", "side")
  expect(await readGitStatus(dir)).toMatchObject({ conflicts: 1, untracked: 0 })
})
