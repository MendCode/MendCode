import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding, type PrReviewResult } from "@mendcode/protocol"
import type { EffectLedger } from "../src/pr-review/contracts"
import { createEffectLedger } from "../src/pr-review/effects"
import { findingId } from "../src/pr-review/findings"
import { failureOf, publishReview, reviewerFromBody, reviewerMarker, type GhCall } from "../src/pr-review/publish"
import { emptyState } from "../src/pr-review/state"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ledgerFile = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-review-effects-"))); temps.push(dir); return path.join(dir, "pr-review", "effects.json") }

const HEAD = "a".repeat(40)
const make = (summary: string, line = 3) => PrFinding.parse({ id: findingId({ path: "src/math.ts", line, category: "correctness", summary }), path: "src/math.ts", line, side: "RIGHT", severity: "major", category: "correctness", summary, detail: "d", evidence: ["src/math.ts:3"], verdict: "confirmed" })
const result = (findings: PrFinding[], head = HEAD): PrReviewResult => ({ head, base: "c".repeat(40), findings, dropped: 0, summary: "Changes the sum loop.", tokens: { input: 10, output: 1 }, budgetHit: false })

type PostMode = "ok" | "lost-answer" | "never-arrived" | "server-error-after" | "refused"
/**
 * A fake GitHub pull request: its reviews live in memory, `POST .../reviews` adds one (or not, by `mode`), `GET .../reviews` lists
 * them unless `unreadable`. Every call is recorded. No network.
 */
function fakeRemote(login = "mendcode-bot") {
  const reviews: Array<{ id: number; body: string; user: { login: string; type: string }; state: string; commit_id: string }> = []
  const calls: Array<{ argv: string[]; body: any }> = []
  const remote = { mode: "ok" as PostMode, unreadable: false, reviews, calls, posts: () => calls.filter((call) => call.argv.includes("POST")) }
  const gh: GhCall = async ({ argv, stdin }) => {
    const body = stdin ? JSON.parse(stdin) : undefined
    calls.push({ argv, body })
    const endpoint = argv[1]!
    if (endpoint.endsWith("/reviews") && argv.includes("POST")) {
      const mode = remote.mode
      if (mode === "refused") return { code: 1, out: "", err: "gh: Resource not accessible by integration (HTTP 403)" }
      if (mode === "never-arrived") return { code: 1, out: "", err: "" }
      const review = { id: 7000 + reviews.length, body: body.body, user: { login, type: "User" }, state: "COMMENTED", commit_id: body.commit_id }
      reviews.push(review)
      if (mode === "lost-answer") return { code: 143, out: "", err: "" }
      if (mode === "server-error-after") return { code: 1, out: "", err: "gh: HTTP 502: Bad Gateway" }
      return { code: 0, out: JSON.stringify({ id: review.id }) }
    }
    if (/\/pulls\/12\/reviews\?per_page=100/.test(endpoint)) return remote.unreadable ? { code: 1, out: "", err: "HTTP 502" } : { code: 0, out: JSON.stringify(reviews) }
    return { code: 0, out: "[]" }
  }
  return { ...remote, gh, set: (patch: Partial<Pick<typeof remote, "mode" | "unreadable">>) => Object.assign(remote, patch), get mode() { return remote.mode } }
}

const publish = (gh: GhCall, effects: EffectLedger | undefined, extra: Partial<Parameters<typeof publishReview>[0]> = {}) =>
  publishReview({ repo: "acme/app", number: 12, result: result([make("The loop skips the first value")]), previous: emptyState(), process: gh, reviewer: "global", configKey: "base@1234567", ...(effects ? { effects } : {}), ...extra })

