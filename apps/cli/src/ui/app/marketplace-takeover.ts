import { existsSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PackageCatalogEntry } from "@mendcode/protocol"
import type { TakeoverPreview } from "../../view/marketplace-page"

/**
 * What a catalog profile would take over once installed and on, before anything is installed: its manifest's `activate` section
 * resolved alone over the user's own profile, the same rows /profiles lists after the install. Read from the entry's local folder
 * (bounded, no code imported); a remote entry is not fetched for this. Loaded with the marketplace's first preview.
 */

const MAX_MANIFEST_BYTES = 32 * 1024
const MANIFESTS = ["mendcode-profile.json", "mendcode-package.json"]

export async function takeoverPreview(input: { dataDir: string; directory?: string | undefined; entry: PackageCatalogEntry; scope: "user" | "project" }): Promise<TakeoverPreview> {
  const { entry } = input
  if (entry.remote) return { status: "remote" }
  const file = MANIFESTS.map((name) => path.join(entry.location, name)).find((candidate) => existsSync(candidate))
  const info = file ? lstatSync(file, { throwIfNoEntry: false }) : undefined
  if (!file || !info?.isFile() || info.size > MAX_MANIFEST_BYTES) return { status: "unknown" }
  let manifest: unknown
  try { manifest = JSON.parse(readFileSync(file, "utf8")) } catch { return { status: "unknown" } }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest) || !("activate" in manifest)) return { status: "none" }
  const [{ loadActivation }, { readTuiProfile }] = await Promise.all([import("../../extensions/activation"), import("../../view/tui-profile")])
  const key = `${input.scope}:${entry.name}`
  const activation = loadActivation({
    manifests: [{ key, source: input.scope, name: entry.name, dir: entry.location, manifest: manifest as Record<string, unknown> }],
    dataDir: input.dataDir,
    directory: input.directory,
    projectTrusted: true,
    base: readTuiProfile(input.dataDir),
  })
  const rows = activation.result.rows.filter((row) => row.package === key)
  return rows.length ? { status: "rows", rows, problems: activation.problems } : { status: activation.problems.length ? "unknown" : "none", problems: activation.problems }
}
