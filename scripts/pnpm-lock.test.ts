import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const kinds = ["dependencies", "devDependencies", "optionalDependencies"] as const

type Manifest = Partial<Record<(typeof kinds)[number], Record<string, string>>>
type Importer = Partial<Record<(typeof kinds)[number], Record<string, { specifier: string }>>>

// CI installs with `pnpm install --frozen-lockfile`; local work uses bun, so a dependency added to a package.json without
// the pnpm lock passes every local check and fails every CI job at install. This compares what pnpm would.
test("pnpm-lock.yaml lists every dependency of every workspace package.json with the same specifier", () => {
  const lock = Bun.YAML.parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")) as { importers: Record<string, Importer> }
  const mismatches: string[] = []
  for (const importer of Object.keys(lock.importers)) {
    const manifest = JSON.parse(readFileSync(path.join(root, importer, "package.json"), "utf8")) as Manifest
    for (const kind of kinds) {
      const declared = manifest[kind] ?? {}
      const locked = lock.importers[importer]?.[kind] ?? {}
      for (const [name, specifier] of Object.entries(declared)) {
        if (locked[name]?.specifier !== specifier) mismatches.push(`${importer} ${kind} ${name}@${specifier} (lock: ${locked[name]?.specifier ?? "missing"})`)
      }
      for (const name of Object.keys(locked)) if (!(name in declared)) mismatches.push(`${importer} ${kind} ${name} is locked but not declared`)
    }
  }
  expect(mismatches).toEqual([])
})

test("every workspace package with a package.json has an importer in pnpm-lock.yaml", () => {
  const lock = Bun.YAML.parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")) as { importers: Record<string, Importer> }
  const workspace = Bun.YAML.parse(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as { packages: string[] }
  const missing = workspace.packages
    .flatMap((pattern) => [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })])
    .map((file) => path.dirname(file))
    .filter((dir) => !(dir in lock.importers))
  expect(missing).toEqual([])
})