describe("idempotent publishing", () => {
  test("the body carries the reviewer marker (reviewer, config version, effect hash) and the effect is recorded done with the review id", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    const done = await publish(remote.gh, effects, { reviewer: "personal:obed", configKey: "base@abc1234+profile@3", jobId: "job-1" })
    expect(done).toMatchObject({ posted: true, reviewId: 7000 })
    const body: string = remote.posts()[0]!.body.body
    const marker = reviewerFromBody(body)
    expect(marker).toMatchObject({ reviewer: "personal:obed", configKey: "base@abc1234+profile@3" })
    expect(marker!.effect).toMatch(/^[0-9a-f]{16}$/)
    expect(body).toContain(`<!-- mendcode:review head=${HEAD} -->`)
    expect(effects.ofJob("job-1")).toEqual([expect.objectContaining({ kind: "review", state: "done", remote: "7000", marker: expect.stringContaining(marker!.effect) })])
    expect(effects.pending()).toEqual([])
  })

  test("a key already done is not sent again, even when the caller lost the state that says so", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    await publish(remote.gh, effects)
    const again = await publish(remote.gh, effects)
    expect(remote.posts()).toHaveLength(1)
    expect(again).toMatchObject({ posted: false, duplicate: true, reviewId: 7000, reason: "already posted" })
    // The state converges: the finding counts as published, so the next run on this head is a no-op without the ledger too.
    expect(Object.keys(again.state.published)).toHaveLength(1)
    expect(again.state.lastHead).toBe(HEAD)
  })

  test("a crash after GitHub took the POST and before the ledger said done: the restarted daemon finds the marker and posts nothing", async () => {
    const remote = fakeRemote()
    const file = ledgerFile()
    const before = createEffectLedger({ file })
    // The process dies between GitHub's answer and recording it.
    const dying: EffectLedger = { ...before, done: () => { throw new Error("killed") } }
    await expect(publish(remote.gh, dying)).rejects.toThrow("killed")
    expect(remote.posts()).toHaveLength(1)
    const after = createEffectLedger({ file })
    expect(after.pending()).toHaveLength(1)
    const resumed = await publish(remote.gh, after)
    expect(remote.posts()).toHaveLength(1)
    expect(resumed).toMatchObject({ posted: false, duplicate: true, reviewId: 7000 })
    expect(resumed.reason).toContain("already posted")
    expect(after.pending()).toEqual([])
    // And once more after that: the ledger now says done, so not even a read is needed.
    const reads = remote.calls.length
    expect(await publish(remote.gh, after)).toMatchObject({ duplicate: true, reason: "already posted" })
    expect(remote.calls.slice(reads).filter((call) => call.argv[1]!.includes("/reviews?per_page"))).toHaveLength(0)
  })

  test("a timeout after GitHub applied the review is reconciled in the same call: posted once, never resent", async () => {
    for (const mode of ["lost-answer", "server-error-after"] as const) {
      const remote = fakeRemote()
      const effects = createEffectLedger({ file: ledgerFile() })
      remote.set({ mode })
      const done = await publish(remote.gh, effects)
      expect(remote.posts()).toHaveLength(1)
      expect(done).toMatchObject({ posted: true, reviewId: 7000, comments: 1 })
      expect(effects.pending()).toEqual([])
    }
  })

  test("a timeout before GitHub saw it is not resent in the same call; the next attempt checks the PR again and sends it once", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    remote.set({ mode: "never-arrived" })
    const first = await publish(remote.gh, effects)
    expect(first).toMatchObject({ posted: false, uncertain: true })
    expect(first.reason).toContain("is not on the pull request yet")
    expect(first.state).toEqual(emptyState())
    expect(effects.pending()).toHaveLength(1)
    remote.set({ mode: "ok" })
    const before = remote.calls.length
    const second = await publish(remote.gh, effects)
    expect(second).toMatchObject({ posted: true })
    expect(remote.posts()).toHaveLength(2)
    expect(remote.reviews).toHaveLength(1)
    // The second attempt read the reviews before its POST.
    const steps = remote.calls.slice(before).map((call) => call.argv.includes("POST") ? "post" : call.argv[1]!.includes("/reviews?per_page") ? "read" : "other").filter((step) => step !== "other")
    expect(steps).toEqual(["read", "post"])
  })

  test("when the reviews cannot be read after an uncertain POST, nothing is sent, now or on the next attempt, until they can", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    remote.set({ mode: "server-error-after", unreadable: true })
    const first = await publish(remote.gh, effects)
    expect(first).toMatchObject({ posted: false, uncertain: true })
    expect(first.reason).toContain("could not be read")
    remote.set({ mode: "ok" })
    const blind = await publish(remote.gh, effects)
    expect(blind).toMatchObject({ posted: false, uncertain: true })
    expect(remote.posts()).toHaveLength(1)
    remote.set({ unreadable: false })
    const seen = await publish(remote.gh, effects)
    expect(seen).toMatchObject({ posted: false, duplicate: true })
    expect(remote.posts()).toHaveLength(1)
    expect(remote.reviews).toHaveLength(1)
  })

  test("a clear refusal (403) posts nothing, abandons the effect, and a later attempt may send it", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    remote.set({ mode: "refused" })
    const refused = await publish(remote.gh, effects)
    expect(refused).toMatchObject({ posted: false })
    expect(refused.reason).toContain("Resource not accessible")
    expect(refused.uncertain).toBeUndefined()
    // No reconciliation read after a definite refusal.
    expect(remote.calls.filter((call) => call.argv[1]!.includes("/reviews?"))).toHaveLength(0)
    expect(effects.pending()).toEqual([])
    remote.set({ mode: "ok" })
    expect(await publish(remote.gh, effects)).toMatchObject({ posted: true })
  })

  test("another reviewer or config version is another effect; the same findings under the same identity are one", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    await publish(remote.gh, effects, { reviewer: "global", configKey: "base@1" })
    await publish(remote.gh, effects, { reviewer: "global", configKey: "base@1" })
    await publish(remote.gh, effects, { reviewer: "global", configKey: "base@2" })
    await publish(remote.gh, effects, { reviewer: "personal:ana", configKey: "base@1" })
    expect(remote.posts()).toHaveLength(3)
  })

  test("a marker in someone else's review does not count when the reviewer's own login is given", async () => {
    const remote = fakeRemote("mallory")
    const effects = createEffectLedger({ file: ledgerFile() })
    remote.set({ mode: "never-arrived" })
    await publish(remote.gh, effects, { self: "mendcode-bot" })
    // Mallory copies the marker of the pending effect into her own review.
    const marker = effects.pending()[0]!.marker!
    remote.reviews.push({ id: 1, body: `lgtm ${marker}`, user: { login: "mallory", type: "User" }, state: "COMMENTED", commit_id: HEAD })
    remote.set({ mode: "ok" })
    const done = await publish(remote.gh, effects, { self: "mendcode-bot" })
    expect(done.posted).toBe(true)
  })
})

