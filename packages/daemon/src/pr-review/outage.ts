/**
 * Transient outages versus permanent failures, and sleep (docs/pr-review.md, "Outages and sleep"). A laptop that sleeps with its
 * lid closed wakes in the dark without network every so often: before, the wall clock ran on through the sleep, so 15 minutes of
 * failed listings ended every watch and a job spent its five attempts in one night (seen live, ~4 h asleep). Here a failure is
 * classified by what the forge or the network said (`failureKind`), and time is counted awake: a gap the monotonic clock did not
 * see (the process was suspended) or far past the expected tick is sleep, not failing time (`elapsed`).
 */

/** A point in time on both clocks: the wall clock (`Date.now`) and, when the process has one, a monotonic clock that stops in sleep. */
export type ClockMark = { wall: number; mono?: number | undefined }
/** Wall time that runs this far ahead of the awake time is sleep (or a suspended process), not work. */
export const SLEEP_GAP_MS = 60_000

/** Both clocks now; `monotonic` absent (an injected wall clock in tests) leaves only the wall clock and the expected-gap check. */
export const clockMark = (now: () => number, monotonic?: (() => number) | undefined): ClockMark => ({ wall: now(), ...(monotonic ? { mono: monotonic() } : {}) })

/**
 * The wall time since `from` and how much of it the process was awake: the monotonic clock's share (it stops while the machine
 * sleeps), and never more than `expectedMs` when given (a tick that came hours after the one before was not hours of polling).
 * `slept`: the wall clock ran ahead of the awake time by more than `SLEEP_GAP_MS`.
 */
export function elapsed(from: ClockMark, to: ClockMark, expectedMs?: number): { wall: number; awake: number; slept: boolean } {
  const wall = Math.max(0, to.wall - from.wall)
  let awake = from.mono !== undefined && to.mono !== undefined ? Math.max(0, Math.min(wall, to.mono - from.mono)) : wall
  if (expectedMs !== undefined) awake = Math.min(awake, Math.max(0, expectedMs))
  return { wall, awake, slept: wall - awake > SLEEP_GAP_MS }
}

/** The network or the forge's servers, for now: no route, no DNS, a timeout, a 5xx, a rate limit. Never a reason to give up. */
const TRANSIENT = /error connecting|could not resolve host|no such host|dial tcp|network is unreachable|network is down|no route to host|connection (?:refused|reset|timed out|closed)|timed? ?out|timeout|tls handshake|unexpected eof|\bEOF\b|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|temporar(?:y|ily)|\bHTTP 5\d\d\b|bad gateway|service unavailable|gateway time|internal server error|rate limit|secondary rate|abuse detection|\bHTTP 429\b|too many requests/i
/** The repository is gone or this login lost it, or the checkout no longer points where the watch started: retrying cannot help. */
const PERMANENT = /\bHTTP 40[34]\b|\bHTTP 410\b|not found|could not resolve to a repository|repository (?:not found|was archived)|not a git repository|no git remotes|none of the git remotes|origin changed|adapter of this checkout is not available|resource not accessible|must have (?:admin|push|read) access/i

/**
 * What a failure says about the future. `transient`: the network or the forge's servers (wait and try again); `permanent`: the
 * repository is gone, access was revoked (a 403 that is not a rate limit) or the origin changed; `unknown`: neither said so.
 */
export function failureKind(reason: string): "transient" | "permanent" | "unknown" {
  if (TRANSIENT.test(reason)) return "transient"
  if (PERMANENT.test(reason)) return "permanent"
  return "unknown"
}

/** The gap between listings while they fail: one interval after the first failure, doubling, never more than this. */
export const OUTAGE_BACKOFF_CAP_MS = 15 * 60_000
/** Awake time of failed listings after which the session hears of the outage once (and, for a permanent error, the watch ends). */
export const OUTAGE_LIMIT_MS = 15 * 60_000

/** The gap before the next listing after `failures` failed ones in a row: `interval`, doubling, at most `OUTAGE_BACKOFF_CAP_MS`. */
export const outageGap = (failures: number, interval: number) => Math.max(interval, Math.min(OUTAGE_BACKOFF_CAP_MS, interval * 2 ** Math.max(0, Math.min(20, failures - 1))))
