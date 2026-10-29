import { expectedSum, parseSums, verifyChecksum, sha256Hex } from "./checksum"
import { UpgradeError } from "./errors"
import { binPaths, installBinary, resolveDataDir, rollbackBinary } from "./install"
import { readRecovery, verifyRecovery, writeRecovery } from "./recovery"
import { validateReleaseIndex } from "./release-index"
import type { UpgradePorts } from "./ports"
import { channelOf, decide, type Channel, type Decision, type Platform, type ReleaseAsset, parseReleases, pickRelease, platformAsset } from "./releases"
import { CHECKSUMS_ASSET, GITHUB_API, MAX_BUNDLE_BYTES, MAX_DOWNLOAD_BYTES, PROVENANCE_ASSET, RELEASE_INDEX_ASSET, RELEASES_PER_PAGE, SIGSTORE_SUFFIX, UPGRADE_REPO, UPGRADE_REPO_ENV, UPGRADE_REPO_PLACEHOLDER } from "./settings"
import { readState, writeState } from "./state"

const REPO_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** The repository to read releases from: `MENDCODE_UPGRADE_REPO`, else `MendCode/MendCode` (the constant in settings.ts). */
export function resolveRepo(env: Record<string, string | undefined>) {
  const repo = env[UPGRADE_REPO_ENV]?.trim() || UPGRADE_REPO
  if (!repo || repo === UPGRADE_REPO_PLACEHOLDER) throw new UpgradeError("repo-not-configured", `no release repository is configured: set ${UPGRADE_REPO_ENV}=owner/name`)
  if (!REPO_SLUG.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new UpgradeError("bad-repo", `${UPGRADE_REPO_ENV} must look like owner/name, got "${repo}"`)
  return repo
}

export type UpgradeRequest = {
  /** The data directory exactly as the rest of the CLI resolves it (--dir, MENDCODE_V2_DIR, default). */
  dataDir: string
  home: string
  /** `owner/name`; not read for a rollback. */
  repo: string
  channel?: Channel
  target?: string
  method?: string
  beforeActivate?(): boolean | Promise<boolean>
  check: boolean
  force: boolean
  rollback: boolean
  /** Accepted for older scripts; installing after the SHA256 check alone when cosign is missing is now the default. */
  allowUnsigned?: boolean
  /** Refuse to install without a verified signature (cosign, or GitHub provenance on a release that has no cosign bundles). */
  requireSignature?: boolean
  /** The running version: `1.2.3`, `1.2.3-beta.4`, a `dev-<sha>` tag, or anything for a checkout. */
  currentVersion: string
  platform: Platform
}

export type Verification = "attestation" | "cosign" | "checksum-only"
export type UpgradeStatus = "up-to-date" | "ahead" | "update-available" | "installed" | "rolled-back"
export type UpgradeResult = {
  status: UpgradeStatus
  channel: Channel
  current: string
  /** Newest release of the channel. */
  latest: string | null
  /** True when an exact target or --force installed an older release. */
  downgrade: boolean
  installedTo: string | null
  asset: string | null
  rollbackAvailable?: boolean
  /** What vouched for the installed binary: GitHub provenance, the release's cosign signature, or only its SHA256 (`allowUnsigned`). */
  verification?: Verification
}

async function remote<T>(step: string, run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof UpgradeError) throw error
    throw new UpgradeError("network", `${step}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const STATUS_OF: Record<Decision, UpgradeStatus> = { update: "update-available", "up-to-date": "up-to-date", ahead: "ahead" }

/**
 * `upgrade` without a terminal: reads releases, verifies the binary against SHA256SUMS and installs it
 * under `<dataDir>/bin`. `check` writes nothing; every write stays inside the data directory.
 */
export async function runUpgrade(request: UpgradeRequest, ports: UpgradePorts): Promise<UpgradeResult> {
  if (request.method && !["direct", "curl"].includes(request.method)) throw new UpgradeError("unsupported-method", `MendCode ${request.method} upgrades are not published; use --method direct`)
  const dataDir = resolveDataDir({ dataDir: request.dataDir, home: request.home })
  if (request.check) return performUpgrade(request, ports)
  const release = await ports.fs.lock(dataDir)
  try { return await performUpgrade(request, ports) } finally { await release() }
}

async function performUpgrade(request: UpgradeRequest, ports: UpgradePorts): Promise<UpgradeResult> {
  const { fs } = ports
  const dataDir = resolveDataDir({ dataDir: request.dataDir, home: request.home })
  const state = await readState({ fs, dataDir })
  const channel = request.channel ?? state.channel
  const base = { channel, current: request.currentVersion, latest: null, downgrade: false, installedTo: null, asset: null }

  if (request.rollback) {
    const recovery = await verifyRecovery(fs, dataDir)
    const installedTo = await rollbackBinary({ fs, dataDir })
    await writeRecovery(fs, dataDir, { current: recovery.previous!, previous: recovery.current })
    await writeState({ fs, dataDir, state: { channel: state.channel, lastCheckAt: state.lastCheckAt, lastVersion: null } })
    return { ...base, status: "rolled-back", installedTo }
  }

  if (!REPO_SLUG.test(request.repo)) throw new UpgradeError("bad-repo", `invalid repository "${request.repo}"`)
  const listUrl = `${GITHUB_API}/repos/${request.repo}/releases?per_page=${RELEASES_PER_PAGE}`
  const target = request.target && request.target !== "latest" ? request.target.startsWith("v") || request.target.startsWith("dev-") ? request.target : `v${request.target}` : undefined
  const json = await remote("cannot list releases", () => ports.fetchJson(target ? `${GITHUB_API}/repos/${request.repo}/releases/tags/${encodeURIComponent(target)}` : listUrl))
  const releases = parseReleases(target && !Array.isArray(json) ? [json] : json)
  const release = target ? releases.find((row) => row.tag === target && channelOf(row) !== undefined) : pickRelease(releases, channel)
  if (!release) throw new UpgradeError("no-release", `no ${channel} release found in ${request.repo}`)
  const selectedChannel = channelOf(release)!
  const assetName = platformAsset(request.platform, release.tag)
  const decision = decide({ current: request.currentVersion, release, channel: selectedChannel })
  const found = { ...base, channel: selectedChannel, latest: release.tag, asset: assetName }
  if (request.check) return { ...found, status: STATUS_OF[decision] }

  const save = (lastVersion: string | null) => writeState({ fs, dataDir, state: { channel, lastCheckAt: ports.now(), lastVersion } })
  if (decision !== "update" && !request.force && !(target && decision === "ahead")) {
    await save(state.lastVersion)
    return { ...found, status: STATUS_OF[decision] }
  }

  const binary = release.assets.find((asset) => asset.name === assetName)
  const sums = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET)
  if (!binary) throw new UpgradeError("asset-missing", `${release.tag} has no ${assetName} asset`)
  if (!sums) throw new UpgradeError("checksum-missing", `${release.tag} has no ${CHECKSUMS_ASSET} asset; refusing to install an unverified binary`)
  if (!ports.verifyProvenance) throw new UpgradeError("provenance", "release attestation verifier unavailable; install blocked")
  const fetchAsset = (asset: ReleaseAsset, limit: number, what: string) => remote(`cannot download ${what}`, () => ports.download(asset.url, limit, asset.apiUrl))
  // `release.yml` signs every release with keyless cosign bundles, which verify offline and without an account; GitHub also attests the
  // releases of a public repository, but checking that needs a signed-in `gh`, so it is only the path of a release without bundles.
  // Without cosign the install goes on after the SHA256 check and says so, unless the caller requires a signature.
  const bundled = release.assets.some((asset) => asset.name === `${CHECKSUMS_ASSET}${SIGSTORE_SUFFIX}`)
  const attested = !bundled && release.assets.some((asset) => asset.name === PROVENANCE_ASSET)
  let unsigned = false
  /** cosign mode: `bytes` must carry a bundle signed by the release workflow of this tag. */
  const verifySigned = async (name: string, bytes: Uint8Array, metadata: boolean) => {
    if (unsigned) return
    const bundleAsset = release.assets.find((asset) => asset.name === `${name}${SIGSTORE_SUFFIX}`)
    if (!bundleAsset) throw new UpgradeError("provenance", `${release.tag} has no ${name}${SIGSTORE_SUFFIX} signature bundle; install blocked`)
    const bundle = await fetchAsset(bundleAsset, MAX_BUNDLE_BYTES, `${name}${SIGSTORE_SUFFIX}`)
    try {
      await ports.verifyProvenance!({ bytes, bundle, repo: request.repo, tag: release.tag, platform: request.platform, metadata })
    } catch (error) {
      if (!(error instanceof UpgradeError && error.code === "verifier-missing")) throw error
      if (request.requireSignature) throw new UpgradeError("verifier-missing", `${error.message.replace("[UPGRADE]: ", "")}; install blocked by --require-signature`)
      unsigned = true
    }
  }
  // The digest is looked up before the large download, and verified before anything is written.
  const sumsBytes = await fetchAsset(sums, 8 * 1024 * 1024, CHECKSUMS_ASSET)
  if (!attested) await verifySigned(CHECKSUMS_ASSET, sumsBytes, true)
  const table = parseSums(new TextDecoder().decode(sumsBytes))
  const expected = expectedSum(table, assetName)
  const bytes = await fetchAsset(binary, MAX_DOWNLOAD_BYTES, assetName)
  verifyChecksum({ name: assetName, bytes, expected })
  const indexAsset = release.assets.find((asset) => asset.name === RELEASE_INDEX_ASSET)
  if (!indexAsset) throw new UpgradeError("provenance", "release index missing; use external recovery for legacy releases")
  const indexBytes = await fetchAsset(indexAsset, 512 * 1024, "release index")
  if (indexBytes.byteLength > 512 * 1024) throw new UpgradeError("provenance", "release index exceeds 512 KiB")
  // Attested releases attest the index itself; otherwise the signed SHA256SUMS vouches for its digest.
  if (attested) await ports.verifyProvenance({ bytes: indexBytes, repo: request.repo, tag: release.tag, platform: request.platform, metadata: true })
  else verifyChecksum({ name: RELEASE_INDEX_ASSET, bytes: indexBytes, expected: expectedSum(table, RELEASE_INDEX_ASSET) })
  const index = validateReleaseIndex(JSON.parse(new TextDecoder().decode(indexBytes)), { repo: request.repo, tag: release.tag, channel: selectedChannel, asset: assetName, sha256: expected, size: bytes.byteLength })
  if (attested) await ports.verifyProvenance({ bytes, repo: request.repo, tag: release.tag, platform: request.platform })
  else await verifySigned(assetName, bytes, false)
  const verification: Verification = attested ? "attestation" : unsigned ? "checksum-only" : "cosign"
  if (request.beforeActivate && !await request.beforeActivate()) throw new UpgradeError("busy", "automatic activation cancelled by current policy or active work")
  const previous = await readRecovery(fs, dataDir)
  const paths = binPaths(dataDir)
  const retained = previous && await fs.exists(paths.current) && sha256Hex(await fs.readBytes(paths.current)) === previous.current.sha256 ? previous.current : null
  const installedTo = await installBinary({ fs, dataDir, bytes })
  await writeRecovery(fs, dataDir, { current: { version: release.tag, sha256: expected, schema: index.schema }, previous: retained })
  await save(release.tag)
  const rollbackAvailable = !!retained && retained.schema.version === index.schema.version && retained.schema.fingerprint === index.schema.fingerprint
  return { ...found, status: "installed", installedTo, downgrade: decision === "ahead", rollbackAvailable, verification }
}
