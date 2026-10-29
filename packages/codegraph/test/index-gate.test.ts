import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIndexGate, gitRoot } from "../src/index-gate"
import { createCodeGraphTools } from "../src/tools"

const root = mkdtempSync(join(tmpdir(), "mcev-g-gate-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A folder tree under the test root: `home` stands for the user's home folder, every project below it. */
const home = join(root, "home")
function project(rel: string, { git = false, files = 1 }: { git?: boolean; files?: number } = {}) {
  const dir = join(home, rel)
  mkdirSync(dir, { recursive: true })
  if (git) mkdirSync(join(dir, ".git"), { recursive: true })
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
  return dir
}

const small = project("code/small", { git: true, files: 3 })
const large = project("code/large", { git: true, files: 12 })
const plain = project("notes/plain", { files: 2 })
const many = join(home, "code")
const nested = project("code/small/packages/a", { files: 1 })
mkdirSync(join(home, ".git"), { recursive: true })

describe("where the code graph indexes", () => {
  const gate = createIndexGate({ home, maxFiles: 10 })

  test("auto indexes a git repository under the size limit, and a folder inside one", async () => {
    expect(await gate.check({ cwd: small, mode: "auto" })).toEqual({ index: true })
    expect(await gate.check({ cwd: nested, mode: "auto" })).toEqual({ index: true })
    expect(gitRoot(nested, home)).toBe(small)
  })

  test("auto skips a large repository, a folder outside any repository and a folder of several repositories, with a short reason", async () => {
    expect(await gate.check({ cwd: large, mode: "auto" })).toEqual({ index: false, reason: "large folder" })
    expect(await gate.check({ cwd: plain, mode: "auto" })).toEqual({ index: false, reason: "no git repo" })
    expect(await gate.check({ cwd: many, mode: "auto" })).toEqual({ index: false, reason: "several repos" })
  })

  test("a project folder without git (unpacked source, an agent's CLAUDE.md) is measured like a repository", async () => {
    const unpacked = project("work/unpacked", { files: 3 })
    writeFileSync(join(unpacked, "CLAUDE.md"), "notes\n")
    const big = project("work/big", { files: 12 })
    writeFileSync(join(big, "go.mod"), "module x\n")
    expect(await gate.check({ cwd: unpacked, mode: "auto" })).toEqual({ index: true })
    expect(await gate.check({ cwd: big, mode: "auto" })).toEqual({ index: false, reason: "large folder" })
    // A stray manifest in Downloads does not make it a project; a project unpacked inside it is one.
    const downloads = project("Downloads", { files: 2 })
    writeFileSync(join(downloads, "platformio.ini"), "[env]\n")
    expect(await gate.check({ cwd: downloads, mode: "auto" })).toEqual({ index: false, reason: "no git repo" })
    const inside = project("Downloads/zerobase", { files: 2 })
    writeFileSync(join(inside, "CLAUDE.md"), "notes\n")
    expect(await gate.check({ cwd: inside, mode: "auto" })).toEqual({ index: true })
  })

  test("a git repository at the home folder (dotfiles) never makes a folder under it a repository", () => {
    expect(gitRoot(plain, home)).toBeUndefined()
  })

  test("never the home folder or the root, whatever the mode; on indexes anything else, off nothing", async () => {
    for (const mode of ["auto", "on"] as const) {
      expect(await gate.check({ cwd: home, mode })).toEqual({ index: false, reason: "home folder" })
      expect(await gate.check({ cwd: "/", mode })).toEqual({ index: false, reason: "home folder" })
    }
    expect(await gate.check({ cwd: large, mode: "on" })).toEqual({ index: true })
    expect(await gate.check({ cwd: plain, mode: "on" })).toEqual({ index: true })
    expect(await gate.check({ cwd: small, mode: "off" })).toEqual({ index: false, reason: "off" })
  })

  test("peek answers without walking; a size not measured yet is unknown, then known", async () => {
    const fresh = createIndexGate({ home, maxFiles: 10 })
    expect(fresh.peek({ cwd: plain, mode: "auto" })).toEqual({ index: false, reason: "no git repo" })
    expect(fresh.peek({ cwd: large, mode: "auto" })).toBeUndefined()
    await fresh.check({ cwd: large, mode: "auto" })
    expect(fresh.peek({ cwd: large, mode: "auto" })).toEqual({ index: false, reason: "large folder" })
  })

  test("a graph tool in a skipped folder says why and indexes nothing", async () => {
    let scanned = 0
    const tools = createCodeGraphTools({ cacheDir: join(root, "cache"), onScan: () => void scanned++, gate: (cwd, signal) => gate.check({ cwd, mode: "auto", signal }) })
    const find = tools.find((tool) => tool.name === "graph_find")!
    const context = { cwd: large, signal: new AbortController().signal } as Parameters<typeof find.execute>[1]
    const result = await find.execute({ query: "v1" }, context)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("too large to index automatically")
    expect(result.output).toContain("/graph on")
    expect(scanned).toBe(0)
    const indexed = await find.execute({ query: "v1" }, { ...context, cwd: small })
    expect(indexed.isError).toBe(false)
    expect(scanned).toBeGreaterThan(0)
  })
})