describe("stale results", () => {
  test("a head that moved is never published: no POST, no effect, the previous state kept", async () => {
    const remote = fakeRemote()
    const effects = createEffectLedger({ file: ledgerFile() })
    const done = await publish(remote.gh, effects, { isCurrent: () => false })
    expect(done).toMatchObject({ posted: false, stale: true })
    expect(done.reason).toContain("the head moved")
    expect(done.state).toEqual(emptyState())
    expect(remote.posts()).toHaveLength(0)
    expect(effects.pending()).toEqual([])
    expect(await publish(remote.gh, effects, { isCurrent: async () => true })).toMatchObject({ posted: true })
  })

  test("a check that throws counts as stale, and a stale head resolves no threads either", async () => {
    const remote = fakeRemote()
    const fixed = make("fixed")
    const previous = { ...emptyState(), lastHead: "d".repeat(40), published: { [fixed.id]: { commentId: 1, finding: fixed } } }
    const done = await publishReview({ repo: "acme/app", number: 12, result: result([]), previous, process: remote.gh, resolve: [fixed.id], isCurrent: () => { throw new Error("git failed") } })
    expect(done).toMatchObject({ posted: false, stale: true, resolved: 0 })
    expect(remote.calls).toHaveLength(0)
  })
})

describe("failure classes", () => {
  test("422 and other 4xx are definite; 5xx, a killed gh, an empty error and a throw are uncertain; a missing gh is definite", () => {
    expect(failureOf({ code: 1, out: "", err: "gh: Validation Failed (HTTP 422)" })).toBe("unprocessable")
    expect(failureOf({ code: 1, out: "", err: "gh: Bad credentials (HTTP 401)" })).toBe("refused")
    expect(failureOf({ code: 1, out: "{\"message\":\"Not Found\",\"status\":\"404\"}", err: "" })).toBe("refused")
    expect(failureOf({ code: 1, out: "", err: "gh: HTTP 502: Bad Gateway" })).toBe("uncertain")
    expect(failureOf({ code: 143, out: "", err: "" })).toBe("uncertain")
    expect(failureOf({ code: -1, out: "", err: "socket hang up" })).toBe("uncertain")
    expect(failureOf({ code: 127, out: "", err: "Executable not found in $PATH: \"gh\"" })).toBe("refused")
    // gh killed for too much output after it may have sent the request: uncertain.
    expect(failureOf({ code: 127, out: "", err: "gh output is too large" })).toBe("uncertain")
  })

  test("marker values cannot close the HTML comment or break the pattern", () => {
    const marker = reviewerMarker({ reviewer: "personal:ana --> <script>", configKey: "a b", key: "k" })
    expect(marker.slice(4, -4)).not.toContain("-->")
    expect(marker.slice(4, -4)).not.toContain(">")
    expect(reviewerFromBody(`x\n${marker}`)).toMatchObject({ configKey: "a_b" })
  })
})
