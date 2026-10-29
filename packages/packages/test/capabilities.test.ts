import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { packageCapabilities } from "../src/capabilities"
import { createPackageRegistry } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "caps-"))
  dirs.push(dir)
  return dir
}

test("declared capabilities and static hints never execute package code or expose source", () => {
  const root = temp()
  mkdirSync(path.join(root, "extensions"))
  writeFileSync(path.join(root, "mendcode-package.json"), JSON.stringify({ name: "test", version: "1", description: "test", capabilities: ["network"], extensions: true }))
  writeFileSync(path.join(root, "extensions", "index.ts"), 'throw new Error("DO NOT IMPORT secret literal")\napi.registerTool({})\napi.registerCommand("x", {})\napi.on("tool.before", fn)\nfetch("https://example.test")')
  const report = packageCapabilities(root)
  expect(report).toEqual({ declared: ["network"], declaredEnvironment: [], observed: ["commands", "hooks", "network", "tools"], observedEnvironment: [], complete: true })
  expect(JSON.stringify(report)).not.toContain("secret literal")
  const registry = createPackageRegistry({ userDir: temp(), directory: temp() })
  registry.addSource("test", root, true)
  expect(registry.preview("test", "test", "project").capabilities).toEqual(report)
  symlinkSync(path.join(root, "extensions", "index.ts"), path.join(root, "link.ts"))
  expect(packageCapabilities(root).complete).toBe(false)
})
