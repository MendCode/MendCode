import { describe, expect, test } from "bun:test"
import { backlogOrder, backlogText, BacklogConfig, DEFAULT_BACKLOG, MAX_BACKLOG_CHECKS, headReviewOf, planBacklog, type BacklogDecision, type HeadStatus } from "../src/pr-review/backlog"
import { ReviewConfig } from "../src/pr-review/config"
import type { PrFacts } from "../src/pr-review/contracts"
import { eligible } from "../src/pr-review/eligibility"
import { reviewerMarker } from "../src/pr-review/publish"
import { reviewMarker } from "../src/pr-review/state"

const NOW = Date.parse("2026-10-31T12:00:00Z")
const DAY = 86_400_000
const headOf = (number: number) => number.toString(16).padStart(2, "0").repeat(20)
const pr = (number: number, extra: Partial<PrFacts> = {}): PrFacts => ({
  number, head: headOf(number), base: "b".repeat(40), baseRef: "main", headRef: `feature/${number}`, draft: false, labels: [], author: "ana", authorIsBot: false,
  fork: false, requested: [], assignees: [], updatedAt: new Date(NOW - number * 60_000).toISOString(), ...extra,
})
const takeAll = async (): Promise<BacklogDecision> => ({ ok: true, reviewers: ["global"] })
/** The repository's eligibility for a missed `opened` event, as service.ts's `decide` gives it. */
const byConfig = (raw: Record<string, unknown>) => async (facts: PrFacts): Promise<BacklogDecision> => {
  const verdict = eligible({ facts, config: ReviewConfig.parse(raw), trigger: "opened" })
  return verdict.ok ? { ok: true, reviewers: ["global"] } : verdict
}
/** A fake of the reviews on each PR, keyed by number: what `status` reads. */
const reviewsOn = (posted: Record<number, unknown[]>) => async (facts: PrFacts, reviewer: string): Promise<HeadStatus> =>
  headReviewOf({ reviews: posted[facts.number] ?? [], head: facts.head, reviewer, counts: (author) => author.bot || author.login === "mendcode-me" }) !== undefined ? "reviewed" : "unreviewed"
const mendcodeReview = (id: number, head: string, reviewer = "global", login = "mendcode-me") => ({ id, commit_id: head, state: "COMMENTED", body: `Review\n\n${reviewMarker(head)}\n${reviewerMarker({ reviewer, configKey: "k", key: `review-${id}` })}`, user: { login } })

