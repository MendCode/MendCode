import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFacts } from "../src/pr-review/contracts"
import { deviceId, devicePath } from "../src/pr-review/device"
import { claimMarker, createOwnership, MAX_CLAIM_TTL_MS, ownershipPath, parseClaims, pendingFor, prClaimKey, resolveClaims, type Claim } from "../src/pr-review/ownership"
import { parseRegistry } from "../src/pr-review/registry"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dataDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "pr-review-ownership-")); temps.push(dir); return dir }
const clock = (start = 1_000_000) => { const state = { at: start }; return { now: () => state.at, advance: (ms: number) => { state.at += ms } } }

const MIN = 60_000

describe("device identity", () => {
  test("is created once, persisted 0600 in a 0700 dir, and the same after a restart", () => {
    const dir = dataDir()
    const first = deviceId(dir, { now: () => 5, hostname: () => "Obed's MacBook <Pro>" })
    expect(first).toMatchObject({ version: 1, label: "Obed-s-MacBook-Pro", createdAt: 5 })
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(deviceId(dir, { hostname: () => "other" })).toEqual(first)
    expect(statSync(devicePath(dir)).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(devicePath(dir))).mode & 0o777).toBe(0o700)
  })

  test("a damaged device file is replaced by a new identity", () => {
    const dir = dataDir()
    const first = deviceId(dir)
    writeFileSync(devicePath(dir), "{nope")
    const second = deviceId(dir)
    expect(second.id).not.toBe(first.id)
    expect(JSON.parse(readFileSync(devicePath(dir), "utf8")).id).toBe(second.id)
  })
})

