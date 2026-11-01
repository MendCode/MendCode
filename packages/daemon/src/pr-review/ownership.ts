import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Lease, Ownership, PrFacts, ReviewerEntry } from "./contracts"
import { route, type ReviewerRegistry } from "./registry"

/**
 * Who owns a watch, a job or a pull request across devices (decision 5 of the review platform plan, docs/pr-review.md).
 *
 * Local leases (`createOwnership`): a lease per key in `<dataDir>/pr-review/ownership.json` with a fencing number that only grows
 * per key and survives restarts. A write carries the fence it was started under and `valid(key, fence)` refuses it once the lease
 * expired, moved (`transfer`) or was taken by a newer claim. Every operation re-reads the file under a lock file, so two
 * processes sharing one data directory (or one file on a shared disk with working `O_EXCL`) get exactly one owner per key.
 *
 * Across devices there is no coordinator, so a PR-level claim is a hidden marker comment on the pull request (`claimMarker`) that
 * other devices read (`parseClaims`) and settle the same way (`resolveClaims`). This is NOT compare-and-swap: posting a comment
 * and reading the others' are separate steps, and a network partition (or two devices posting within one poll) lets both work
 * until each reads the other's claim. Then both resolve the same winner and the loser stops; the effects ledger and the publish
 * markers are what prevent a double post, not this. Claims are untrusted text: anyone can write a comment, so a claim counts only
 * for a reviewer the registry lists, written by that reviewer's login when the caller knows the author, and for at most a day.
 */

export const ownershipPath = (dataDir: string) => path.join(dataDir, "pr-review", "ownership.json")

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A claim marker longer than this is ignored, so a forged comment cannot block a PR for weeks. */
export const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000
/** Fences kept per key; past it the lowest-fenced idle keys are dropped and `floor` rises so a dropped key's fence never comes back. */
const MAX_KEYS = 5000
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 10_000

const Key = z.string().min(1).max(300)
const Owner = z.string().min(1).max(200)
const LeaseSchema = z.object({ key: Key, owner: Owner, fence: z.number().int().positive(), expiresAt: z.number().int(), acquiredAt: z.number().int() })
const OwnershipFile = z.object({
  version: z.literal(1),
  leases: z.record(z.string(), LeaseSchema),
  fences: z.record(z.string(), z.number().int().nonnegative()),
  /** Every key's next fence is above this (dropped keys, fences observed on other devices, a damaged file). */
  floor: z.number().int().nonnegative(),
})
type OwnershipFile = z.infer<typeof OwnershipFile>

export type FileOwnership = Ownership & {
  /** A fence seen elsewhere (another device's claim marker) for `key`: the next local claim of it is above it. */
  observe(key: string, fence: number): void
}

const checkTtl = (ttlMs: number) => { if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new RangeError(`[PR_REVIEW]: a lease lasts 1 ms to 7 days, not ${ttlMs}`) }
const checkKey = (key: string, owner?: string) => {
  if (!Key.safeParse(key).success) throw new TypeError("[PR_REVIEW]: a lease key is 1 to 300 characters")
  if (owner !== undefined && !Owner.safeParse(owner).success) throw new TypeError("[PR_REVIEW]: a lease owner is 1 to 200 characters")
}
const sameLease = (a: Lease | undefined, b: Lease) => !!a && a.key === b.key && a.owner === b.owner && a.fence === b.fence

/**
 * File-backed leases (the `Ownership` contract). `now` is injected for tests; the clock is this device's, so a lease means "until
 * this time here". Throws `TypeError`/`RangeError` for a bad key, owner or TTL, and `Error` when `transfer` is handed a lease that is
 * no longer current.
 */
