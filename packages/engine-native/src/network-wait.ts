/**
 * Waiting out a lost connection: the backoff between attempts, telling network failures from others, noticing that the
 * machine slept (a closed lid) and probing whether the provider's host is reachable again.
 */

/** Waits between attempts: 0.5 s doubling up to 30 s, then 30 s for as long as it takes. */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/** `attempt` counts from 0. */
export function backoffMs(attempt: number) {
  return BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)]!
}

/** Codes Bun and Node use for a connection that could not open or dropped (DNS failure included). */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
])
const NETWORK_MESSAGE = /socket connection was closed|unable to connect|network connection was lost|fetch failed|socket hang up/i
const TLS_MESSAGE = /certificate|CERT|SSL|TLS/

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === "string") return code
  return errorCode((error as { cause?: unknown }).cause)
}

/** A failure of the connection itself (no answer from the provider), as opposed to an error the provider sent. */
export function isNetworkError(error: unknown) {
  const code = errorCode(error)
  if (code && NETWORK_CODES.has(code)) return true
  return error instanceof Error && NETWORK_MESSAGE.test(error.message)
}

/** Certificate and TLS failures never fix themselves by waiting. */
export function isTlsError(error: unknown) {
  const code = errorCode(error) ?? ""
  return TLS_MESSAGE.test(code) || (error instanceof Error && TLS_MESSAGE.test(error.message))
}

/** Usage-limit wording in a 429 body: the account is out of quota until its window resets, so waiting would not help. */
export function isQuotaBody(body: string) {
  return /usage_limit|insufficient_quota|usage limit|quota/i.test(body)
}

export type Clocks = {
  /** Wall clock (advances while the machine sleeps). */
  wall(): number
  /** Monotonic clock (on macOS and Linux it stops while the machine sleeps). */
  mono(): number
}

export const systemClocks: Clocks = { wall: () => Date.now(), mono: () => performance.now() }

export type WakeKind = "divergence" | "late-tick"

/**
 * Ticks every `intervalMs` and reports a wake: `divergence` when the wall clock ran ahead of the monotonic one (the
 * machine slept), `late-tick` when a tick fired far later than scheduled (the process was suspended or blocked).
 * Returns the function that stops it.
 */
export function watchForWake(input: { onWake(kind: WakeKind): void; intervalMs?: number; thresholdMs?: number; clocks?: Clocks }) {
  const { onWake, intervalMs = 1_000, thresholdMs = 3_000, clocks = systemClocks } = input
  let lastWall = clocks.wall()
  let lastMono = clocks.mono()
  const timer = setInterval(() => {
    const wall = clocks.wall()
    const mono = clocks.mono()
    const kind = wakeKind({ wallMs: wall - lastWall, monoMs: mono - lastMono, expectedMs: intervalMs, thresholdMs })
    lastWall = wall
    lastMono = mono
    if (kind) onWake(kind)
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function wakeKind(input: { wallMs: number; monoMs: number; expectedMs: number; thresholdMs: number }): WakeKind | undefined {
  if (input.wallMs - input.monoMs > input.thresholdMs) return "divergence"
  if (input.monoMs - input.expectedMs > input.thresholdMs) return "late-tick"
  return undefined
}

/** Any HTTP answer (even 403/404/405) proves the path to the host works; only a thrown request means offline. */
export async function probeUrl(input: { url: string; timeoutMs?: number; fetch?: (url: string, init: RequestInit) => Promise<Response> }) {
  const doFetch = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  try {
    await doFetch(input.url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(input.timeoutMs ?? 3_000) })
    return true
  } catch {
    return false
  }
}

export type WaitOutcome = "elapsed" | "online" | "cancelled"

/**
 * Sleeps `delayMs` in slices so a wake or a returning connection cuts the wait short. After a wake the attempt starts
 * at once when the host answers (or when there is no probe); during a long network wait the host is probed every
 * `probeEveryMs` too. A transient failure waits its full delay unless the machine slept.
 */
export async function waitToRetry(input: {
  delayMs: number
  kind: "network" | "transient"
  signal: AbortSignal
  sleep(ms: number, signal: AbortSignal): Promise<void>
  probe?: () => Promise<boolean>
  clocks?: Clocks
  sliceMs?: number
  wakeThresholdMs?: number
  probeEveryMs?: number
}): Promise<WaitOutcome> {
  const { delayMs, kind, signal, sleep, probe, clocks = systemClocks, sliceMs = 1_000, wakeThresholdMs = 3_000, probeEveryMs = 5_000 } = input
  const probes = kind === "network" && probe !== undefined && delayMs >= BACKOFF_MS.at(-1)!
  let remaining = delayMs
  let sinceProbe = 0
  while (remaining > 0) {
    if (signal.aborted) return "cancelled"
    const slice = Math.min(sliceMs, remaining)
    const wall = clocks.wall()
    const mono = clocks.mono()
    await sleep(slice, signal)
    if (signal.aborted) return "cancelled"
    remaining -= slice
    if (wakeKind({ wallMs: clocks.wall() - wall, monoMs: clocks.mono() - mono, expectedMs: slice, thresholdMs: wakeThresholdMs })) {
      if (!probe || (await probe())) return "online"
      continue
    }
    sinceProbe += slice
    if (probes && remaining > 0 && sinceProbe >= probeEveryMs) {
      sinceProbe = 0
      if (await probe!()) return "online"
    }
  }
  return signal.aborted ? "cancelled" : "elapsed"
}