describe("file-backed ownership", () => {
  test("two devices claiming the same key on one ownership file: exactly one owner, the other sees the holder", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const pc = createOwnership({ file, now: time.now })
    const vps = createOwnership({ file, now: time.now })
    const first = pc.claim("watch/o/r", "pc", 10 * MIN)
    const second = vps.claim("watch/o/r", "vps", 10 * MIN)
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, holder: first.ok ? first.lease : (undefined as never) })
    expect(vps.current("watch/o/r")?.owner).toBe("pc")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("the same owner claiming again (after a restart) keeps its fence and extends the lease", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const a = createOwnership({ file, now: time.now }).claim("k", "pc", MIN)
    time.advance(30_000)
    const b = createOwnership({ file, now: time.now }).claim("k", "pc", MIN)
    expect(a.ok && b.ok && b.lease.fence === a.lease.fence && b.lease.expiresAt === time.now() + MIN).toBe(true)
  })

  test("an expired lease is taken over with a higher fence and the old owner's fenced write is refused", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const pc = createOwnership({ file, now: time.now })
    const vps = createOwnership({ file, now: time.now })
    const old = pc.claim("job/1", "pc", MIN)
    if (!old.ok) throw new Error("claim")
    expect(pc.valid("job/1", old.lease.fence)).toBe(true)
    time.advance(MIN)
    expect(pc.valid("job/1", old.lease.fence)).toBe(false)
    const taken = vps.claim("job/1", "vps", MIN)
    if (!taken.ok) throw new Error("takeover")
    expect(taken.lease.fence).toBeGreaterThan(old.lease.fence)
    expect(pc.valid("job/1", old.lease.fence)).toBe(false)
    expect(vps.valid("job/1", taken.lease.fence)).toBe(true)
    expect(pc.renew(old.lease, MIN)).toEqual({ ok: false, reason: `[PR_REVIEW]: job/1 is now held by vps (fence ${taken.lease.fence})` })
    pc.release(old.lease)
    expect(vps.current("job/1")).toEqual(taken.lease)
  })

  test("renew extends a live lease; a lapsed one must be claimed again and gets a new fence", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const own = createOwnership({ file, now: time.now })
    const lease = own.claim("k", "pc", MIN)
    if (!lease.ok) throw new Error("claim")
    time.advance(MIN / 2)
    const renewed = own.renew(lease.lease, MIN)
    expect(renewed).toEqual({ ok: true, lease: { ...lease.lease, expiresAt: time.now() + MIN } })
    time.advance(2 * MIN)
    expect(own.renew(lease.lease, MIN)).toEqual({ ok: false, reason: "[PR_REVIEW]: the lease on k expired; claim it again" })
    const again = own.claim("k", "pc", MIN)
    expect(again.ok && again.lease.fence).toBe(lease.lease.fence + 1)
  })

  test("transfer hands the key over with fence + 1; the old fence is refused and a stale lease cannot be transferred", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const own = createOwnership({ file, now: time.now })
    const pc = own.claim("watch/o/r", "pc", MIN)
    if (!pc.ok) throw new Error("claim")
    const moved = own.transfer(pc.lease, "vps", 5 * MIN)
    expect(moved).toEqual({ key: "watch/o/r", owner: "vps", fence: pc.lease.fence + 1, acquiredAt: time.now(), expiresAt: time.now() + 5 * MIN })
    expect(own.valid("watch/o/r", pc.lease.fence)).toBe(false)
    expect(own.valid("watch/o/r", moved.fence)).toBe(true)
    expect(() => own.transfer(pc.lease, "laptop", MIN)).toThrow("[PR_REVIEW]: pc no longer holds watch/o/r with fence 1; nothing to transfer")
  })

  test("fences keep growing per key across release and restart", () => {
    const file = ownershipPath(dataDir())
    const time = clock()
    const first = createOwnership({ file, now: time.now }).claim("k", "pc", MIN)
    if (!first.ok) throw new Error("claim")
    createOwnership({ file, now: time.now }).release(first.lease)
    const second = createOwnership({ file, now: time.now }).claim("k", "vps", MIN)
    expect(second.ok && second.lease.fence).toBe(first.lease.fence + 1)
    const other = createOwnership({ file, now: time.now }).claim("other", "pc", MIN)
    expect(other.ok && other.lease.fence).toBe(1)
  })

  test("observe raises a key's fence to one seen on another device, so the next local claim is above it", () => {
    const own = createOwnership({ file: ownershipPath(dataDir()), now: clock().now })
    own.observe("pr/o/r/1/alice", 41)
    const lease = own.claim("pr/o/r/1/alice", "pc", MIN)
    expect(lease.ok && lease.lease.fence).toBe(42)
  })

  test("a damaged ownership file restarts fences above the clock, so a write fenced before the damage stays refused", () => {
    const file = ownershipPath(dataDir())
    const time = clock(5_000_000)
    const own = createOwnership({ file, now: time.now })
    const before = own.claim("k", "pc", MIN)
    if (!before.ok) throw new Error("claim")
    writeFileSync(file, "garbage")
    expect(own.valid("k", before.lease.fence)).toBe(false)
    const after = own.claim("k", "vps", MIN)
    expect(after.ok && after.lease.fence).toBeGreaterThan(5_000_000)
  })

  test("bad keys, owners and lease lengths are refused with typed errors", () => {
    const own = createOwnership({ file: ownershipPath(dataDir()) })
    expect(() => own.claim("", "pc", MIN)).toThrow(TypeError)
    expect(() => own.claim("k", "", MIN)).toThrow(TypeError)
    expect(() => own.claim("k", "pc", 0)).toThrow(RangeError)
    expect(() => own.claim("k", "pc", 8 * 24 * 60 * MIN)).toThrow(RangeError)
  })
})