export function createOwnership({ file, now = Date.now }: { file: string; now?: () => number }): FileOwnership {
  const lockFile = `${file}.lock`

  function lock(): () => void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const start = Date.now()
    for (;;) {
      try {
        const fd = openSync(lockFile, "wx", 0o600)
        closeSync(fd)
        return () => rmSync(lockFile, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        // A lock left by a process that died mid-write is taken over once it is clearly older than any write.
        try { if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) { rmSync(lockFile, { force: true }); continue } } catch { continue }
        if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`[PR_REVIEW]: ${lockFile} is held by another process`)
        Bun.sleepSync(5)
      }
    }
  }

  function load(): OwnershipFile {
    let text: string
    try { text = readFileSync(file, "utf8") } catch { return { version: 1, leases: {}, fences: {}, floor: 0 } }
    try {
      const parsed = OwnershipFile.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
    } catch {}
    // A damaged file lost its fences: restart them above the clock in ms, which no counter of this file can have reached, so a
    // write fenced before the damage stays refused.
    return { version: 1, leases: {}, fences: {}, floor: now() }
  }

  function save(state: OwnershipFile) {
    const keys = Object.keys(state.fences)
    if (keys.length > MAX_KEYS) {
      const idle = keys.filter((key) => !state.leases[key]).sort((a, b) => state.fences[a]! - state.fences[b]!)
      for (const key of idle.slice(0, keys.length - MAX_KEYS)) {
        state.floor = Math.max(state.floor, state.fences[key]!)
        delete state.fences[key]
      }
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
  }

  /** Runs `change` on the current file under the lock, dropping expired leases (their fences stay), and saves when asked. */
  function update<T>(change: (state: OwnershipFile, at: number) => { result: T; write: boolean }): T {
    const unlock = lock()
    try {
      const state = load()
      const at = now()
      let expired = false
      for (const [key, lease] of Object.entries(state.leases)) if (lease.expiresAt <= at) { delete state.leases[key]; expired = true }
      const { result, write } = change(state, at)
      if (write || expired) save(state)
      return result
    } finally { unlock() }
  }

  const nextFence = (state: OwnershipFile, key: string) => {
    const fence = Math.max(state.fences[key] ?? 0, state.floor) + 1
    state.fences[key] = fence
    return fence
  }

  return {
    claim(key, owner, ttlMs) {
      checkKey(key, owner)
      checkTtl(ttlMs)
      return update<ReturnType<Ownership["claim"]>>((state, at) => {
        const held = state.leases[key]
        if (held && held.owner !== owner) return { result: { ok: false as const, holder: held }, write: false }
        // The same owner claiming its live lease again (after a restart) keeps its fence; a lapsed one gets a new fence.
        const lease: Lease = held ? { ...held, expiresAt: at + ttlMs } : { key, owner, fence: nextFence(state, key), expiresAt: at + ttlMs, acquiredAt: at }
        state.leases[key] = lease
        return { result: { ok: true as const, lease }, write: true }
      })
    },
    renew(lease, ttlMs) {
      checkTtl(ttlMs)
      return update<ReturnType<Ownership["renew"]>>((state, at) => {
        const held = state.leases[lease.key]
        if (!sameLease(held, lease)) return { result: { ok: false as const, reason: held ? `[PR_REVIEW]: ${lease.key} is now held by ${held.owner} (fence ${held.fence})` : `[PR_REVIEW]: the lease on ${lease.key} expired; claim it again` }, write: false }
        const renewed: Lease = { ...held!, expiresAt: at + ttlMs }
        state.leases[lease.key] = renewed
        return { result: { ok: true as const, lease: renewed }, write: true }
      })
    },
    release(lease) {
      update((state) => {
        if (!sameLease(state.leases[lease.key], lease)) return { result: undefined, write: false }
        delete state.leases[lease.key]
        return { result: undefined, write: true }
      })
    },
    transfer(lease, to, ttlMs) {
      checkKey(lease.key, to)
      checkTtl(ttlMs)
      return update((state, at) => {
        if (!sameLease(state.leases[lease.key], lease)) throw new Error(`[PR_REVIEW]: ${lease.owner} no longer holds ${lease.key} with fence ${lease.fence}; nothing to transfer`)
        const moved: Lease = { key: lease.key, owner: to, fence: nextFence(state, lease.key), expiresAt: at + ttlMs, acquiredAt: at }
        state.leases[lease.key] = moved
        return { result: moved, write: true }
      })
    },
    current(key) {
      return update((state) => ({ result: state.leases[key], write: false }))
    },
    valid(key, fence) {
      return update((state) => ({ result: state.leases[key]?.fence === fence, write: false }))
    },
    observe(key, fence) {
      checkKey(key)
      if (!Number.isSafeInteger(fence) || fence <= 0) return
      update((state) => {
        if ((state.fences[key] ?? 0) >= fence) return { result: undefined, write: false }
        state.fences[key] = fence
        return { result: undefined, write: true }
      })
    },
  }
}

