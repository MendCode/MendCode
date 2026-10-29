import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { derivedReads, shellCommands, shellPaths } from "../src/extensions/shell-paths"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function project(files: string[]) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-paths-")))
  dirs.push(dir)
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), "x")
  }
  return dir
}

describe("the paths a tool call reaches, asked of read rules", () => {
  test("words split like sh, operators start a new command, a cd prefixes later relative words, the program is not a path", () => {
    expect(shellCommands(`cat "a b/c" | grep -n x > out.txt; echo 'hi there'`)).toEqual([["cat", "a b/c"], ["grep", "-n", "x", "out.txt"], ["echo", "hi there"]])
    const cwd = project(["notes.txt"])
    expect(shellPaths("cd private && cat keys.txt notes.txt", cwd)).toEqual(["private", "private/keys.txt", "private/notes.txt"])
    expect(shellPaths("cat notes.txt missing.txt --out=dir/x FOO=bar/baz -n https://h.test/a/b", cwd)).toEqual(["notes.txt", "dir/x", "bar/baz"])
  })

  test("a folder a call names is asked both as named and as folder/", () => {
    const cwd = project(["private/keys.txt"])
    expect(derivedReads("grep", { pattern: "x", path: "private" }, cwd)).toEqual(["private", "private/"])
    expect(derivedReads("shell", { command: "cd private && cat keys.txt" }, cwd)).toEqual(["private", "private/", "private/keys.txt"])
    expect(derivedReads("ls", { path: "private/" }, cwd)).toEqual(["private/"])
  })
})
