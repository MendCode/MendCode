import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { shell } from "../src"
import { blastRadiusPreview, tokenize } from "../src/blast-radius"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()
const signal = new AbortController().signal
const preview = (command: string, cwd: string) => blastRadiusPreview({ command, cwd, signal })

function repo(): string {
  const root = tmp()
  const run = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" })
  run("init", "-q")
  put({ root, path: "keep.txt", content: "one\ntwo\n" })
  put({ root, path: "src/a.ts", content: "a\nb\nc\n" })
  run("add", ".")
  run("commit", "-q", "-m", "first")
  return root
}

describe("tokenize", () => {
  test("splits quotes and escapes like sh", () => {
    expect(tokenize(`rm -rf "my dir" 'it''s' a\\ b`)?.map((token) => token.text)).toEqual(["rm", "-rf", "my dir", "its", "a b"])
  })
  test("marks only unquoted wildcards as globs", () => {
    expect(tokenize(`rm *.log "*.tmp"`)?.map((token) => token.glob)).toEqual([false, true, false])
  })
  test("refuses what cannot be read without running it", () => {
    for (const command of ["rm a; rm b", "rm a | cat", "rm $(ls)", "rm `ls`", "rm \"$HOME\"", "rm ~/x", "rm a{1,2}", "rm a > out", "rm 'open", "rm (x)"]) expect(tokenize(command)).toBeUndefined()
  })
})

describe("rm preview", () => {
  test("lists files, directories with their counts, and what is missing, without deleting anything", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "x".repeat(2048) })
    put({ root, path: "build/one.js", content: "1" })
    put({ root, path: "build/deep/two.js", content: "22" })
    const text = await preview("rm -rf a.txt build nope.txt", root)
    expect(text).toContain("*** rm would delete 2 paths · 3 files · 2 KB")
    expect(text).toContain("- a.txt · 2 KB")
    expect(text).toContain("- build/ · 2 files · 1 subdirectory · 3 B")
    expect(text).toContain("-   build/deep/two.js")
    expect(text).toContain("missing: nope.txt (ignored by -f)")
    expect(existsSync(join(root, "build/one.js"))).toBe(true)
    expect(existsSync(join(root, "a.txt"))).toBe(true)
  })
  test("a directory without -r is reported as refused and a symlink is not followed", async () => {
    const root = tmp()
    mkdirSync(join(root, "dir"))
    put({ root, path: "outside/secret.txt", content: "s" })
    symlinkSync(join(root, "outside"), join(root, "link"))
    const text = await preview("rm dir link", root)
    expect(text).toContain("dir/ is a directory: rm needs -r")
    expect(text).toContain("- link · symlink")
    expect(text).not.toContain("secret.txt")
  })
  test("expands a wildcard the way the shell would and skips dotfiles", async () => {
    const root = tmp()
    for (const name of ["a.log", "b.log", "c.txt", ".d.log"]) put({ root, path: `logs/${name}`, content: "x" })
    const text = await preview("rm logs/*.log", root)
    expect(text).toContain("*** rm would delete 2 paths")
    expect(text).toContain("- logs/a.log")
    expect(text).toContain("- logs/b.log")
    expect(text).not.toContain("c.txt")
    expect(text).not.toContain(".d.log")
    expect(await preview("rm nothing/*.zzz", root)).toContain("no match: nothing/*.zzz")
  })
  test("unknown flags, command chains and expansions give no preview", async () => {
    const root = tmp()
    put({ root, path: "a", content: "x" })
    expect(await preview("rm --weird a", root)).toBeUndefined()
    expect(await preview("rm a && rm b", root)).toBeUndefined()
    expect(await preview("rm $HOME/a", root)).toBeUndefined()
    expect(await preview("rm", root)).toBeUndefined()
    expect(await preview("ls -la", root)).toBeUndefined()
  })
})

