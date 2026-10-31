import { z } from "zod"
import type { GhCall } from "./publish"
import { repoParts } from "./state"

/**
 * A login's permission on a repository, read from GitHub (docs/pr-review.md, "Permissions"; R06). Every write MendCode makes for
 * someone (a push of a fix, a change of configuration, a command that posts) is gated on the asker's real permission, read with
 * `GET repos/{repo}/collaborators/{login}/permission`, never on the PR's own text or on what the author association suggested.
 *
 * Reads are cached for `ttlMs` (10 minutes) because the watch asks often and the answer rarely changes; `fresh` skips the cache
 * and is what a caller passes right before a write, so a permission revoked a minute ago is seen before the push. An error of any
 * kind (gh missing or logged out, 403/404, a rate limit, an answer that does not parse) is `unknown`, which is never cached and
 * never allows a write. A login or repository that is not a valid name is `unknown` without a call, so nothing reaches the URL.
 */

export const PERMISSION_LEVELS = ["admin", "maintain", "write", "triage", "read", "none", "unknown"] as const
export type Permission = typeof PERMISSION_LEVELS[number]
/** The levels GitHub lets push to a branch of the repository. */
export const WRITE_LEVELS: ReadonlySet<Permission> = new Set(["admin", "maintain", "write"])
export const PERMISSION_TTL_MS = 600_000
const CACHE_LIMIT = 500

/** A user login or an app's `name[bot]`, as GitHub allows them. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
/**
 * GitHub's answer: `permission` is the legacy level (maintain reads as write, triage as read); `role_name` is the real role, or a
 * custom role's name, in which case the legacy level is what counts.
 */
const Answer = z.object({ permission: z.enum(["admin", "write", "read", "none"]), role_name: z.string().max(100).optional() })
const ROLES: ReadonlySet<string> = new Set(["admin", "maintain", "write", "triage", "read"])

export type Permissions = {
  /** The level of `login` on `repo`; `fresh` revalidates (always before a write). */
  permissionOf(repo: string, login: string, options?: { fresh?: boolean }): Promise<Permission>
  /** Whether `login` may push to `repo`: admin, maintain or write. Fresh unless the caller says otherwise; `unknown` is no. */
  mayWrite(repo: string, login: string, options?: { fresh?: boolean }): Promise<boolean>
  /** Drops cached answers: all of them, a repository's, or one login's on it. */
  forget(repo?: string, login?: string): void
}

/** The level an answer names: the fine-grained role when GitHub gives a built-in one, else the legacy level. */
export function levelOf(answer: unknown): Permission {
  const parsed = Answer.safeParse(answer)
  if (!parsed.success) return "unknown"
  const role = parsed.data.role_name?.toLowerCase()
  return role && ROLES.has(role) ? role as Permission : parsed.data.permission
}

const validRepo = (repo: string) => { try { repoParts(repo); return true } catch { return false } }
const keyOf = (repo: string, login: string) => `${repo.toLowerCase()}\u0000${login.toLowerCase()}`

export function createPermissions({ gh, now = Date.now, ttlMs = PERMISSION_TTL_MS }: { gh: GhCall; now?: () => number; ttlMs?: number }): Permissions {
  const cache = new Map<string, { level: Permission; at: number }>()
  /** One request per key at a time: concurrent asks share it instead of spending the rate limit twice. */
  const inFlight = new Map<string, Promise<Permission>>()
  /** Request order: an answer never replaces one from a request that started later (a fresh read beats an older cached one). */
  let seq = 0
  const answered = new Map<string, number>()

  async function read(repo: string, login: string): Promise<Permission> {
    const done = await gh({ argv: ["api", `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`] }).catch(() => undefined)
    if (!done || done.code !== 0) return "unknown"
    try { return levelOf(JSON.parse(done.out)) } catch { return "unknown" }
  }

  function remember(key: string, level: Permission, started: number) {
    if ((answered.get(key) ?? 0) > started) return
    answered.set(key, started)
    cache.delete(key)
    if (level !== "unknown") cache.set(key, { level, at: now() })
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    while (answered.size > CACHE_LIMIT * 2) answered.delete(answered.keys().next().value!)
  }

  async function permissionOf(repo: string, login: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Permission> {
    if (!validRepo(repo) || !LOGIN.test(login)) return "unknown"
    const key = keyOf(repo, login)
    const cached = cache.get(key)
    if (!fresh && cached && now() - cached.at < ttlMs) return cached.level
    // A fresh ask never joins a request that started before it: that one may predate the revocation the caller guards against.
    const running = fresh ? undefined : inFlight.get(key)
    if (running) return running
    const started = ++seq
    const request = read(repo, login).then((level) => { remember(key, level, started); return level }).finally(() => { if (inFlight.get(key) === request) inFlight.delete(key) })
    inFlight.set(key, request)
    return request
  }

  return {
    permissionOf,
    async mayWrite(repo, login, { fresh = true } = {}) { return WRITE_LEVELS.has(await permissionOf(repo, login, { fresh })) },
    forget(repo, login) {
      if (!repo) return cache.clear()
      if (login) return void cache.delete(keyOf(repo, login))
      const prefix = `${repo.toLowerCase()}\u0000`
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
    },
  }
}
