import path from "node:path"

type Lockfile = { lockfileVersion: string; packages: Record<string, unknown>; importers: Record<string, unknown> }
type Manifest = { name: string; version?: string }
const order = (a: { "bom-ref": string }, b: { "bom-ref": string }) => a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0

export function readLockfile(text: string): Lockfile {
  const lock = Bun.YAML.parse(text) as Lockfile
  if (!lock || String(lock.lockfileVersion) !== "9.0" || !lock.packages || !lock.importers) throw new Error("expected pnpm lockfile v9 with packages and importers")
  return lock
}

function component(name: string, version: string, ref?: string) {
  const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${encodeURIComponent(version)}`
  return { type: "library" as const, "bom-ref": ref ?? purl, name, version, purl }
}

/** Inventory includes dev, optional and all-platform dependencies, not only bundled runtime modules. */
export function createSbom(lock: Lockfile, manifests: Record<string, Manifest>, version: string) {
  const root = manifests["."]
  if (!root?.name) throw new Error("missing root manifest")
  const external = Object.keys(lock.packages).map((key) => {
    const at = key.lastIndexOf("@")
    if (at <= 0 || at === key.length - 1) throw new Error(`unsupported lockfile package: ${key}`)
    return component(key.slice(0, at), key.slice(at + 1))
  })
  const workspace = Object.keys(lock.importers).filter((dir) => dir !== ".").map((dir) => {
    const manifest = manifests[dir]
    if (!manifest?.name) throw new Error(`missing workspace manifest: ${dir}`)
    return { ...component(manifest.name, dir === "apps/cli" ? version : manifest.version ?? version, `workspace:${dir}`), properties: [{ name: "mendcode:workspace", value: dir }] }
  })
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { ...component(root.name, version, "workspace:."), type: "application" },
      properties: [{ name: "mendcode:inventory", value: "pnpm lockfile packages and workspace importers, including development and optional dependencies" }],
    },
    components: [...external, ...workspace].sort(order),
  }
}

if (import.meta.main) {
  const [version, outfile] = process.argv.slice(2)
  if (!version || !outfile) throw new Error("usage: bun scripts/sbom.ts VERSION OUTFILE")
  const root = path.join(import.meta.dir, "..")
  const lock = readLockfile(await Bun.file(path.join(root, "pnpm-lock.yaml")).text())
  const manifests: Record<string, Manifest> = {}
  for (const dir of Object.keys(lock.importers)) manifests[dir] = await Bun.file(path.join(root, dir, "package.json")).json()
  await Bun.write(outfile, JSON.stringify(createSbom(lock, manifests, version), null, 2) + "\n")
}
