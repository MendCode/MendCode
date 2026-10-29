import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearFilesIndexCache, searchFiles } from "../src/files-index"

const dirs: string[] = []
afterEach(() => {
  clearFilesIndexCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sh(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "files-index-"))
  dirs.push(dir)
  sh(dir, "init", "-q", "-b", "main")
  return dir
}

describe("searchFiles (files.search)", () => {
  test("lists tracked and untracked files; a gitignored node_modules is excluded like `git status` would", async () => {
    const dir = repo()
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n")
    mkdirSync(path.join(dir, "src", "view"), { recursive: true })
    mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true })
    writeFileSync(path.join(dir, "src", "view", "mentions.ts"), "export {}")
    writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = {}")
    sh(dir, "-C", dir, "add", ".gitignore", "src")
    sh(dir, "-C", dir, "commit", "-q", "-m", "init")
    writeFileSync(path.join(dir, "src", "view", "untracked.ts"), "export {}")
    const { files } = await searchFiles({ directory: dir, query: "" })
    const paths = files.map((f) => f.path)
    expect(paths).toContain("src/view/mentions.ts")
    expect(paths).toContain("src/view/untracked.ts")
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false)
  })

  test("directories are derived from file paths and are searchable", async () => {
    const dir = repo()
    mkdirSync(path.join(dir, "packages", "daemon", "src"), { recursive: true })
    writeFileSync(path.join(dir, "packages", "daemon", "src", "index.ts"), "export {}")
    sh(dir, "-C", dir, "add", ".")
    sh(dir, "-C", dir, "commit", "-q", "-m", "init")
    const { files } = await searchFiles({ directory: dir, query: "daemon" })
    expect(files.some((f) => f.path === "packages/daemon" && f.kind === "dir")).toBe(true)
  })

  test("ranks a basename match above a deep path match and respects `limit`", async () => {
    const dir = repo()
    mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true })
    writeFileSync(path.join(dir, "app.ts"), "export {}")
    writeFileSync(path.join(dir, "a", "b", "c", "application.ts"), "export {}")
    writeFileSync(path.join(dir, "a", "b", "c", "other.ts"), "export {}")
    sh(dir, "-C", dir, "add", ".")
    sh(dir, "-C", dir, "commit", "-q", "-m", "init")
    const { files } = await searchFiles({ directory: dir, query: "app" })
    expect(files[0]!.path).toBe("app.ts")
    const limited = await searchFiles({ directory: dir, query: "", limit: 1 })
    expect(limited.files).toHaveLength(1)
  })

  test("a directory with no git repository falls back to a bounded walk honoring .gitignore basics", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "files-index-plain-"))
    dirs.push(dir)
    writeFileSync(path.join(dir, ".gitignore"), "ignored-dir\n")
    mkdirSync(path.join(dir, "ignored-dir"), { recursive: true })
    mkdirSync(path.join(dir, "kept"), { recursive: true })
    writeFileSync(path.join(dir, "ignored-dir", "secret.ts"), "x")
    writeFileSync(path.join(dir, "kept", "visible.ts"), "x")
    const { files } = await searchFiles({ directory: dir, query: "" })
    const paths = files.map((f) => f.path)
    expect(paths).toContain("kept/visible.ts")
    expect(paths.some((p) => p.includes("ignored-dir"))).toBe(false)
  })

  test("an unknown directory returns an empty, not a thrown error", async () => {
    const missing = path.join(tmpdir(), `files-index-missing-${Date.now()}`)
    const { files } = await searchFiles({ directory: missing, query: "" })
    expect(files).toEqual([])
  })
})
