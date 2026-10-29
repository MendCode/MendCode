import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPackageRegistry, extensionLayers, installPackage, listPackages, packageAssets } from "../src"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "mend-registry-")); temps.push(dir); return dir }
function write(file: string, value: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value) }
function fixture() {
  const userDir = temp(), directory = temp(), source = temp()
  const pack = (name: string) => {
    const folder = path.join(source, name)
    write(path.join(folder, "mendcode-package.json"), JSON.stringify({ name, version: "1.2.0", description: `${name} helpers` }))
    write(path.join(folder, "skills", "review", "SKILL.md"), "Review code")
    write(path.join(folder, "commands", "review.md"), "Review $ARGUMENTS")
    return folder
  }
  const alpha = pack("alpha"), beta = pack("beta")
  write(path.join(source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: ["alpha", "beta"].map((id) => ({ id, version: "1.2.0", title: `${id} pack`, description: `${id} helpers`, tags: [id === "alpha" ? "review" : "testing"], source: { url: `./${id}` } })) }))
  const registry = createPackageRegistry({ userDir, directory })
  return { userDir, directory, source, alpha, beta, registry }
}

test("source registration is opt-in, persists, and is disabled until explicitly enabled", () => {
  const f = fixture()
  expect(f.registry.sources().map((item) => item.id)).toEqual(["local"])
  f.registry.addSource("team", f.source)
  expect(f.registry.search().entries).toEqual([])
  expect(() => f.registry.search("", "team")).toThrow("disabled")
  expect(createPackageRegistry(f).sources().find((item) => item.id === "team")?.enabled).toBe(false)
  f.registry.addSource("team", f.source, true)
  expect(f.registry.search("review").entries.map((item) => item.name)).toEqual(["alpha"])
  expect(f.registry.search("1.2").entries).toHaveLength(2)
  expect(f.registry.search("ALPHA HELPERS").entries).toHaveLength(1)
  f.registry.removeSource("team")
  expect(f.registry.sources()).toHaveLength(1)
  expect(() => f.registry.removeSource("local")).toThrow("cannot be removed")
})

test("show and preview do not install, execute extensions or change settings", () => {
  const f = fixture()
  write(path.join(f.alpha, "extensions", "never.ts"), "throw new Error('must not import in preview')")
  f.registry.addSource("team", f.source, true)
  const before = readFileSync(path.join(f.userDir, "package-sources.json"), "utf8")
  expect(f.registry.show("alpha", "team")).toMatchObject({ name: "alpha", state: "available", contents: { skills: 1, commands: 1, extensions: 1 } })
  expect(f.registry.preview("alpha", "team", "project")).toMatchObject({ action: "install", scope: "project", problems: [] })
  expect(existsSync(path.join(f.directory, ".mendcode", "packages"))).toBe(false)
  expect(readFileSync(path.join(f.userDir, "package-sources.json"), "utf8")).toBe(before)
})

test("catalog install uses the audited v2 installer; replaces are explicit and state reflects disabled packages", async () => {
  const f = fixture()
  f.registry.addSource("team", f.source, true)
  await f.registry.install("alpha", "team", "user", false, () => 42)
  expect(listPackages(f)[0]).toMatchObject({ name: "alpha", install: { installedAt: 42 }, contents: { skills: 1 } })
  expect(f.registry.preview("alpha", "team", "user")).toMatchObject({ action: "replace", installedVersion: "1.2.0" })
  await expect(f.registry.install("alpha", "team", "user")).rejects.toThrow("already installed")
  await f.registry.install("alpha", "team", "user", true)
  expect(createPackageRegistry({ ...f, disabled: ["user:alpha"] }).search("", "team").entries[0]!.state).toBe("installed")
})

test("source application and ambiguous ids require one explicit target", async () => {
  const f = fixture()
  f.registry.addSource("team", f.source, true)
  await expect(f.registry.install(undefined, "team", "user")).rejects.toThrow("several packages")
  f.registry.addSource("single", f.beta, true)
  await f.registry.install(undefined, "single", "project")
  expect(listPackages(f)).toMatchObject([{ name: "beta", source: "project" }])
  expect(() => f.registry.show("beta")).toThrow("ambiguous")
  expect(() => f.registry.show("missing", "team")).toThrow("not found")
})

