import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPackageRegistry, listPackages, listPackageResources, setResourceEnabled } from "../src"
import { PackagePreviewReport } from "@mendcode/protocol"
import { packageCapabilities } from "../src/capabilities"

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "official-kit-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
test("small official kit previews without code, installs one unit and preserves stable identity/resource preferences", async () => {
  const userDir = temp(), directory = temp(), source = path.resolve(import.meta.dir, "../../../examples/official-packages")
  const registry = createPackageRegistry({ userDir, directory, capabilities: true })
  registry.addSource("official", source, true)
  const entries = registry.search("", "official").entries
  expect(entries).toHaveLength(3)
  for (const entry of entries) {
    const report = registry.preview(entry.name, "official", "project")
    expect(PackagePreviewReport.safeParse(report).success).toBe(true)
    expect(report.entry.contents).toMatchObject({ extensions: 0, tools: 0, mcp: false })
    expect(report.trust).toMatchObject({ signed: false, authorization: "required", identity: entry.name })
  }
  await registry.install("mendcode-review", "official", "project")
  expect(listPackages({ userDir, directory })).toHaveLength(1)
  const key = "project:mendcode-review"
  const disabledResources = setResourceEnabled({ userDir, directory, disabledResources: [], key, resource: "commands/focused-review", enabled: false })
  const manifest = path.join(directory, ".mendcode/packages/mendcode-review/mendcode-package.json")
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), title: "Renamed display name" }))
  expect(listPackageResources({ userDir, directory, disabledResources, key })[0]?.resources[0]?.enabled).toBe(false)
  expect(listPackages({ userDir, directory })[0]?.key).toBe(key)
  expect(registry.preview("mendcode-review", "official", "project").action).toBe("replace")
  await expect(registry.install("mendcode-review", "official", "project")).rejects.toThrow("already installed")
})
test("duplicate content warns across scopes/identities without disabling anything", async () => {
  const userDir = temp(), directory = temp(), source = temp()
  mkdirSync(path.join(source, "commands"))
  const manifest = path.join(source, "mendcode-package.json")
  writeFileSync(manifest, JSON.stringify({ name: "one", version: "1", description: "one" }))
  writeFileSync(path.join(source, "commands/review.md"), "Review only")
  const registry = createPackageRegistry({ userDir, directory })
  registry.addSource("one", source, true)
  await registry.install("one", "one", "user")
  writeFileSync(manifest, JSON.stringify({ name: "two", version: "1", description: "two" }))
  expect(registry.preview("two", "one", "project").trust?.duplicates).toEqual(["user:one"])
  expect(listPackages({ userDir, directory })[0]?.enabled).toBe(true)
})

test("environment preview reports names without evaluating code or exposing values", () => {
  const directory = temp()
  mkdirSync(path.join(directory, "extensions"))
  writeFileSync(path.join(directory, "mendcode-package.json"), JSON.stringify({ name: "env-hints", version: "1", description: "hints", environment: ["EXAMPLE_TOKEN"] }))
  writeFileSync(path.join(directory, "extensions/index.ts"), 'throw new Error("never load"); process.env.EXAMPLE_TOKEN; Bun.env["OTHER_KEY"]; const hidden = "private-value"')
  const caps = packageCapabilities(directory)
  expect(caps.declaredEnvironment).toEqual(["EXAMPLE_TOKEN"])
  expect(caps.observedEnvironment).toEqual(["EXAMPLE_TOKEN", "OTHER_KEY"])
  expect(JSON.stringify(caps)).not.toContain("private-value")
})
