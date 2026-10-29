import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { sha256Hex } from "../packages/upgrade/src/checksum"
import { channelOf } from "../packages/upgrade/src/releases"
import type { ReleaseIndex } from "../packages/upgrade/src/release-index"
import { SCHEMA_VERSION } from "../packages/store/src/schema"

export function releaseIndex(input: { tag: string; repository: string; directory: string }): ReleaseIndex {
  const channel = channelOf({ tag: input.tag, prerelease: input.tag.includes("-"), draft: false, publishedAt: 0, assets: [] })
  if (!channel) throw new Error("unsupported release tag")
  const root = path.join(import.meta.dir, "..")
  const schema = ["schema.ts", "store.ts"].map((name) => readFileSync(path.join(root, "packages/store/src", name), "utf8")).join("\n")
  const assets = readdirSync(input.directory).filter((name) => /^mendcode-[a-zA-Z0-9.-]+$/.test(name)).sort().map((name) => {
    const bytes = readFileSync(path.join(input.directory, name))
    return { name, sha256: sha256Hex(bytes), size: bytes.byteLength }
  })
  if (!assets.length) throw new Error("no release binaries")
  return { formatVersion: 1, repository: input.repository, tag: input.tag, channel, schema: { version: SCHEMA_VERSION, fingerprint: sha256Hex(new TextEncoder().encode(schema)) }, assets }
}

if (import.meta.main) {
  const [tag, repository, directory] = process.argv.slice(2)
  if (!tag || !repository || !directory) throw new Error("usage: release-index.ts <tag> <owner/repo> <asset directory>")
  await Bun.write(path.join(directory, "release-index.json"), JSON.stringify(releaseIndex({ tag, repository, directory })) + "\n")
}
