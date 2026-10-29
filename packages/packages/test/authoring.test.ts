import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { authorLocalPackage, deleteLocalPackage } from "../src/authoring"
import { createPackageRegistry } from "../src/registry"
import { installPackage, MAX_PACKAGE_BYTES } from "../src/install"
import { listPackages, readManifest } from "../src/manifest"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-author-"))); temps.push(dir); return dir }
function write(file: string, text: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function fixture() {
  const directory = temp(), userDir = temp(), source = path.join(directory, ".mendcode")
  write(path.join(source, "commands/review.md"), "Review $ARGUMENTS")
  write(path.join(source, "skills/tests/SKILL.md"), "# Tests\nRun relevant checks")
  write(path.join(source, "prompts/review.md"), "Review changes")
  write(path.join(source, "tui/profile.json"), JSON.stringify({ theme: "mendcode" }))
  return { directory, userDir, source, registry: () => createPackageRegistry({ directory, userDir }) }
}
function snapshot(directory: string, relative: string) { return readFileSync(path.join(directory, relative, "runtime-pack.json"), "utf8") }

test("create authors an audited native package and exposes it in the local catalog without activating it", async () => {
  const f = fixture()
  const report = authorLocalPackage({ directory: f.directory, action: "create", metadata: { id: "review", title: "Review Kit", description: "Review helpers", version: "1.2.0", kind: "skill-pack", channel: "local", sourceType: "local", sourceURL: "./review", compatMendcode: "^2", compatRuntimePack: "^0" }, now: () => 42 })
  expect(report).toMatchObject({ name: "review", version: "1.2.0", activated: false, signed: false, secretsIncluded: false })
  expect(readManifest(path.join(f.directory, report.packagePath))).toMatchObject({ manifest: { title: "Review Kit", kind: "skill-pack", compatibility: { mendcode: "^2" }, distribution: { trust: { signatureRequired: false } }, extensions: false } })
  expect(f.registry().search("Review Kit", "local").entries).toMatchObject([{ name: "review", state: "available", tags: ["authored", "unsigned"], contents: { commands: 1, skills: 1 } }])
  expect(f.registry().preview("review", "local", "user").problems).toEqual([])
  expect(listPackages(f)).toEqual([])
  await installPackage({ spec: path.join(f.directory, report.packagePath), scope: "user", userDir: f.userDir, directory: f.directory })
  expect(listPackages(f)).toMatchObject([{ name: "review", manifest: { title: "Review Kit" }, contents: { commands: 1, skills: 1 } }])
})

test("update preserves metadata and explicit file selection; reselection refreshes assets and backs up the old revision", () => {
  const f = fixture()
  const first = authorLocalPackage({ directory: f.directory, action: "create", metadata: { id: "review", title: "Review Kit" }, include: ["commands", "skills", "models"], exclude: ["models"] })
  expect(first.artifacts).toEqual(["commands/review.md", "skills/tests/SKILL.md"])
  write(path.join(f.source, "commands/new.md"), "New command")
  write(path.join(f.source, "commands/review.md"), "Updated review")
  const second = authorLocalPackage({ directory: f.directory, action: "update", metadata: { version: "2.0.0" } })
  expect(second).toMatchObject({ name: "review", title: "Review Kit", version: "2.0.0", artifacts: first.artifacts })
  expect(readFileSync(path.join(f.directory, second.backupPath!, "commands/review.md"), "utf8")).toBe("Review $ARGUMENTS")
  expect(readFileSync(path.join(f.directory, second.packagePath, "commands/review.md"), "utf8")).toBe("Updated review")
  const refreshed = authorLocalPackage({ directory: f.directory, action: "update", include: ["all"], exclude: ["tuiProfile"] })
  expect(refreshed.artifacts).toContain("commands/new.md")
  expect(refreshed.artifacts).not.toContain("tui/profile.json")
})

test("delete-local moves only generated data to Trash, clears selection and preserves metadata, sources and installed copies", async () => {
  const f = fixture()
  const report = authorLocalPackage({ directory: f.directory, action: "create", metadata: { id: "review", title: "Review Kit" }, include: ["commands"] })
  await installPackage({ spec: path.join(f.directory, report.packagePath), scope: "project", userDir: f.userDir, directory: f.directory })
  const deleted = deleteLocalPackage(f.directory)
  expect(deleted).toMatchObject({ action: "delete-local", selectionCleared: true, localArtifactsTouched: false, removed: [report.packagePath] })
  expect(existsSync(path.join(f.directory, report.packagePath))).toBe(false)
  expect(readFileSync(path.join(f.directory, deleted.trashPath!, "commands/review.md"), "utf8")).toBe("Review $ARGUMENTS")
  expect(readFileSync(path.join(f.source, "commands/review.md"), "utf8")).toBe("Review $ARGUMENTS")
  expect(listPackages(f)).toMatchObject([{ name: "review", source: "project" }])
  expect(deleteLocalPackage(f.directory).removed).toEqual([])
  const recreated = authorLocalPackage({ directory: f.directory, action: "create" })
  expect(recreated).toMatchObject({ name: "review", title: "Review Kit" })
  expect(recreated.artifacts).toContain("skills/tests/SKILL.md")
  expect(f.registry().search("", "local").entries.filter((entry) => entry.name === "review")).toHaveLength(1)
})

test("failed metadata, selection and secret audits leave the previous package and authoring selection unchanged", () => {
  const f = fixture()
  const report = authorLocalPackage({ directory: f.directory, action: "create" })
  const before = snapshot(f.directory, report.packagePath), state = readFileSync(path.join(f.source, "package-authoring.json"), "utf8")
  for (const metadata of [{ id: "../escape" }, { title: "x".repeat(201) }]) expect(() => authorLocalPackage({ directory: f.directory, action: "update", metadata })).toThrow("metadata")
  expect(() => authorLocalPackage({ directory: f.directory, action: "update", include: ["unknown"] })).toThrow("unknown")
  write(path.join(f.source, "skills/tests/credentials.json"), "{}")
  expect(() => authorLocalPackage({ directory: f.directory, action: "update" })).toThrow("secret")
  expect(snapshot(f.directory, report.packagePath)).toBe(before)
  expect(readFileSync(path.join(f.source, "package-authoring.json"), "utf8")).toBe(state)
})

test("credentials in MCP and textual artifacts are rejected; provider credentials and user history are never read", () => {
  const f = fixture()
  write(path.join(f.userDir, "providers.json"), JSON.stringify({ apiKey: "private-provider-value" }))
  write(path.join(f.source, "providers.json"), JSON.stringify({ apiKey: "private-provider-value" }))
  write(path.join(f.source, "mcp.json"), JSON.stringify({ servers: { local: { command: "fake", env: { CONFIG: "private-value" } } } }))
  expect(() => authorLocalPackage({ directory: f.directory, action: "create" })).toThrow("env/headers")
  write(path.join(f.source, "mcp.json"), JSON.stringify({ servers: { local: { command: "fake", env: { API_KEY: "${API_KEY}" } } } }))
  const report = authorLocalPackage({ directory: f.directory, action: "create" })
  expect(report.artifacts).not.toContain("providers.json")
  expect(snapshot(f.directory, report.packagePath)).not.toContain("private-provider-value")
  write(path.join(f.source, "commands/review.md"), `Use sk-proj-${"A1b2c3d4".repeat(6)}`)
  expect(() => authorLocalPackage({ directory: f.directory, action: "update" })).toThrow("credentials")
})

test("source and output links cannot redirect an authoring write or removal", () => {
  const f = fixture(), outside = temp()
  symlinkSync(outside, path.join(f.source, "commands/escape"))
  expect(() => authorLocalPackage({ directory: f.directory, action: "create" })).toThrow("links")
  expect(() => authorLocalPackage({ directory: f.directory, action: "create", exclude: ["commands"] })).not.toThrow()
  deleteLocalPackage(f.directory)
  symlinkSync(outside, path.join(f.source, "package-local"))
  expect(() => authorLocalPackage({ directory: f.directory, action: "update", exclude: ["commands"] })).toThrow("links")
  expect(() => deleteLocalPackage(f.directory)).toThrow("links")
  const project = temp()
  symlinkSync(outside, path.join(project, ".mendcode"))
  expect(() => authorLocalPackage({ directory: project, action: "create" })).toThrow("links")
})

test("bounded exports reject oversized assets before replacing the package", () => {
  const f = fixture()
  const report = authorLocalPackage({ directory: f.directory, action: "create" })
  const before = snapshot(f.directory, report.packagePath)
  writeFileSync(path.join(f.source, "commands/large.md"), Buffer.alloc(MAX_PACKAGE_BYTES))
  expect(() => authorLocalPackage({ directory: f.directory, action: "update" })).toThrow("limit")
  expect(snapshot(f.directory, report.packagePath)).toBe(before)
})

test("native extension artifacts are snapshotted without importing code and carry an honest manifest", () => {
  const f = fixture()
  write(path.join(f.source, "extensions/never.ts"), "throw new Error('must not import while authoring')")
  const report = authorLocalPackage({ directory: f.directory, action: "update", include: ["extensions"] })
  expect(report.artifacts).toEqual(["extensions/never.ts"])
  expect(readManifest(path.join(f.directory, report.packagePath))).toMatchObject({ manifest: { extensions: true } })
  expect(f.registry().preview("local", "local", "project").problems).toEqual([])
})