describe("pr-review backlog: open PRs without a review when a watch starts", () => {
  test("the #23 incident: a PR opened while no watch ran is queued at the new watch's start, and once reviewed it is never queued again", async () => {
    // #20 was reviewed before the watch ended; #23 was opened during the outage.
    const posted: Record<number, unknown[]> = { 20: [mendcodeReview(1, headOf(20))] }
    const prs = [pr(20, { updatedAt: new Date(NOW - 3 * DAY).toISOString() }), pr(23, { updatedAt: new Date(NOW - 2 * 3_600_000).toISOString() })]
    const first = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: reviewsOn(posted) })
    expect(first.queued).toEqual([{ number: 23, head: headOf(23), reviewers: ["global"], reason: `backlog: head ${headOf(23).slice(0, 12)} has no review yet` }])
    expect(first.reviewed).toEqual([20])
    expect(first.skipped).toEqual([])
    expect(backlogText(first)).toBe("Queued 1 open PR without a review of the current head (#23). 1 already reviewed at the current head stays as it is.")
    // Its review is on the pull request now: the next catch-up (a daemon restart, a resume) leaves it as the baseline.
    posted[23] = [mendcodeReview(2, headOf(23))]
    const again = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW + DAY, decide: takeAll, status: reviewsOn(posted) })
    expect(again.queued).toEqual([])
    expect(again.reviewed.toSorted()).toEqual([20, 23])
    expect(backlogText(again)).toBe("2 already reviewed at the current head stay as they are.")
  })

  test("a head reviewed already stays the baseline, but a push after that review is a head without one", async () => {
    const posted: Record<number, unknown[]> = { 5: [mendcodeReview(9, "c".repeat(40))] }
    const plan = await planBacklog({ prs: [pr(5)], config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: reviewsOn(posted) })
    expect(plan.queued.map((pick) => pick.number)).toEqual([5])
    const reviewed = await planBacklog({ prs: [pr(5, { head: "c".repeat(40) })], config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: reviewsOn(posted) })
    expect(reviewed.queued).toEqual([])
    expect(reviewed.reviewed).toEqual([5])
  })

  test("a PR with an open job of its head is not queued twice and is said to have one", async () => {
    const plan = await planBacklog({ prs: [pr(4)], config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: async () => "queued" })
    expect(plan).toMatchObject({ queued: [], open: [4], reviewed: [] })
    expect(backlogText(plan)).toBe("#4 has a review job already.")
  })

  test("only the reviewers without a review of the head are queued; one whose reviews cannot be read is queued with that said", async () => {
    const decide = async (): Promise<BacklogDecision> => ({ ok: true, reviewers: ["global", "personal:ana", "global"] })
    const plan = await planBacklog({ prs: [pr(8)], config: DEFAULT_BACKLOG, now: NOW, decide, status: async (_facts, reviewer) => reviewer === "global" ? "reviewed" : "unknown" })
    expect(plan.queued).toHaveLength(1)
    expect(plan.queued[0]!.reviewers).toEqual(["personal:ana"])
    expect(plan.queued[0]!.reason).toContain("its reviews could not be read; the publisher checks again before posting")
  })

  test("newest updatedAt first, at most max_prs, and the rest named with the cap as the reason without being read", async () => {
    const prs = Array.from({ length: 14 }, (_, index) => pr(index + 1))
    const decided: number[] = []
    const plan = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW, decide: async (facts) => { decided.push(facts.number); return takeAll() }, status: async () => "unreviewed" })
    // pr(1) is the newest (updated a minute ago).
    expect(plan.queued.map((pick) => pick.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(plan.skipped).toEqual([11, 12, 13, 14].map((number) => ({ number, kind: "cap", reason: "cap: 10 newer PRs were queued first (backlog.max_prs)" })))
    expect(decided).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(backlogText(plan)).toContain("Not queued: #11 (cap: 10 newer PRs were queued first (backlog.max_prs)); #12")
    // Reviewed and filtered PRs do not take a place under the cap.
    const some = await planBacklog({ prs: prs.slice(0, 4), config: BacklogConfig.parse({ max_prs: 2 }), now: NOW, decide: async (facts) => facts.number === 1 ? { ok: false, reason: "label `wip` excluded" } : takeAll(), status: async (facts) => facts.number === 2 ? "reviewed" : "unreviewed" })
    expect(some.queued.map((pick) => pick.number)).toEqual([3, 4])
    expect(some.reviewed).toEqual([2])
    expect(some.skipped).toEqual([{ number: 1, kind: "filter", reason: "label `wip` excluded" }])
  })

  test("a PR last updated before the window is not queued, and the window is configurable", async () => {
    const old = pr(3, { updatedAt: new Date(NOW - 45 * DAY).toISOString() })
    const plan = await planBacklog({ prs: [pr(1), old], config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: async () => "unreviewed" })
    expect(plan.queued.map((pick) => pick.number)).toEqual([1])
    expect(plan.skipped).toEqual([{ number: 3, kind: "window", reason: "window: last updated 45 days ago, outside the 30-day backlog.window_days" }])
    const wide = await planBacklog({ prs: [pr(1), old], config: BacklogConfig.parse({ window_days: 60 }), now: NOW, decide: takeAll, status: async () => "unreviewed" })
    expect(wide.queued.map((pick) => pick.number)).toEqual([1, 3])
    // A PR the provider gave no time for is not taken as old: the cap still bounds it.
    expect(backlogOrder([pr(2, { updatedAt: undefined }), pr(9)]).map((facts) => facts.number)).toEqual([9, 2])
    const untimed = await planBacklog({ prs: [pr(2, { updatedAt: undefined })], config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: async () => "unreviewed" })
    expect(untimed.queued.map((pick) => pick.number)).toEqual([2])
  })

  test("max_prs 0 keeps today's baseline: nothing is read or queued, and nothing is said", async () => {
    let reads = 0
    const plan = await planBacklog({ prs: [pr(1), pr(2)], config: BacklogConfig.parse({ max_prs: 0 }), now: NOW, decide: async () => { reads++; return takeAll() }, status: async () => { reads++; return "unreviewed" } })
    expect(plan).toEqual({ off: true, queued: [], reviewed: [], open: [], skipped: [] })
    expect(reads).toBe(0)
    expect(backlogText(plan)).toBe("")
  })

  test("drafts and the repository's filters keep a PR out, each with eligibility's reason, and nothing is read for it", async () => {
    let reads = 0
    const prs = [pr(1, { draft: true }), pr(2, { labels: ["wip"] }), pr(3, { author: "dependabot[bot]", authorIsBot: true }), pr(4)]
    const plan = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW, decide: byConfig({ filters: { labels: { exclude: ["wip"] } } }), status: async () => { reads++; return "unreviewed" } })
    expect(plan.queued.map((pick) => pick.number)).toEqual([4])
    expect(plan.skipped).toEqual([
      { number: 1, kind: "filter", reason: "draft: waits for ready for review" },
      { number: 2, kind: "filter", reason: "label `wip` excluded" },
      { number: 3, kind: "filter", reason: "author @dependabot[bot] is a bot (filters.authors.bots is off)" },
    ])
    expect(reads).toBe(1)
    // triggers.drafts on: a draft is reviewed like any other PR.
    const drafts = await planBacklog({ prs: [pr(1, { draft: true })], config: DEFAULT_BACKLOG, now: NOW, decide: byConfig({ triggers: { drafts: true } }), status: async () => "unreviewed" })
    expect(drafts.queued.map((pick) => pick.number)).toEqual([1])
    // on-request: a missed opened event is not a request, so nothing is queued by itself.
    const onRequest = await planBacklog({ prs: [pr(1)], config: DEFAULT_BACKLOG, now: NOW, decide: byConfig({ mode: "on-request" }), status: async () => "unreviewed" })
    expect(onRequest.skipped).toEqual([{ number: 1, kind: "filter", reason: "on-request: not requested" }])
  })

  test("personal routing: a PR no reviewer of this daemon takes, or a failing decision, is skipped with the reason", async () => {
    const decide = async (facts: PrFacts): Promise<BacklogDecision> => {
      if (facts.number === 1) return { ok: true, reviewers: [] }
      if (facts.number === 2) throw new Error("registry unreadable")
      return { ok: false, reason: "routed to personal:bob (area api), not to this daemon" }
    }
    const plan = await planBacklog({ prs: [pr(1), pr(2), pr(3)], config: DEFAULT_BACKLOG, now: NOW, decide, status: async () => "unreviewed" })
    expect(plan.queued).toEqual([])
    expect(plan.skipped).toEqual([
      { number: 1, kind: "filter", reason: "no reviewer of this daemon takes it" },
      { number: 2, kind: "filter", reason: "the platform could not decide: registry unreadable" },
      { number: 3, kind: "filter", reason: "routed to personal:bob (area api), not to this daemon" },
    ])
  })

  test("at most MAX_BACKLOG_CHECKS PRs are decided per catch-up, so a repository of filtered PRs costs a bounded number of reads", async () => {
    const prs = Array.from({ length: MAX_BACKLOG_CHECKS + 5 }, (_, index) => pr(index + 1))
    let decided = 0
    const plan = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW, decide: async () => { decided++; return { ok: false, reason: "labels: none of `review` is on the pull request" } }, status: async () => "unreviewed" })
    expect(decided).toBe(MAX_BACKLOG_CHECKS)
    expect(plan.skipped.filter((skip) => skip.kind === "unchecked").map((skip) => skip.number)).toEqual([51, 52, 53, 54, 55])
    expect(backlogText(plan)).toContain("; 45 more. /pr review N reviews one now.")
  })

  test("two daemons: the second one's catch-up finds the first one's review of the head and leaves the PR alone", async () => {
    const posted: Record<number, unknown[]> = {}
    const prs = [pr(23)]
    const first = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW, decide: takeAll, status: reviewsOn(posted) })
    expect(first.queued.map((pick) => pick.number)).toEqual([23])
    // The first daemon's review is posted (a bot app login here); the second daemon reads it before it queues anything.
    posted[23] = [mendcodeReview(77, headOf(23), "global", "mendcode[bot]")]
    posted[23][0] = { ...(posted[23][0] as object), user: { login: "mendcode[bot]", type: "Bot" } }
    const second = await planBacklog({ prs, config: DEFAULT_BACKLOG, now: NOW + 60_000, decide: takeAll, status: reviewsOn(posted) })
    expect(second.queued).toEqual([])
    expect(second.reviewed).toEqual([23])
  })
})