// ── PR-level claims across devices ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A lease announced on a pull request: `owner` is the device id, `reviewer` the registry id it works as. `covers`: the personal
 * reviewers (claim ids) a global reviewer stands in for under `routing.offline_fallback`, so they see it when they come back.
 */
export type Claim = Lease & { reviewer: string; repo: string; number: number; author?: string | undefined; covers?: string[] | undefined }

const ReviewerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,5}$/

/** The lease key of one reviewer's work on one pull request; the same on every device, so their claims compare. */
export const prClaimKey = ({ repo, number, reviewer }: { repo: string; number: number; reviewer: string }) => {
  if (!RepoPattern.test(repo) || !Number.isSafeInteger(number) || number <= 0 || !ReviewerIdPattern.test(reviewer)) throw new TypeError("[PR_REVIEW]: a claim key needs owner/repo, a PR number and a reviewer id")
  return `pr/${repo}/${number}/${reviewer}`
}
const parsePrClaimKey = (key: string) => {
  const match = /^pr\/(.+)\/(\d{1,12})\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(key)
  if (!match || !RepoPattern.test(match[1]!)) return undefined
  return { repo: match[1]!, number: Number(match[2]), reviewer: match[3]! }
}

const CLAIM_MARKER = /<!-- mendcode:claim ([^<>]{1,1200}) -->/g
const ClaimFields = z.object({
  key: z.string().min(1).max(300),
  reviewer: z.string().regex(ReviewerIdPattern),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  fence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  acquired: z.coerce.number().int().nonnegative(),
  expires: z.coerce.number().int().nonnegative(),
  /** Comma-separated claim ids (a reader before this field ignores it). */
  covers: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}(,[a-z0-9][a-z0-9._-]{0,63}){0,9}$/).optional(),
})

/**
 * The hidden comment that announces `lease` (keyed by `prClaimKey`) for `reviewer` on a pull request. Values are URI-encoded, so
 * nothing in them can close the HTML comment. The lease's owner must be a device id (`device.ts`), which is not a secret.
 */
export function claimMarker(lease: Lease, reviewer: string, covers: readonly string[] = []): string {
  const parsed = parsePrClaimKey(lease.key)
  if (!parsed || parsed.reviewer !== reviewer) throw new TypeError(`[PR_REVIEW]: ${lease.key} is not a claim key of reviewer ${reviewer} (prClaimKey)`)
  const fields = ClaimFields.parse({ key: lease.key, reviewer, owner: lease.owner, fence: lease.fence, acquired: lease.acquiredAt, expires: lease.expiresAt, ...(covers.length ? { covers: [...new Set(covers)].join(",") } : {}) })
  return `<!-- mendcode:claim ${Object.entries(fields).map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join(" ")} -->`
}

/**
 * Every well-formed claim in the comments of a pull request. A comment may be given with its author's login, which `pendingFor`
 * checks against the reviewer's; a malformed or inconsistent marker (a key of another reviewer, a claim longer than a day) is skipped.
 */
