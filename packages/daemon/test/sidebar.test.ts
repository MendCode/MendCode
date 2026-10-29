import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { createSidebarTool, readSidebar, sidebarFile, updateSidebar } from "../src/sidebar"
import { classifySmart } from "@mendcode/engine-native"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sidebar-"))
  dirs.push(dir)
  const project = path.join(dir, "project")
  mkdirSync(project)
  return { dir, project }
}
test("all sidebar actions are atomic and preserve unrelated profile fields", () => {
  const { dir, project } = setup()
  const file = sidebarFile(dir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ theme: "mend", sidebar: "hidden" }))
  const run = (action: unknown) => updateSidebar(dir, project, action)
  expect(run({ action: "get" })).toEqual([])
  expect(run({ action: "set", widgets: [{ type: "context", options: {} }] })).toHaveLength(1)
  expect(run({ action: "add", widget: { type: "clock", title: "Local time", options: {} }, index: 0 }).map((w) => w.type)).toEqual(["clock", "context"])
  expect(run({ action: "move", index: 0, to: 1 }).map((w) => w.type)).toEqual(["context", "clock"])
  expect(run({ action: "remove", index: 0 }).map((w) => w.type)).toEqual(["clock"])
  const before = readFileSync(file, "utf8")
  for (const invalid of [{ action: "move", index: 0, to: 9 }, { action: "remove", index: 5 }, { action: "set", widgets: [{ type: "fake" }] }]) expect(() => run(invalid)).toThrow()
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(JSON.parse(before)).toMatchObject({ theme: "mend", sidebar: "hidden", rightSidebar: true })
  expect(readSidebar(dir, project)).toEqual(run({ action: "get" }))
  expect(run({ action: "clear" })).toEqual([])
  expect(JSON.parse(readFileSync(file, "utf8")).rightSidebar).toBe(false)
})
test("project override persists independently; an empty override suppresses user widgets", () => {
  const { dir, project } = setup()
  updateSidebar(dir, project, { action: "set", widgets: [{ type: "clock", options: {} }] })
  updateSidebar(dir, project, { action: "set", scope: "project", widgets: [{ type: "git", options: {} }] })
  expect(readSidebar(dir, project).map((w) => w.type)).toEqual(["git"])
  expect(readSidebar(dir, path.join(dir, "other")).map((w) => w.type)).toEqual(["clock"])
  updateSidebar(dir, project, { action: "clear", scope: "project" })
  expect(readSidebar(dir, project)).toEqual([])
})
test("native tool publishes validated UI changes and is low risk in smart mode", async () => {
  const { dir, project } = setup()
  const changes: unknown[] = []
  const tool = createSidebarTool(dir, (directory, widgets) => changes.push({ directory, widgets }))
  expect(z.toJSONSchema(tool.args)).toBeDefined()
  const ctx = { cwd: project, signal: new AbortController().signal }
  const set = await tool.execute(tool.args.parse({ action: "add", widget: { type: "clock", options: {} } }), ctx)
  expect(set.isError).toBe(false)
  expect(set.output).toBe("Right sidebar: clock")
  expect(changes).toHaveLength(1)
  await tool.execute(tool.args.parse({ action: "get" }), ctx)
  expect(changes).toHaveLength(1)
  for (const action of [
    { action: "set", widgets: [{ type: "clock", options: {} }] },
    { action: "add", widget: { type: "usage", options: {} } },
    { action: "move", index: 1, to: 0 },
    { action: "remove", index: 1 },
    { action: "clear" },
  ]) expect((await tool.execute(tool.args.parse(action), ctx)).isError).toBe(false)
  expect(readSidebar(dir, project)).toEqual([])
  expect(classifySmart({ tool, args: {}, cwd: project })).toMatchObject({ risk: "low", rule: "terminal-ui", decision: "allow" })
})
