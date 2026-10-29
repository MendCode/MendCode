import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Settings } from "@mendcode/protocol"
import { APPROVAL_SETTINGS, applyImport, exportBundle, MACHINE_SETTINGS, manifestHash, parseBundle, planImport, PORTABLE_SETTINGS, readBundle, serializeBundle, type Bundle, type ImportPorts } from "../src/config-bundle"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(label: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-bundle-${label}-`)))
  dirs.push(dir)
  return dir
}
function write(root: string, relative: string, text: string) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  writeFileSync(path.join(root, relative), text)
}
const exportFrom = (dir: string, settings: Record<string, unknown> = {}, home = "/Users/a") => exportBundle({ dataDir: dir, settings, home, platform: "darwin", arch: "arm64", now: 1 }).bundle
const roundTrip = (bundle: Bundle) => parseBundle(JSON.parse(serializeBundle(bundle)))

test("every settings key is classified on purpose: none falls to the approval default by accident", () => {
  const shape = (Settings as unknown as { shape: Record<string, unknown> }).shape
  const keys = Object.keys(shape)
  expect(keys.length).toBeGreaterThan(50)
  const unclassified = keys.filter((key) => !PORTABLE_SETTINGS.has(key) && !APPROVAL_SETTINGS.has(key) && !MACHINE_SETTINGS.has(key))
  expect(unclassified).toEqual([])
  const twice = keys.filter((key) => [PORTABLE_SETTINGS, APPROVAL_SETTINGS, MACHINE_SETTINGS].filter((set) => set.has(key)).length > 1)
  expect(twice).toEqual([])
  for (const authority of ["models", "defaultPermission", "permission", "budgets", "tier", "features", "experimental", "sandbox", "provider"]) expect(APPROVAL_SETTINGS.has(authority)).toBe(true)
})

test("a bundle refuses tampering: changed bytes, an edited manifest, unknown versions and escaping paths", () => {
  const dir = temp("tamper")
  write(dir, "skills/a/SKILL.md", "---\nname: a\ndescription: a\n---\nA\n")
  const bundle = exportFrom(dir)
  expect(roundTrip(bundle).manifest.entries.map((entry) => entry.path)).toEqual(["skills/a/SKILL.md"])
  const bytes = structuredClone(bundle)
  bytes.files["skills/a/SKILL.md"] = Buffer.from("changed").toString("base64")
  expect(() => roundTrip(bytes)).toThrow("does not match its sha256")
  const manifest = structuredClone(bundle)
  manifest.manifest.warnings.push("added later")
  expect(() => roundTrip(manifest)).toThrow("manifest hash does not match")
  const version = structuredClone(bundle) as unknown as { manifest: { version: number } }
  version.manifest.version = 2
  expect(() => parseBundle(version)).toThrow("version 2 is not supported")
  const escape = structuredClone(bundle)
  escape.manifest.entries[0]!.path = "../outside.md"
  escape.manifestSha256 = manifestHash(escape.manifest)
  expect(() => roundTrip(escape)).toThrow("unsafe path")
  const extra = structuredClone(bundle)
  extra.files["AGENTS.md"] = Buffer.from("x").toString("base64")
  expect(() => roundTrip(extra)).toThrow("not in the manifest")
  const file = path.join(dir, "bundle.json")
  writeFileSync(file, "{\"manifest\":{\"format\":\"other\"}}")
  expect(() => readBundle(file)).toThrow("not a MendCode configuration bundle")
})

test("export never follows links, never reads credential files and keeps whole packages or none", () => {
  const dir = temp("export"), outside = temp("outside")
  write(outside, "secret-notes.md", "outside the data dir\n")
  write(dir, "AGENTS.md", "rules\n")
  symlinkSync(path.join(outside, "secret-notes.md"), path.join(dir, "skills-link"))
  mkdirSync(path.join(dir, "skills"), { recursive: true })
  symlinkSync(outside, path.join(dir, "skills", "linked"))
  write(dir, "providers.json", "not json at all, and never opened")
  write(dir, "keys/k", "private")
  write(dir, "packages/half/mendcode-package.json", JSON.stringify({ name: "half", version: "1.0.0", description: "h", extensions: false }))
  write(dir, "packages/half/skills/ok/SKILL.md", "---\nname: ok\ndescription: ok\n---\nok\n")
  write(dir, "packages/half/skills/bad/SKILL.md", `---\nname: bad\ndescription: b\n---\nANTHROPIC_API_KEY=sk-ant-api03-${"x".repeat(80)}\n`)
  const bundle = exportFrom(dir)
  const paths = bundle.manifest.entries.map((entry) => entry.path)
  expect(paths).toEqual(["AGENTS.md"])
  const excluded = Object.fromEntries(bundle.manifest.excluded.map((entry) => [entry.path, entry.column]))
  expect(excluded).toMatchObject({ "skills-link": "machine", "skills/linked": "machine", "providers.json": "approval", "keys": "approval", "packages/half": "approval" })
  expect(JSON.stringify(bundle)).not.toContain("outside the data dir")
  const allowed = exportBundle({ dataDir: dir, settings: {}, home: "/Users/a", platform: "darwin", arch: "arm64", now: 1, allowFlagged: ["packages/half"] }).bundle
  expect(allowed.manifest.packages.map((pkg) => pkg.name)).toEqual(["half"])
  expect(allowed.manifest.warnings.some((line) => line.startsWith("packages/half/skills/bad/SKILL.md: flagged as a possible credential") && !line.includes("sk-ant"))).toBe(true)
})

test("the plan never writes through a link in the target, and adapts or warns about the source machine", () => {
  const source = temp("plan-src"), target = temp("plan-dst"), shared = temp("shared")
  write(source, "skills/s/SKILL.md", "---\nname: s\ndescription: s\n---\nsee /Users/a/Code and osascript\n")
  write(source, "AGENTS.md", "rules\n")
  const bundle = exportFrom(source)
  symlinkSync(shared, path.join(target, "skills"))
  const plan = planImport({ bundle, dataDir: target, settings: {}, home: "/home/b", platform: "linux", onConflict: "replace" })
  expect(plan.steps.find((step) => step.kind === "unit" && step.unit === "skills/s")).toMatchObject({ status: "blocked" })
  expect(plan.steps.find((step) => step.kind === "unit" && step.unit === "AGENTS.md")).toMatchObject({ status: "new" })
  expect(plan.warnings.some((line) => line.includes("from darwin") && line.includes("linux"))).toBe(true)
  expect(plan.warnings.some((line) => line.includes("--rewrite-home"))).toBe(true)
  expect(plan.warnings.some((line) => line.includes("skills/s/SKILL.md") && line.includes("macOS-only command"))).toBe(true)
  const rewritten = planImport({ bundle, dataDir: temp("plan-dst2"), settings: {}, home: "/home/b", platform: "linux", onConflict: "keep", rewriteHome: true })
  expect(rewritten.steps.find((step) => step.kind === "unit" && step.unit === "skills/s")).toMatchObject({ status: "new", files: [expect.objectContaining({ rewritten: true })] })
  expect(rewritten.planId).not.toBe(plan.planId)
})

test("a failure halfway undoes what the import already wrote", async () => {
  const source = temp("fail-src"), target = temp("fail-dst")
  write(source, "AGENTS.md", "rules\n")
  write(source, "commands/a.md", "A\n")
  write(source, "packages/p/mendcode-package.json", JSON.stringify({ name: "p", version: "1.0.0", description: "p", extensions: false }))
  write(source, "packages/p/skills/x/SKILL.md", "---\nname: x\ndescription: x\n---\nx\n")
  write(target, "commands/a.md", "target A\n")
  const bundle = exportFrom(source, { theme: "mend" })
  const plan = planImport({ bundle, dataDir: target, settings: {}, home: "/Users/a", platform: "darwin", onConflict: "replace" })
  let settings: Record<string, unknown> = {}
  const ports: ImportPorts = {
    settings: async () => settings,
    setSettings: async (patch) => { settings = { ...settings, ...patch } },
    installPackage: async () => { throw new Error("installer refused: disk full") },
    enablePackage: async () => {},
    removePackage: async () => {},
    setPackageResource: async () => {},
  }
  await expect(applyImport({ bundle, plan, expectedPlanId: plan.planId, ports, now: 2, rewriteHome: false })).rejects.toThrow("import failed and was undone: installer refused")
  expect(readFileSync(path.join(target, "commands/a.md"), "utf8")).toBe("target A\n")
  expect(existsSync(path.join(target, "AGENTS.md"))).toBe(false)
  expect(settings).toEqual({})
})

test("found on real data: a long exclusion reason still reads back, and a rewritten package is expected in its rewritten form", () => {
  const source = temp("real-src"), target = temp("real-dst")
  write(source, "packages/big/mendcode-package.json", JSON.stringify({ name: "big", version: "1.0.0", description: "b", extensions: false }))
  for (let index = 0; index < 4; index++) write(source, `packages/big/skills/s${index}/${"deep/".repeat(20)}SKILL.md`, `---\nname: s\ndescription: s\n---\napi_key = "${"k".repeat(12)}${index}abcdefghij"\n`)
  write(source, "packages/home/mendcode-package.json", JSON.stringify({ name: "home", version: "1.0.0", description: "h", extensions: false, distribution: { source: { type: "local", url: "/Users/a/code/repos/config" }, trust: { signatureRequired: false } } }))
  const bundle = roundTrip(exportFrom(source))
  expect(bundle.manifest.excluded.find((entry) => entry.path === "packages/big")!.reason.length).toBeGreaterThan(300)
  const plan = planImport({ bundle, dataDir: target, settings: {}, home: "/home/b", platform: "linux", onConflict: "keep", rewriteHome: true })
  const step = plan.steps.find((item) => item.kind === "package" && item.name === "home")
  expect(step && step.kind === "package" && step.treeSha256).not.toBe(bundle.manifest.packages.find((pkg) => pkg.name === "home")!.treeSha256)
})