test("links, secrets and dishonest catalog metadata cannot be installed", async () => {
  const f = fixture()
  f.registry.addSource("team", f.source, true)
  write(path.join(f.alpha, ".env"), "SECRET=fixture")
  symlinkSync(f.beta, path.join(f.alpha, "linked"))
  const plan = f.registry.preview("alpha", "team", "user")
  expect(plan.problems.some((item) => item.includes("secret"))).toBe(true)
  expect(plan.problems.some((item) => item.includes("links"))).toBe(true)
  await expect(f.registry.install("alpha", "team", "user")).rejects.toThrow("secret")
  expect(listPackages(f)).toEqual([])
  write(path.join(f.beta, "mendcode-package.json"), JSON.stringify({ name: "different", version: "9", description: "changed" }))
  await expect(f.registry.install("beta", "team", "user")).rejects.toThrow("differs")
})

test("catalog paths cannot escape their source and only https catalogs (never git or plain http) become remote sources", () => {
  const f = fixture()
  for (const location of ["git:remote", "git@example.test:repo"]) expect(() => f.registry.addSource("remote", location, true)).toThrow("not a local folder")
  for (const location of ["http://example.test/catalog", "https://user:pw@example.test/c", "https://example.test/c#frag"]) expect(() => f.registry.addSource("remote", location, true)).toThrow()
  write(path.join(f.source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: [{ id: "alpha", version: "1", source: { url: f.userDir } }] }))
  f.registry.addSource("escape", f.source, true)
  expect(() => f.registry.search("", "escape")).toThrow("escapes")
  expect(f.registry.search().issues.join(" ")).toContain("escapes")
})

test("malformed, oversized, duplicate and unsupported catalogs have bounded errors", () => {
  const f = fixture()
  f.registry.addSource("team", f.source, true)
  for (const raw of ["{broken", JSON.stringify({ version: 9, packs: [] }), " ".repeat(1024 * 1024 + 1)]) {
    write(path.join(f.source, "marketplace-index.json"), raw)
    expect(() => f.registry.search("", "team")).toThrow()
  }
  write(path.join(f.source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: Array(2).fill({ id: "alpha", version: "1.2.0", source: { url: "alpha" } }) }))
  expect(() => f.registry.search("", "team")).toThrow("duplicate")
})

test("assets include enabled layers and prompt files without reading private content", async () => {
  const f = fixture()
  f.registry.addSource("single", f.alpha, true)
  await f.registry.install(undefined, "single", "user")
  write(path.join(f.userDir, "SYSTEM.md"), "private prompt content")
  write(path.join(f.directory, ".mendcode", "prompts", "custom.md"), "private project instructions")
  write(path.join(f.userDir, "goals", "continuation.md"), "private template")
  const assets = packageAssets(extensionLayers(f), "custom")
  expect(assets).toMatchObject({ promptMode: "custom", totals: { skills: 1, commands: 1, prompts: 1, templates: 2 } })
  expect(JSON.stringify(assets)).not.toContain("private prompt content")
  expect(JSON.stringify(assets)).not.toContain("private project instructions")
  expect(packageAssets(extensionLayers({ ...f, disabled: ["user:alpha"] }), "focus").totals.skills).toBe(0)
})

test("JSONC catalogs keep string content while accepting comments and trailing commas", () => {
  const f = fixture()
  rmSync(path.join(f.source, "marketplace-index.json"))
  write(path.join(f.source, ".mendcode", "marketplace", "index.jsonc"), `{
    // Local catalog
    "version": 0, "packs": [{ "id": "alpha", "version": "1.2.0",
      "description": "https://example.test/a/*b*/ // \\\"quoted\\\"", /* keep URL */
      "tags": ["review",], "source": { "url": "./alpha", },
    },],
  }`)
  f.registry.addSource("team", f.source, true)
  expect(f.registry.search("", "team").entries[0]!.description).toBe('https://example.test/a/*b*/ // "quoted"')
  expect(f.registry.search("review", "team").entries).toHaveLength(1)
  write(path.join(f.source, ".mendcode", "marketplace", "index.jsonc"), "{/* unterminated")
  expect(() => f.registry.search("", "team")).toThrow("invalid catalog JSON")
})

test("source preview excludes files the installer skips and staged catalog metadata is checked again", async () => {
  const f = fixture()
  write(path.join(f.alpha, ".git", "credentials"), "ignored fixture")
  write(path.join(f.alpha, "node_modules", "fixture", ".env"), "ignored fixture")
  f.registry.addSource("single", f.alpha, true)
  expect(f.registry.preview(undefined, "single", "user").problems).toEqual([])
  await expect(installPackage({ spec: f.alpha, scope: "user", userDir: f.userDir, directory: f.directory, expected: { name: "alpha", version: "changed" } })).rejects.toThrow("staged package manifest")
  expect(listPackages(f)).toEqual([])
  await f.registry.install(undefined, "single", "user")
  expect(existsSync(path.join(f.userDir, "packages", "alpha", ".git"))).toBe(false)
  expect(existsSync(path.join(f.userDir, "packages", "alpha", "node_modules"))).toBe(false)
})
