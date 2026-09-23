import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"

const repository = "MendCode/MendCode"
const workflow = ".github/workflows/release.yml"
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
const checksum = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const MAX_INDEX_BYTES = 512 * 1024

const Index = z.object({
  formatVersion: z.literal(1),
  version: z.string(),
  channel: z.enum(["stable", "beta", "nightly"]),
  tag: z.string(),
  commit,
  repository: z.literal(repository),
  provenance: z.object({ workflow: z.literal(workflow), runID: z.string().regex(/^[1-9]\d*$/) }),
  installer: z.object({ path: z.literal("src/mendcode/install"), commit, sha256 }),
  windowsInstaller: z.object({ path: z.literal("src/mendcode/install.ps1"), commit, sha256 }),
  schema: z.object({
    journal: z.array(z.object({ name: z.string().regex(/^\d{14}_[a-z0-9_-]+$/), timestamp: z.number().int().nonnegative(), hash: sha256 })).min(1).max(2048),
    fingerprint: sha256,
  }),
  assets: z.array(z.object({ name: z.string(), platform: z.string(), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256 })).min(1).max(64),
})

export type ReleaseIndex = z.infer<typeof Index>
export type AttestationRunner = (command: string, args: string[], options: { timeoutMs: number }) => Promise<{ exitCode: number }>
export type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>

function channel(version: string) {
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return "stable"
  if (/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) return "beta"
  if (/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(version)) return "nightly"
  throw new Error("Unsupported release version; select stable, beta.N or nightly.DATE.RUN.")
}

export function validateReleaseIndex(value: unknown, expected: { version: string; commit?: string }): ReleaseIndex {
  const data = Index.parse(value)
  if (data.version !== expected.version || data.tag !== `v${expected.version}` || data.channel !== channel(expected.version))
    throw new Error("Release index version, tag or channel does not match the requested release.")
  if ((expected.commit && data.commit !== expected.commit) || data.installer.commit !== data.commit || data.windowsInstaller.commit !== data.commit)
    throw new Error("Release index source commit does not match the immutable release tag.")
  const journal = data.schema.journal
  for (let index = 0; index < journal.length; index++) {
    const entry = journal[index]
    const values = entry.name.slice(0, 14).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!.slice(1).map(Number)
    if (Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5]) !== entry.timestamp)
      throw new Error("Release schema migration timestamp does not match its identity.")
    if (index > 0 && (journal[index - 1].name >= entry.name || journal[index - 1].timestamp >= entry.timestamp))
      throw new Error("Release schema journal is duplicated or out of order.")
  }
  if (checksum(JSON.stringify(journal)) !== data.schema.fingerprint) throw new Error("Release schema fingerprint is invalid.")
  const names = new Set<string>()
  for (const asset of data.assets) {
    const match = /^mendcode-((linux|darwin|windows)-(arm64|x64)(-baseline)?(-musl)?)\.(zip|tar\.gz)$/.exec(asset.name)
    if (!match || match[1] !== asset.platform || names.has(asset.name)) throw new Error("Invalid or duplicate release asset.")
    if ((match[2] === "linux") !== (match[6] === "tar.gz") || (match[5] && match[2] !== "linux") || (match[4] && match[3] !== "x64"))
      throw new Error("Release asset platform and archive type disagree.")
    names.add(asset.name)
  }
  return data
}

async function boundedFetch(url: string, fetcher: ReleaseFetch, limit: number) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } })
  if (response.status === 404 && url.endsWith("/release-index.json"))
    throw new Error("This release has no verified release index. Use the documented external recovery path for legacy versions; automatic installation is blocked.")
  if (!response.ok) throw new Error(`Release verification download failed (HTTP ${response.status}).`)
  const size = Number(response.headers.get("content-length"))
  if (size > limit) { await response.body?.cancel(); throw new Error("Release verification metadata exceeds the size limit.") }
  if (!response.body) throw new Error("Release verification metadata is empty.")
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) { await reader.cancel(); throw new Error("Release verification metadata exceeds the size limit.") }
      parts.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(parts, length)
}

/** The returned installer and checksums are usable only after the verifier exits successfully. */
export async function verifyReleaseIndex(input: {
  version: string
  directory: string
  run: AttestationRunner
  fetch?: ReleaseFetch
}) {
  channel(input.version)
  const fetcher = input.fetch ?? fetch
  const bytes = await boundedFetch(`https://github.com/${repository}/releases/download/v${input.version}/release-index.json`, fetcher, MAX_INDEX_BYTES)
  const parsed = validateReleaseIndex(JSON.parse(bytes.toString("utf8")), { version: input.version })
  await mkdir(input.directory, { recursive: true, mode: 0o700 })
  const operation = await mkdtemp(path.join(input.directory, "verify-release-"))
  const file = path.join(operation, "release-index.json")
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" })
  let result: { exitCode: number }
  try {
    result = await input.run("gh", ["attestation", "verify", file, "--repo", repository, "--signer-workflow", `${repository}/${workflow}`, "--deny-self-hosted-runners"], { timeoutMs: 30_000 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error("GitHub CLI (gh) is required to verify release provenance. Install it explicitly before retrying.")
    throw new Error("Release provenance verification could not complete; installation is blocked.")
  }
  if (result.exitCode !== 0) throw new Error("Release provenance verification failed; installation is blocked.")
  const resolved = JSON.parse((await boundedFetch(`https://api.github.com/repos/${repository}/commits/v${input.version}`, fetcher, MAX_INDEX_BYTES)).toString("utf8"))
  const source = commit.parse(resolved.sha)
  const index = validateReleaseIndex(parsed, { version: input.version, commit: source })
  const verified = { index, file, installerURL: `https://raw.githubusercontent.com/${repository}/${index.commit}/${index.installer.path}`,
    installerSHA256: index.installer.sha256,
    windowsInstallerURL: `https://raw.githubusercontent.com/${repository}/${index.commit}/${index.windowsInstaller.path}`,
    windowsInstallerSHA256: index.windowsInstaller.sha256,
    checksums: Object.fromEntries(index.assets.map((asset) => [asset.name, asset.sha256])),
  }
  await writeFile(path.join(operation, "verified.json"), JSON.stringify({ version: index.version, commit: index.commit, indexSHA256: checksum(bytes), verifiedAt: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" })
  return verified
}

export function verifyInstallerBytes(bytes: Uint8Array, expectedSHA256: string) {
  if (checksum(bytes) !== sha256.parse(expectedSHA256)) throw new Error("Pinned installer checksum does not match the verified release index.")
}
