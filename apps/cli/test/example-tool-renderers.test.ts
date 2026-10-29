import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"

/** examples/packages/tool-renderers: its two modules, loaded as the user's extensions, draw real calls. */
const PACKAGE = path.resolve(import.meta.dir, "../../../examples/packages/tool-renderers")
const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

async function app(width: number) {
  const dir = scratch()
  made.push(dir)
  for (const file of ["shell-command.ts", "github-mcp.ts"]) dir.write(`data/extensions/${file}`, readFileSync(path.join(PACKAGE, "extensions", file), "utf8"))
  const h = await appHarness({ dataDir: dir.dataDir, width, height: 30 })
  await h.start()
  return h
}

test("the package manifest declares its extensions and no capabilities", () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "mendcode-package.json"), "utf8"))
  expect(manifest).toMatchObject({ name: "tool-renderers", extensions: true, capabilities: [] })
})

test("shell: the command, folder and background flag come from the arguments, and the output keeps its last lines", async () => {
  const h = await app(100)
  h.tool("shell: bun test", "one\ntwo\nthree\nfour\nfive\n", "ok", JSON.stringify({ command: "bun test", workdir: "apps/cli", background: true }))
  const text = h.text()
  expect(text).toContain("$ bun test  in apps/cli  background  ✓")
  expect(text).toContain("… 2 earlier lines")
  expect(text).toContain("  five")
  expect(text).not.toContain("  two")
})

test("shell without a command argument falls back to the built-in card", async () => {
  const h = await app(100)
  h.tool("shell: make", "built", "ok", "{not json")
  expect(h.text()).not.toContain("earlier lines")
  expect(h.text()).toContain("make")
})

test("github: any mcp__github__ tool draws its action, repository, number and title; one without a repository is not taken", async () => {
  const h = await app(100)
  h.tool("mcp__github__create_pull_request", "created", "ok", JSON.stringify({ owner: "MendCode", repo: "MendCode", title: "Glyphs setting" }))
  h.tool("mcp__github__get_issue", "open", "ok", JSON.stringify({ owner: "MendCode", repo: "MendCode", issue_number: 42 }))
  h.tool("mcp__github__search_code", "3 hits", "ok", JSON.stringify({ q: "renderTool" }))
  const text = h.text()
  expect(text).toContain("create pull request  MendCode/MendCode  Glyphs setting")
  expect(text).toContain("get issue  MendCode/MendCode #42")
  expect(text).not.toContain("search code  ")
})

test("every row fits a 40 column terminal", async () => {
  const h = await app(40)
  h.tool("shell: bun test", "a very long line of output that will not fit in forty columns at all\n", "error", JSON.stringify({ command: "bun test apps/cli/test/example-tool-renderers.test.ts", workdir: "/Users/someone/projects/mendcode" }))
  h.tool("mcp__github__get_pull_request", "", "ok", JSON.stringify({ owner: "MendCode", repo: "MendCode", pull_number: 1, title: "A pull request title longer than the terminal" }))
  expect(h.rows().every((row) => textWidth(row) <= 40)).toBe(true)
  expect(h.text()).toContain("$ bun test")
  expect(h.text()).toContain("get pull request")
})
