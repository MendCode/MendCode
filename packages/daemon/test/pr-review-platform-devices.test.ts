import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFacts } from "../src/pr-review/contracts"
import { deviceId } from "../src/pr-review/device"
import { claimMarker, createOwnership, ownershipPath, parseClaims, pendingFor, prClaimKey, resolveClaims } from "../src/pr-review/ownership"
import { parseRegistry, route, runsHere } from "../src/pr-review/registry"

/**
 * Platform scenarios across devices (docs/pr-review.md, "Reviewers, routing and devices"): one owner per key with fencing, an
 * explicit transfer, PR claims settled the same way on every device, and a personal reviewer whose machine was off finding its
 * work from the provider's state when it comes back. Temp data directories only; no network.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-platform-devices-"))); temps.push(dir); return dir }

const MINUTE = 60_000
const pr = (number: number, extra: Partial<PrFacts> = {}): PrFacts => ({
  number, head: String(number).repeat(40).slice(0, 40), base: "b".repeat(40), baseRef: "main", headRef: `feature-${number}`, draft: false, labels: [],
  author: "carol", authorIsBot: false, fork: false, requested: [], assignees: [], ...extra,
})

const REGISTRY = `
reviewers:
  - id: team
    scope: global
  - id: alice-backend
    scope: personal
    login: alice
    areas: ["src/api/**"]
    capabilities: [review, fix]
    device: pc-alice
`

describe("platform devices: one owner per key", () => {
  test("two daemons on one ownership file: the second is refused while the lease lives, takes over after it expires with a higher fence, and the first one's late write is refused", () => {
    const dir = temp()
    let clock = 1_000_000
    const laptop = createOwnership({ file: ownershipPath(dir), now: () => clock })
    const vps = createOwnership({ file: ownershipPath(dir), now: () => clock })
    const key = "watch/acme/app"
    const first = laptop.claim(key, "laptop", 5 * MINUTE)
    if (!first.ok) throw new Error("the first claim must win")
    const refused = vps.claim(key, "vps", 5 * MINUTE)
    expect(refused).toEqual({ ok: false, holder: first.lease })
    expect(statSync(ownershipPath(dir)).mode & 0o777).toBe(0o600)
    // The laptop sleeps past its lease (a network cut looks the same): the VPS takes over with a new fence.
    clock += 6 * MINUTE
    const taken = vps.claim(key, "vps", 5 * MINUTE)
    if (!taken.ok) throw new Error("an expired lease must be taken over")
    expect(taken.lease.fence).toBeGreaterThan(first.lease.fence)
    // The laptop wakes up and tries to finish its write under its old fence: refused, and it cannot renew either.
    expect(laptop.valid(key, first.lease.fence)).toBe(false)
    expect(laptop.renew(first.lease, 5 * MINUTE).ok).toBe(false)
    expect(vps.valid(key, taken.lease.fence)).toBe(true)
    // A restart of the VPS daemon (a new instance on the same file) keeps its live lease and fence.
    const restarted = createOwnership({ file: ownershipPath(dir), now: () => clock })
    const again = restarted.claim(key, "vps", 5 * MINUTE)
    expect(again.ok && again.lease.fence).toBe(taken.lease.fence)
  })
  test("an explicit transfer hands the key over with fence + 1, and the old owner's writes are refused from then on", () => {
    const dir = temp()
    const ownership = createOwnership({ file: ownershipPath(dir), now: () => 5_000 })
    const held = ownership.claim("job/1", "laptop", MINUTE)
    if (!held.ok) throw new Error("claim")
    const moved = ownership.transfer(held.lease, "vps", MINUTE)
    expect(moved).toMatchObject({ owner: "vps", fence: held.lease.fence + 1 })
    expect(ownership.valid("job/1", held.lease.fence)).toBe(false)
    expect(ownership.valid("job/1", moved.fence)).toBe(true)
    expect(() => ownership.transfer(held.lease, "laptop", MINUTE)).toThrow("no longer holds")
  })
  test("the device id persists across restarts and is not shared between two data directories", () => {
    const one = temp(), two = temp()
    const id = deviceId(one, { hostname: () => "alice's <laptop>" })
    expect(deviceId(one).id).toBe(id.id)
    expect(id.label).toBe("alice-s-laptop")
    expect(deviceId(two).id).not.toBe(id.id)
  })
})

describe("platform devices: PR claims without a coordinator", () => {
  test("two devices that both claimed during a partition settle on the same winner whatever order each read the claims in", () => {
    const key = prClaimKey({ repo: "acme/app", number: 7, reviewer: "team" })
    const laptop = claimMarker({ key, owner: "laptop", fence: 3, acquiredAt: 1_000, expiresAt: 1_000 + 30 * MINUTE }, "team")
    const vps = claimMarker({ key, owner: "vps", fence: 4, acquiredAt: 2_000, expiresAt: 2_000 + 30 * MINUTE }, "team")
    const seenByLaptop = resolveClaims(parseClaims([laptop, vps]), 5_000).get(key)
    const seenByVps = resolveClaims(parseClaims([vps, laptop]), 5_000).get(key)
    expect(seenByLaptop?.owner).toBe("vps")
    expect(seenByVps).toEqual(seenByLaptop!)
    // A marker that tries to close the HTML comment or claim for more than a day is not a claim.
    expect(parseClaims(["<!-- mendcode:claim key=pr%2Facme%2Fapp%2F7%2Fteam reviewer=team owner=x fence=9 acquired=0 expires=999999999999 -->"])).toEqual([])
  })
})

describe("platform devices: a personal reviewer that was offline", () => {
  const { registry, problems } = parseRegistry(REGISTRY)
  const alice = registry.reviewers.find((entry) => entry.id === "alice-backend")!
  const team = registry.reviewers.find((entry) => entry.id === "team")!
  test("routing is deterministic with a visible reason, and only the pinned device runs the personal reviewer", () => {
    expect(problems).toEqual([])
    const facts = pr(12, { requested: ["Alice"] })
    expect(route({ facts, files: ["src/api/users.ts"], registry })).toEqual([
      { reviewer: "team", scope: "global", reason: "the repository's global reviewer", areas: [] },
      { reviewer: "alice-backend", scope: "personal", reason: "review requested from @alice; touches src/api/** (alice-backend: @alice)", areas: ["src/api/**"] },
    ])
    expect(runsHere(alice, { device: "vps", login: "alice" })).toBe(false)
    expect(runsHere(alice, { device: "pc-alice", login: "alice" })).toBe(true)
    expect(runsHere(team, { device: "vps", login: "ci-bot" })).toBe(true)
  })
  test("when its machine comes back it finds the routed PRs from the provider's state, skips heads already reviewed and PRs another device claimed", () => {
    const prs = [pr(12, { requested: ["alice"] }), pr(13, { files: ["src/api/x.ts"] }), pr(14, { files: ["docs/readme.md"] }), pr(15, { assignees: ["alice"] })]
    const reviewed = new Set([`15:${pr(15).head}`])
    const done = (number: number, head: string) => reviewed.has(`${number}:${head}`)
    // On the VPS nothing is Alice's to do: her reviewer is pinned to her PC, so the work waits there instead of failing.
    expect(pendingFor({ reviewer: alice, prs, registry, files: () => undefined, claims: [], done, device: "vps", now: 10 })).toEqual([])
    const back = pendingFor({ reviewer: alice, prs, registry, files: () => undefined, claims: [], done, device: "pc-alice", now: 10 })
    expect(back.map((work) => work.number)).toEqual([12, 13])
    expect(back[0]!.reason).toContain("review requested from @alice")
    expect(back[0]!.reason).toContain("not reviewed yet")
    // A new head on PR 15 is work again; a valid claim by another device keeps PR 12 off this device's list.
    const moved = prs.map((facts) => facts.number === 15 ? { ...facts, head: "f".repeat(40) } : facts)
    const claim = parseClaims([{ body: claimMarker({ key: prClaimKey({ repo: "acme/app", number: 12, reviewer: "alice-backend" }), owner: "laptop-alice", fence: 2, acquiredAt: 5, expiresAt: 5 + MINUTE }, "alice-backend"), author: "alice" }])
    const later = pendingFor({ reviewer: alice, prs: moved, registry, files: () => undefined, claims: claim, done, repo: "acme/app", device: "pc-alice", now: 10 })
    expect(later.map((work) => work.number)).toEqual([13, 15])
    // The same claim written by someone else is untrusted text and ignored.
    const forged = parseClaims([{ body: claimMarker({ key: prClaimKey({ repo: "acme/app", number: 12, reviewer: "alice-backend" }), owner: "mallory-box", fence: 99, acquiredAt: 5, expiresAt: 5 + MINUTE }, "alice-backend"), author: "mallory" }])
    expect(pendingFor({ reviewer: alice, prs: moved, registry, files: () => undefined, claims: forged, done, repo: "acme/app", device: "pc-alice", now: 10 }).map((work) => work.number)).toEqual([12, 13, 15])
  })
  test("the shared registry refuses private data: a memory or notes key makes the file a problem and the implicit global reviewer is used", () => {
    const leaked = parseRegistry(`${REGISTRY}\n    memory: "alice prefers early returns"\n`)
    expect(leaked.source).toBe("default")
    expect(leaked.problems.join("\n")).toContain("memory")
    expect(leaked.registry.reviewers.map((entry) => entry.id)).toEqual(["global"])
  })
})
