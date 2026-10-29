import { UpgradeError } from "./errors"
import { BINARY_PREFIX, type CHANNELS } from "./settings"

export type Channel = (typeof CHANNELS)[number]
/** `url` is the public download link; `apiUrl` the API endpoint that serves the same bytes to an authenticated client (private repositories). */
export type ReleaseAsset = { name: string; url: string; apiUrl?: string }
export type Release = { tag: string; prerelease: boolean; draft: boolean; publishedAt: number; assets: ReleaseAsset[] }
export type Semver = { major: number; minor: number; patch: number; beta: number | null; nightly?: number[] }
export type Decision = "update" | "up-to-date" | "ahead"
export type Platform = { os: string; arch: string }

const STABLE_TAG = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/
const BETA_TAG = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})-beta\.(\d{1,9})$/
const DEV_TAG = /^dev-[0-9a-f]{7,40}$/
const NIGHTLY_TAG = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})-nightly\.(\d{8})\.([1-9]\d{0,8})$/
const API_ASSET_URL = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/\d+$/
const OS_NAMES = ["darwin", "linux"]
const ARCH_NAMES = ["arm64", "x64"]

/** `1.2.3`, `v1.2.3` or `1.2.3-beta.4`; anything else (for example the checkout's `0.0.1-dev`) has no comparable version. */
export function parseVersion(text: string): Semver | undefined {
  const tag = text.startsWith("v") ? text : `v${text}`
  const stable = STABLE_TAG.exec(tag)
  if (stable) return { major: Number(stable[1]), minor: Number(stable[2]), patch: Number(stable[3]), beta: null }
  const beta = BETA_TAG.exec(tag)
  if (beta) return { major: Number(beta[1]), minor: Number(beta[2]), patch: Number(beta[3]), beta: Number(beta[4]) }
  const nightly = NIGHTLY_TAG.exec(tag)
  if (nightly) return { major: Number(nightly[1]), minor: Number(nightly[2]), patch: Number(nightly[3]), beta: null, nightly: [Number(nightly[4]), Number(nightly[5])] }
  return undefined
}

/** Semver order: a release is newer than its own betas; betas order by number. */
export function compareSemver(a: Semver, b: Semver) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.nightly || b.nightly) {
    if (!a.nightly) return a.beta === null ? 1 : -1
    if (!b.nightly) return b.beta === null ? -1 : 1
    return a.nightly[0]! - b.nightly[0]! || a.nightly[1]! - b.nightly[1]!
  }
  if (a.beta === b.beta) return 0
  if (a.beta === null) return 1
  if (b.beta === null) return -1
  return a.beta - b.beta
}

/** The channel a release belongs to, or undefined when it is a draft or its tag and prerelease flag disagree. */
export function channelOf(release: Release): Channel | undefined {
  if (release.draft) return undefined
  if (!release.prerelease && STABLE_TAG.test(release.tag)) return "stable"
  if (release.prerelease && BETA_TAG.test(release.tag)) return "beta"
  if (release.prerelease && DEV_TAG.test(release.tag)) return "dev"
  if (release.prerelease && NIGHTLY_TAG.test(release.tag)) return "nightly"
  return undefined
}

/** The newest release of a channel: stable and beta by semver, dev by publication time. */
export function pickRelease(releases: readonly Release[], channel: Channel): Release | undefined {
  const inChannel = releases.filter((release) => channelOf(release) === channel)
  const newest = (a: Release, b: Release) => {
    if (channel !== "dev") {
      const order = compareSemver(parseVersion(b.tag)!, parseVersion(a.tag)!)
      if (order !== 0) return order
    }
    return b.publishedAt - a.publishedAt
  }
  return [...inChannel].sort(newest)[0]
}

const sameDevBuild = (a: string, b: string) => DEV_TAG.test(a) && DEV_TAG.test(b) && (a.startsWith(b) || b.startsWith(a))

/**
 * Compares the running version with the newest release of the channel. Dev builds are identified by
 * their tag, not ordered; a running version that cannot be compared (a checkout) is offered the update.
 */
export function decide({ current, release, channel }: { current: string; release: Release; channel: Channel }): Decision {
  if (channel === "dev") return sameDevBuild(current, release.tag) ? "up-to-date" : "update"
  const running = parseVersion(current)
  if (!running) return "update"
  const order = compareSemver(parseVersion(release.tag)!, running)
  return order > 0 ? "update" : order === 0 ? "up-to-date" : "ahead"
}

/** Direct binary assets; the version is the tag without its leading `v`. */
export function platformAsset({ os, arch }: Platform, tag: string) {
  if (!OS_NAMES.includes(os) || !ARCH_NAMES.includes(arch)) throw new UpgradeError("unsupported-platform", `no release binary for ${os}-${arch} (built: ${OS_NAMES.join("|")} x ${ARCH_NAMES.join("|")})`)
  if (!STABLE_TAG.test(tag) && !BETA_TAG.test(tag) && !DEV_TAG.test(tag) && !NIGHTLY_TAG.test(tag)) throw new UpgradeError("bad-response", `unsupported release tag: ${tag}`)
  return `${BINARY_PREFIX}-${tag.replace(/^v/, "")}-${os}-${arch}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads the GitHub "list releases" response. Malformed entries are skipped, never trusted. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) throw new UpgradeError("bad-response", "the release list is not a JSON array")
  const releases: Release[] = []
  for (const entry of json) {
    if (!isRecord(entry) || typeof entry.tag_name !== "string") continue
    const published = typeof entry.published_at === "string" ? Date.parse(entry.published_at) : Number.NaN
    const assets: ReleaseAsset[] = []
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      if (isRecord(asset) && typeof asset.name === "string" && typeof asset.browser_download_url === "string" && asset.browser_download_url.startsWith("https://")) {
        const apiUrl = typeof asset.url === "string" && API_ASSET_URL.test(asset.url) ? asset.url : undefined
        assets.push({ name: asset.name, url: asset.browser_download_url, ...(apiUrl ? { apiUrl } : {}) })
      }
    }
    releases.push({ tag: entry.tag_name, prerelease: entry.prerelease === true, draft: entry.draft === true, publishedAt: Number.isFinite(published) ? published : 0, assets })
  }
  return releases
}
