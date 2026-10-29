import { expect, test } from "bun:test"
import path from "node:path"
import { createSbom, readLockfile } from "./sbom"

test("CycloneDX shape, unique refs and component counts match lockfile and workspace", async () => {
  const root = path.join(import.meta.dir, "..")
  const lock = readLockfile(await Bun.file(path.join(root, "pnpm-lock.yaml")).text())
  const manifests: Record<string, { name: string; version?: string }> = {}
  for (const dir of Object.keys(lock.importers)) manifests[dir] = await Bun.file(path.join(root, dir, "package.json")).json()
  const bom = createSbom(lock, manifests, "1.2.3")
  expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "mendcode", version: "1.2.3" } } })
  expect(bom.components).toHaveLength(Object.keys(lock.packages).length + Object.keys(lock.importers).length - 1)
  expect(new Set(bom.components.map((item) => item["bom-ref"])).size).toBe(bom.components.length)
  for (const item of bom.components) {
    expect(item.type).toBe("library")
    expect(item.name.length).toBeGreaterThan(0)
    expect(item.version.length).toBeGreaterThan(0)
    expect(item.purl).toMatch(/^pkg:npm\/.+@.+$/)
  }
  expect(bom.components.find((item) => item.name === "@types/bun")?.purl).toBe("pkg:npm/%40types/bun@1.3.13")
  expect(bom.components.find((item) => item["bom-ref"] === "workspace:apps/cli")?.version).toBe("1.2.3")
  const reversed = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).reverse())
  expect(createSbom({ ...lock, packages: reversed(lock.packages), importers: reversed(lock.importers) }, reversed(manifests), "1.2.3")).toEqual(bom)
})

test("unsupported lockfiles and missing workspace manifests are refused", () => {
  expect(() => readLockfile("lockfileVersion: '8.0'\npackages: {}\nimporters: {}\n")).toThrow("expected pnpm lockfile v9")
  expect(() => createSbom({ lockfileVersion: "9.0", packages: {}, importers: { ".": {}, "apps/cli": {} } }, { ".": { name: "root" } }, "1.2.3")).toThrow("missing workspace manifest")
})