describe("pr-review backlog: which posted review counts for a reviewer and head", () => {
  const head = "d".repeat(40)
  const counts = (author: { login?: string | undefined; association?: string | undefined; bot: boolean }) => author.bot || author.association === "MEMBER" || author.login === "me"
  test("a MendCode review of the head by this reviewer counts; another reviewer's, another head's, a dismissed or a pending one does not", () => {
    expect(headReviewOf({ reviews: [mendcodeReview(1, head, "global", "me")], head, reviewer: "global", counts })).toBe(1)
    expect(headReviewOf({ reviews: [mendcodeReview(1, head, "personal:ana", "me")], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [mendcodeReview(1, "e".repeat(40), "global", "me")], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [{ ...mendcodeReview(3, head, "global", "me"), state: "DISMISSED" }], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [{ ...mendcodeReview(3, head, "global", "me"), state: "PENDING" }], head, reviewer: "global", counts })).toBeUndefined()
  })
  test("a review without a reviewer marker (a session's, by hand, or older) counts for any reviewer; the author must be one the publishers rule counts", () => {
    const old = { id: 4, commit_id: head, state: "COMMENTED", body: `Old review ${reviewMarker(head)}`, user: { login: "me" } }
    expect(headReviewOf({ reviews: [old], head, reviewer: "personal:ana", counts })).toBe(4)
    // What `headReviewedBy` answers `@mendcode review` with: this login's (or a counted publisher's) review of the head commit.
    expect(headReviewOf({ reviews: [{ id: 2, commit_id: head, state: "APPROVED", body: "LGTM", user: { login: "me" } }], head, reviewer: "global", counts })).toBe(2)
    expect(headReviewOf({ reviews: [{ id: 2, commit_id: "e".repeat(40), state: "APPROVED", body: "LGTM", user: { login: "me" } }], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [{ ...old, user: { login: "stranger" }, author_association: "NONE" }], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [{ ...old, user: { login: "maintainer" }, author_association: "MEMBER" }], head, reviewer: "global", counts })).toBe(4)
    // GitLab and Gitea posts carry no commit: the head marker alone names the head.
    expect(headReviewOf({ reviews: [{ ...old, commit_id: undefined }], head, reviewer: "global", counts })).toBe(4)
    expect(headReviewOf({ reviews: [null, "junk", { id: "x" }], head, reviewer: "global", counts })).toBeUndefined()
  })
  test("the empty COMMENTED review GitHub makes of a thread reply is not a review of the head", () => {
    const reply = { id: 6, commit_id: head, state: "COMMENTED", body: "", user: { login: "me" } }
    expect(headReviewOf({ reviews: [reply], head, reviewer: "global", counts })).toBeUndefined()
    expect(headReviewOf({ reviews: [reply, { ...reply, id: 7, body: "Fixed it." }], head, reviewer: "global", counts })).toBe(7)
  })
  test("the backlog config defaults to ten PRs within thirty days and refuses what is out of bounds", () => {
    expect(DEFAULT_BACKLOG).toEqual({ max_prs: 10, window_days: 30 })
    expect(BacklogConfig.safeParse({ max_prs: 51 }).success).toBe(false)
    expect(BacklogConfig.safeParse({ window_days: 0 }).success).toBe(false)
    expect(BacklogConfig.safeParse({ unknown: 1 }).success).toBe(false)
  })
})
