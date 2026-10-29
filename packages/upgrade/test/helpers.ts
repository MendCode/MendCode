import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sha256Hex } from "../src/checksum"
import { nodeFs } from "../src/io"
import type { UpgradePorts } from "../src/ports"
import type { Platform } from "../src/releases"

export const REPO = "acme/mendcode-test"
export const LINUX_X64: Platform = { os: "linux", arch: "x64" }
export const DARWIN_ARM64: Platform = { os: "darwin", arch: "arm64" }
const encoder = new TextEncoder()

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-upgrade-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * `attested` (default) is a public-repository release: it carries `provenance.sigstore.json`. `cosign` is what a private
 * repository produces: no provenance, a cosign bundle `<file>.sigstore.json` for each binary and for SHA256SUMS, and the
 * release index covered by the SHA256SUMS digests. `without` lists assets the release leaves out.
 */
export type FakeRelease = { tag: string; prerelease?: boolean; draft?: boolean; published?: string; binaries?: Record<string, string>; sums?: string | null; mode?: "attested" | "cosign"; without?: string[] }

const url = (tag: string, name: string) => `https://example.test/${REPO}/releases/download/${tag}/${name}`
let assetId = 1000
export const apiUrl = (id: number) => `https://api.github.com/repos/${REPO}/releases/assets/${id}`

/** A GitHub-shaped release whose assets are served by `fakePorts`. `binaries` maps asset name to content. */
export function release({ tag, prerelease = false, draft = false, published = "2026-01-01T00:00:00Z", binaries = {}, sums, mode = "attested", without = [] }: FakeRelease) {
  const names = Object.keys(binaries)
  const index = new TextEncoder().encode(JSON.stringify({ formatVersion: 1, repository: REPO, tag, channel: tag.startsWith("dev-") ? "dev" : tag.includes("-nightly.") ? "nightly" : tag.includes("-beta.") ? "beta" : "stable", schema: { version: 1, fingerprint: "1".repeat(64) }, assets: names.map((name) => ({ name, sha256: sha256Hex(encoder.encode(binaries[name]!)), size: encoder.encode(binaries[name]!).byteLength })) }))
  const lines = names.map((name) => `${sha256Hex(encoder.encode(binaries[name]!))}  ${name}`)
  if (mode === "cosign") lines.push(`${sha256Hex(index)}  release-index.json`)
  const sumsText = sums === undefined ? lines.join("\n") + "\n" : sums
  const content = new Map<string, Uint8Array>(names.map((name) => [name, encoder.encode(binaries[name]!)]))
  if (sumsText !== null) content.set("SHA256SUMS", encoder.encode(sumsText))
  content.set("release-index.json", index)
  if (mode === "attested") content.set("provenance.sigstore.json", encoder.encode("provenance"))
  else for (const name of [...names, "SHA256SUMS"]) content.set(`${name}.sigstore.json`, encoder.encode(`bundle of ${name}`))
  const assets: Array<{ name: string; browser_download_url: string; url: string }> = []
  const files = new Map<string, Uint8Array>()
  for (const [name, bytes] of content) {
    if (without.includes(name)) continue
    assets.push({ name, browser_download_url: url(tag, name), url: apiUrl(assetId++) })
    files.set(url(tag, name), bytes)
  }
  return { json: { tag_name: tag, prerelease, draft, published_at: published, assets }, files }
}

/** Offline ports: the release list and downloads come from memory, the filesystem is the real one (temp dirs only). */
export function fakePorts(releases: ReturnType<typeof release>[], now = 1_700_000_000_000) {
  const requested: string[] = []
  const verified: Array<{ bundle: string | undefined; metadata: boolean; tag: string; repo: string }> = []
  const files = new Map<string, Uint8Array>()
  for (const entry of releases) for (const [key, value] of entry.files) files.set(key, value)
  const ports: UpgradePorts = {
    fetchJson: async (target) => {
      requested.push(target)
      if (!target.startsWith(`https://api.github.com/repos/${REPO}/releases`)) throw new Error(`unexpected URL ${target}`)
      return target.includes("/tags/") ? releases.find((entry) => target.endsWith(encodeURIComponent(entry.json.tag_name)))?.json : releases.map((entry) => entry.json)
    },
    download: async (target) => {
      requested.push(target)
      const bytes = files.get(target)
      if (!bytes) throw new Error(`unexpected download ${target}`)
      return bytes
    },
    fs: nodeFs,
    verifyProvenance: async (input) => { verified.push({ bundle: input.bundle ? new TextDecoder().decode(input.bundle) : undefined, metadata: input.metadata === true, tag: input.tag, repo: input.repo }) },
    now: () => now,
  }
  return { ports, requested, verified }
}
