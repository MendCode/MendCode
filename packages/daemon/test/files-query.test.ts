import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { queryFiles } from "../src/files-query"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "files-query-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), content)
  }
  return dir
}
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`mendcode-capture-${process.pid}-`))
const hasRg = Bun.which("rg") !== null
const t = hasRg ? test : test.skip

t("files lists the project's files and honors the query and the ignore list", async () => {
  const dir = project({ "a.ts": "", "src/b.ts": "", "node_modules/c.ts": "", "docs/readme.md": "" })
  expect((await queryFiles({ directory: dir, operation: "files" })).lines.sort()).toEqual(["a.ts", "docs/readme.md", "src/b.ts"])
  expect((await queryFiles({ directory: dir, operation: "files", query: "READ" })).lines).toEqual(["docs/readme.md"])
  expect((await queryFiles({ directory: dir, operation: "files", ignore: ["docs"] })).lines.sort()).toEqual(["a.ts", "src/b.ts"])
  expect(leftovers()).toEqual([])
})

t("search returns file:line:text rows and an empty list for no match (rg exit 1)", async () => {
  const dir = project({ "a.ts": "one\nneedle here\n", "b.ts": "nothing\n" })
  expect((await queryFiles({ directory: dir, operation: "search", query: "needle" })).lines).toEqual(["a.ts:2:needle here"])
  expect((await queryFiles({ directory: dir, operation: "search", query: "absent" })).lines).toEqual([])
})

t("search fails with rg's message for a bad pattern", async () => {
  const dir = project({ "a.ts": "x\n" })
  await expect(queryFiles({ directory: dir, operation: "search", query: "(" })).rejects.toThrow()
  expect(leftovers()).toEqual([])
})

t("search stops at the line limit and reports it cut, however much rg prints", async () => {
  // rg skips files over 2 MB, so the output is spread over several.
  const dir = project(Object.fromEntries(Array.from({ length: 6 }, (_, file) => [`big${file}.txt`, Array.from({ length: 8000 }, (_, index) => `hit ${index} ${"x".repeat(200)}`).join("\n")])))
  const result = await queryFiles({ directory: dir, operation: "search", query: "hit", limit: 50 })
  expect(result.lines.length).toBe(50)
  expect(result.truncated).toBe(true)
  expect(leftovers()).toEqual([])
})
