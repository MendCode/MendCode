import { readdir } from "node:fs/promises"
import path from "node:path"
import { sha256Hex } from "../packages/upgrade/src/checksum"

/** The manifest and its own signature cannot hash themselves. All other release files are covered. */
export async function writeChecksums(dir: string) {
  const files = (await readdir(dir, { withFileTypes: true })).filter((entry) => !["SHA256SUMS", "SHA256SUMS.sigstore.json"].includes(entry.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (!files.length || files.some((file) => !file.isFile() || /[\s\\]/.test(file.name))) throw new Error("expected nonempty release directory with plain files")
  const lines: string[] = []
  for (const file of files) lines.push(`${sha256Hex(await Bun.file(path.join(dir, file.name)).bytes())}  ${file.name}`)
  await Bun.write(path.join(dir, "SHA256SUMS"), lines.join("\n") + "\n")
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) throw new Error("usage: bun scripts/checksums.ts DIRECTORY")
  await writeChecksums(dir)
}