export function parseClaims(comments: ReadonlyArray<string | { body: string; author?: string | undefined }>): Claim[] {
  const claims: Claim[] = []
  for (const comment of comments) {
    const body = typeof comment === "string" ? comment : comment.body
    const author = typeof comment === "string" ? undefined : comment.author
    for (const match of body.matchAll(CLAIM_MARKER)) {
      const raw: Record<string, string> = {}
      for (const pair of match[1]!.trim().split(/\s+/)) {
        const at = pair.indexOf("=")
        if (at <= 0) continue
        try { raw[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1)) } catch {}
      }
      const fields = ClaimFields.safeParse(raw)
      if (!fields.success) continue
      const key = parsePrClaimKey(fields.data.key)
      const { expires, acquired } = fields.data
      if (!key || key.reviewer !== fields.data.reviewer || expires <= acquired || expires - acquired > MAX_CLAIM_TTL_MS) continue
      claims.push({ key: fields.data.key, owner: fields.data.owner, fence: fields.data.fence, acquiredAt: acquired, expiresAt: expires, reviewer: key.reviewer, repo: key.repo, number: key.number, ...(author ? { author } : {}), ...(fields.data.covers ? { covers: fields.data.covers.split(",") } : {}) })
    }
  }
  return claims
}

/** Total order of rival claims: the highest fence, then the earliest `acquiredAt`, then the lowest owner id. */
const beats = (a: Claim, b: Claim) => a.fence !== b.fence ? a.fence > b.fence : a.acquiredAt !== b.acquiredAt ? a.acquiredAt < b.acquiredAt : a.owner < b.owner

/**
 * The winning claim per key among those still valid at `now` (unexpired). Every device that read the same claims picks the same
 * winner, whatever order it read them in; a device that is not the winner stops working on that key. Settling after the fact is
 * all this does: it does not stop two devices from both starting before they read each other's claim (see the module comment).
 */
export function resolveClaims(claims: readonly Claim[], now: number): Map<string, Claim> {
  const winners = new Map<string, Claim>()
  for (const claim of claims) {
    if (claim.expiresAt <= now) continue
    const best = winners.get(claim.key)
    if (!best || beats(claim, best)) winners.set(claim.key, claim)
  }
  return winners
}

// ── Offline catch-up ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type PendingWork = { number: number; head: string; reason: string }

/**
 * What `reviewer` has to do when its daemon comes back, derived from the provider's current state (the open PRs, their requested
 * reviewers, assignees, labels and changed files) and not from events it missed while offline; offline is not failure, so nothing
 * here is an error. A PR is pending when `route` assigns it to the reviewer, `done(number, head)` says that head was not reviewed
 * yet, and no other device holds a valid claim of it. `files(n)` gives a PR's changed files when the caller listed them (else
 * `PrFacts.files`); a PR without either cannot match an area glob, so the caller lists files for the PRs it wants routed by area.
 * Eligibility (drafts, filters, the repo's `mode`) stays the caller's. With `device`, a reviewer pinned to another device has no
 * work here and this device's own claims are resumed; a claim whose known author is not the reviewer's login is ignored.
 */
export function pendingFor({ reviewer, prs, registry, files, claims, done, repo, device, now = Date.now() }: {
  reviewer: ReviewerEntry
  prs: readonly PrFacts[]
  registry: ReviewerRegistry
  files: (number: number) => string[] | undefined
  claims: readonly Claim[]
  done: (number: number, head: string) => boolean
  /** `owner/repo`: when set, claims of other repositories are ignored. */
  repo?: string | undefined
  device?: string | undefined
  now?: number | undefined
}): PendingWork[] {
  if (device !== undefined && reviewer.device !== undefined && reviewer.device !== device) return []
  if (!registry.reviewers.some((entry) => entry.id === reviewer.id)) return []
  const trusted = claims.filter((claim) => claim.reviewer === reviewer.id && (repo === undefined || claim.repo === repo) && (!claim.author || !reviewer.login || claim.author.toLowerCase() === reviewer.login.toLowerCase()))
  const winners = resolveClaims(trusted, now)
  const pending: PendingWork[] = []
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const assignment = route({ facts: pr, files: files(pr.number) ?? pr.files ?? [], registry }).find((entry) => entry.reviewer === reviewer.id)
    if (!assignment || done(pr.number, pr.head)) continue
    const claim = [...winners.values()].find((entry) => entry.number === pr.number)
    if (claim && claim.owner !== device) continue
    pending.push({ number: pr.number, head: pr.head, reason: `${assignment.reason}; head ${pr.head.slice(0, 7)} not reviewed yet${claim ? "; claimed by this device, resuming" : ""}` })
  }
  return pending
}