describe("PR claims across devices", () => {
  const key = prClaimKey({ repo: "o/r", number: 12, reviewer: "backend" })

  test("a claim marker round-trips through parseClaims", () => {
    const lease = { key, owner: "dev-pc", fence: 3, acquiredAt: 1000, expiresAt: 1000 + 10 * MIN }
    const marker = claimMarker(lease, "backend")
    expect(marker).toBe(`<!-- mendcode:claim key=pr%2Fo%2Fr%2F12%2Fbackend reviewer=backend owner=dev-pc fence=3 acquired=1000 expires=${1000 + 10 * MIN} -->`)
    expect(parseClaims([`Working on it\n${marker}`])).toEqual([{ ...lease, reviewer: "backend", repo: "o/r", number: 12 }])
    expect(parseClaims([{ body: marker, author: "alice" }])[0]?.author).toBe("alice")
    expect(() => claimMarker({ ...lease, key: "watch/o/r" }, "backend")).toThrow(TypeError)
    expect(() => claimMarker(lease, "frontend")).toThrow(TypeError)
  })

  test("malformed, inconsistent or day-long-plus claims are skipped", () => {
    const good = claimMarker({ key, owner: "pc", fence: 1, acquiredAt: 0, expiresAt: MIN }, "backend")
    expect(parseClaims([
      good.replace("reviewer=backend", "reviewer=frontend"),
      good.replace("fence=1", "fence=-1"),
      good.replace(`expires=${MIN}`, `expires=${MAX_CLAIM_TTL_MS + 1}`),
      good.replace(`expires=${MIN}`, "expires=0"),
      "<!-- mendcode:claim key=%E0%A4%A reviewer=backend -->",
    ])).toEqual([])
  })

  test("partition: both devices claim the same PR on their own files, both post a marker, and every reader picks the same winner", () => {
    const time = clock()
    const pc = createOwnership({ file: ownershipPath(dataDir()), now: time.now })
    const vps = createOwnership({ file: ownershipPath(dataDir()), now: time.now })
    // No shared file: neither sees the other, so both get a lease. This is the case the module comment says is not prevented.
    const a = pc.claim(key, "dev-pc", 10 * MIN)
    time.advance(1000)
    const b = vps.claim(key, "dev-vps", 10 * MIN)
    if (!a.ok || !b.ok) throw new Error("claims")
    const comments = [claimMarker(a.lease, "backend"), claimMarker(b.lease, "backend")]
    const one = resolveClaims(parseClaims(comments), time.now()).get(key)
    const other = resolveClaims(parseClaims([...comments].reverse()), time.now()).get(key)
    expect(one).toEqual(other!)
    // Same fence (both first claims): the earlier acquiredAt wins.
    expect(one?.owner).toBe("dev-pc")
    // The loser learns the fence; its next claim beats the winner's once that one lapses.
    vps.observe(key, one!.fence)
    time.advance(10 * MIN)
    vps.release(b.lease)
    const retry = vps.claim(key, "dev-vps", 10 * MIN)
    expect(retry.ok && retry.lease.fence).toBeGreaterThan(one!.fence)
  })

  test("resolveClaims: expired claims never win; then highest fence, earliest acquiredAt, lowest owner id", () => {
    const base: Claim = { key, owner: "b", fence: 2, acquiredAt: 100, expiresAt: 10_000, reviewer: "backend", repo: "o/r", number: 12 }
    const expiredHigh = { ...base, owner: "z", fence: 9, expiresAt: 500 }
    expect(resolveClaims([expiredHigh, base], 1000).get(key)?.owner).toBe("b")
    expect(resolveClaims([base, { ...base, owner: "c", fence: 3 }], 1000).get(key)?.owner).toBe("c")
    expect(resolveClaims([base, { ...base, owner: "c", acquiredAt: 50 }], 1000).get(key)?.owner).toBe("c")
    expect(resolveClaims([{ ...base, owner: "c" }, base], 1000).get(key)?.owner).toBe("b")
    expect(resolveClaims([expiredHigh], 1000).size).toBe(0)
  })
})

