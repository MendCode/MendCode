import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudePlanFile } from "../src/plan-file"

const saved = process.env.CLAUDE_CONFIG_DIR
const dirs: string[] = []
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function config() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-cfg-"))
  dirs.push(dir)
  mkdirSync(path.join(dir, "plans"))
  process.env.CLAUDE_CONFIG_DIR = dir
  return path.join(dir, "plans")
}

test("the plan file is the one whose text is the submitted plan, by name or by search", () => {
  const plans = config()
  writeFileSync(path.join(plans, "old-one.md"), "# Old\n")
  writeFileSync(path.join(plans, "lively-doodling-grove.md"), "# Plan\n\n1. A\n")
  expect(claudePlanFile("# Plan\n\n1. A", undefined)).toBe(path.join(plans, "lively-doodling-grove.md"))
  expect(claudePlanFile("# Plan\n\n1. A", path.join(plans, "lively-doodling-grove.md"))).toBe(path.join(plans, "lively-doodling-grove.md"))
})

test("a path outside the plans folder, or text that matches no file, gives none", () => {
  const plans = config()
  writeFileSync(path.join(plans, "a.md"), "# A\n")
  expect(claudePlanFile("# Different", undefined)).toBeUndefined()
  expect(claudePlanFile("# A", "/etc/hosts.md")).toBe(path.join(plans, "a.md"))
  expect(claudePlanFile("# Different", "/etc/passwd.md")).toBeUndefined()
})