describe("git previews", () => {
  test("git clean -fd lists what a dry run would remove and removes nothing", async () => {
    const root = repo()
    put({ root, path: "scratch.txt", content: "x" })
    put({ root, path: "tmp/out.log", content: "x" })
    const text = await preview("git clean -fd", root)
    expect(text).toContain("*** git clean would remove 2 paths (dry run)")
    expect(text).toContain("- scratch.txt")
    expect(text).toContain("- tmp/")
    expect(existsSync(join(root, "scratch.txt"))).toBe(true)
    expect((await preview("git clean -f", root))).toContain("would remove 1 path")
    expect(await preview("git clean -i", root)).toBeUndefined()
  })
  test("git reset --hard shows the tracked files it rewrites and the commits it drops", async () => {
    const root = repo()
    writeFileSync(join(root, "keep.txt"), "one\nTWO\nthree\n")
    put({ root, path: "untracked.txt", content: "stays" })
    const text = await preview("git reset --hard", root)
    expect(text).toContain("*** git reset --hard rewrites 1 tracked file (+2 -1 against HEAD)")
    expect(text).toContain("keep.txt · +2 -1")
    expect(text).toContain("untracked files stay")
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("one\nTWO\nthree\n")
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "second"])
    expect(await preview("git reset --hard HEAD~1", root)).toContain("the branch loses 1 commit")
    expect(await preview("git reset --hard nope-branch", root)).toBeUndefined()
    expect(await preview("git reset --hard --weird", root)).toBeUndefined()
    expect(await preview("git reset HEAD~1", root)).toBeUndefined()
  })
  test("git restore and git checkout -- show the changes they discard", async () => {
    const root = repo()
    writeFileSync(join(root, "src/a.ts"), "a\nb\nc\nd\n")
    expect(await preview("git restore src/a.ts", root)).toContain("src/a.ts · +1 -0")
    expect(await preview("git checkout -- .", root)).toContain("discards changes in 1 file")
    expect(await preview("git checkout HEAD -- src", root)).toContain("src/a.ts")
    expect(await preview("git restore keep.txt", root)).toContain("no tracked changes in these paths")
    expect(await preview("git restore --staged src/a.ts", root)).toBeUndefined()
    expect(await preview("git checkout main", root)).toBeUndefined()
    expect(await preview("git restore *.ts", root)).toBeUndefined()
  })
  test("outside a repository there is no preview", async () => {
    expect(await preview("git clean -fd", tmp())).toBeUndefined()
  })
})

describe("find -delete preview", () => {
  test("a preview never executes git or find from a repository-controlled PATH", async () => {
    const root = repo()
    const marker = join(root, "executed")
    for (const binary of ["git", "find"]) writeFileSync(join(root, binary), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 })
    const environment = { ...process.env, PATH: `${root}:${process.env.PATH}` }
    for (const command of ["find . -name '*.log' -delete", "git clean -fd"]) {
      await blastRadiusPreview({ command, cwd: root, signal, environment })
      expect(existsSync(marker)).toBe(false)
    }
  })
  test("replaces -delete by -print in place and deletes nothing", async () => {
    const root = tmp()
    put({ root, path: "a.log", content: "x" })
    put({ root, path: "sub/b.log", content: "x" })
    put({ root, path: "sub/c.txt", content: "x" })
    const text = await preview("find . -name '*.log' -delete", root)
    expect(text).toContain("*** find -delete would remove 2 paths (dry run)")
    expect(text).toContain("- a.log")
    expect(text).toContain("- sub/b.log")
    expect(text).not.toContain("c.txt")
    expect(existsSync(join(root, "a.log"))).toBe(true)
  })
  test("-exec, unquoted wildcards and commands without -delete give no preview", async () => {
    const root = tmp()
    expect(await preview("find . -name x -exec rm {} +", root)).toBeUndefined()
    expect(await preview("find . -name *.log -delete", root)).toBeUndefined()
    expect(await preview("find . -name x", root)).toBeUndefined()
    expect(await preview("find . -fprint out -delete", root)).toBeUndefined()
  })
})

describe("shell tool", () => {
  test("its approval preview is the blast radius, honouring workdir", async () => {
    const root = tmp()
    put({ root, path: "pkg/old.txt", content: "x" })
    const text = await shell.preview!({ command: "rm old.txt", workdir: "pkg" }, makeContext({ cwd: root }))
    expect(text).toContain("- old.txt · 1 B")
    expect(await shell.preview!({ command: "echo hi" }, makeContext({ cwd: root }))).toBeUndefined()
  })
})