describe("offline catch-up", () => {
  const registry = parseRegistry("reviewers:\n  - { id: global, scope: global }\n  - { id: backend, scope: personal, login: alice, areas: ['src/api/**'] }\n  - { id: frontend, scope: personal, login: bob, areas: ['web/**'] }\n").registry
  const backend = registry.reviewers.find((entry) => entry.id === "backend")!
  const pr = (number: number, patch: Partial<PrFacts> = {}): PrFacts => ({ number, head: `${number}`.padStart(40, "c"), base: "b".repeat(40), baseRef: "main", headRef: `f${number}`, draft: false, labels: [], author: "carol", authorIsBot: false, fork: false, requested: [], assignees: [], ...patch })
  const now = 50 * MIN

  test("after an offline period the personal reviewer finds its work from the provider's current state, not from missed events", () => {
    const prs = [
      pr(9, { requested: ["alice"] }),
      pr(3),
      pr(5, { assignees: ["Alice"] }),
      pr(4),
      pr(8, { requested: ["bob"] }),
      pr(6, { requested: ["alice"] }),
      pr(7, { requested: ["alice"] }),
    ]
    const files = (number: number) => number === 3 ? ["src/api/users.ts"] : number === 4 ? ["web/a.tsx"] : undefined
    const otherDevice = { key: prClaimKey({ repo: "o/r", number: 6, reviewer: "backend" }), owner: "dev-vps", fence: 4, acquiredAt: now - MIN, expiresAt: now + 10 * MIN }
    const ownDevice = { key: prClaimKey({ repo: "o/r", number: 7, reviewer: "backend" }), owner: "dev-pc", fence: 2, acquiredAt: now - MIN, expiresAt: now + 10 * MIN }
    const claims = parseClaims([claimMarker(otherDevice, "backend"), { body: claimMarker(ownDevice, "backend"), author: "alice" }])
    const pending = pendingFor({ reviewer: backend, prs, registry, files, claims, done: (number, head) => number === 9 && head === pr(9).head, repo: "o/r", device: "dev-pc", now })
    expect(pending).toEqual([
      { number: 3, head: pr(3).head, reason: `touches src/api/** (backend: @alice); head ${pr(3).head.slice(0, 7)} not reviewed yet` },
      { number: 5, head: pr(5).head, reason: `assigned to @alice; head ${pr(5).head.slice(0, 7)} not reviewed yet` },
      { number: 7, head: pr(7).head, reason: `review requested from @alice; head ${pr(7).head.slice(0, 7)} not reviewed yet; claimed by this device, resuming` },
    ])
  })

  test("an expired claim of another device no longer holds the PR back", () => {
    const claim = { key: prClaimKey({ repo: "o/r", number: 6, reviewer: "backend" }), owner: "dev-vps", fence: 4, acquiredAt: now - 20 * MIN, expiresAt: now - MIN }
    expect(pendingFor({ reviewer: backend, prs: [pr(6, { requested: ["alice"] })], registry, files: () => undefined, claims: parseClaims([claimMarker(claim, "backend")]), done: () => false, device: "dev-pc", now }).map((entry) => entry.number)).toEqual([6])
  })

  test("a forged claim written by someone other than the reviewer's login is ignored", () => {
    const forged = { key: prClaimKey({ repo: "o/r", number: 6, reviewer: "backend" }), owner: "evil", fence: 99, acquiredAt: now - MIN, expiresAt: now + 60 * MIN }
    expect(pendingFor({ reviewer: backend, prs: [pr(6, { requested: ["alice"] })], registry, files: () => undefined, claims: parseClaims([{ body: claimMarker(forged, "backend"), author: "mallory" }]), done: () => false, device: "dev-pc", now }).map((entry) => entry.number)).toEqual([6])
  })

  test("a reviewer pinned to another device, or one the registry does not list, has no work here", () => {
    const args = { prs: [pr(1, { requested: ["alice"] })], registry, files: () => undefined, claims: [], done: () => false, device: "dev-pc", now }
    expect(pendingFor({ ...args, reviewer: { ...backend, device: "dev-vps" } })).toEqual([])
    expect(pendingFor({ ...args, reviewer: { ...backend, device: "dev-pc" } }).map((entry) => entry.number)).toEqual([1])
    expect(pendingFor({ ...args, reviewer: { ...backend, id: "ghost" } })).toEqual([])
  })
})
