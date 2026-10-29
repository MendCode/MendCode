/**
 * Plain MAJOR.MINOR.PATCH versions (an optional leading "v" is allowed).
 * Anything else, including pre-release tags, throws TypeError.
 */
export type Version = readonly [major: number, minor: number, patch: number]

export function parseVersion(text: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (!match) throw new TypeError(`not a MAJOR.MINOR.PATCH version: ${text}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** -1 when a is older than b, 0 when equal, 1 when newer. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a).join(".")
  const right = parseVersion(b).join(".")
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}

/** The newest version of a non-empty list, in the form it was written. */
export function latest(versions: readonly string[]): string {
  if (versions.length === 0) throw new RangeError("no versions")
  return versions.reduce((best, version) => (isNewer(version, best) ? version : best))
}
