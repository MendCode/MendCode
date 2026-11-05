import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { estimateTokens, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { classifyStop } from "../src/pr-review/budget"
import { buildReviewContext, CONTEXT_SHARE, gitRun, MAX_REVIEW_PARTS, parseUnifiedDiff, splitIntoParts, type GitRun } from "../src/pr-review/context"
import { DEFAULT_ENGINE_CONFIG, passShortfall, resumeReview, REVIEW_PASS_SHARE, reviewPullRequest, type ReviewEngineConfig, type ReviewSessionFactory } from "../src/pr-review/engine"
import { failureKind } from "../src/pr-review/outage"
import { DEFAULT_PHASE_PLAN, parsePartPhase, partPhase } from "../src/pr-review/phases"
import { attemptReview, reviewNotice, runPrReview } from "../src/pr-review/run"
import { createReviewSessions, isStalled, ReviewTurnStalled } from "../src/pr-review/sessions"
import { emptyState } from "../src/pr-review/state"

/**
 * Long review turns and large pull requests (the live incident: a large ML pull request's review was stopped by a fixed 15-minute
 * turn limit, the work before it was lost and the notice named no commit). A turn is stopped only when its child goes silent or
 * passes a generous cap; a stalled turn keeps what the job finished and is retried; a diff larger than one call is reviewed in
 * parts of whole files with one verify pass over every part's candidates. Fake children and temp git repositories only.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

// ── The turn watch (sessions.ts) ─────────────────────────────────────────────────────────────────────────────────────────

type Script = (emit: (event: Record<string, unknown>) => void) => Promise<void> | void

/** Review children whose turns follow `script`: it emits the child's events (as the daemon's observers would see them). */
function watched({ idleMs, capMs, script }: { idleMs: number; capMs: number; script: Script }) {
  const cancelled: string[] = []
  let next = 0
  const sessions = createReviewSessions({
    create: () => `ses_${++next}` as SessionId,
    submit: async (id) => {
      let seq = 0
      const emit = (event: Record<string, unknown>) => sessions.observe({ sessionId: id, seq: ++seq, at: Date.now(), turnId: "turn_1", ...event } as unknown as SessionEvent)
      void Promise.resolve().then(() => script(emit))
    },
    deny: () => {},
    cancel: async (id) => { cancelled.push(id) },
    remove: () => {},
    idleMs, capMs,
  })
  return { sessions, cancelled }
}
const answer = (emit: (event: Record<string, unknown>) => void, text = "{\"findings\": []}") => {
  emit({ type: "item.started", itemId: "itm_1", kind: "agent_message" })
  emit({ type: "item.completed", itemId: "itm_1", status: "ok", text })
  emit({ type: "turn.completed" })
}

describe("a review turn is stopped on silence, not on wall time", () => {
  test("a turn that keeps streaming for far longer than the idle window completes with its answer", async () => {
    const { sessions, cancelled } = watched({ idleMs: 60, capMs: 5_000, script: async (emit) => {
      for (let step = 0; step < 12; step++) { await Bun.sleep(25); emit({ type: "item.delta", itemId: "itm_1", delta: "…" }) }
      answer(emit)
    } })
    const child = await sessions.factory({ directory: "/x" })({ purpose: "review" })
    const started = performance.now()
    expect((await child.send("review")).text).toBe("{\"findings\": []}")
    expect(performance.now() - started).toBeGreaterThan(250)
    expect(cancelled).toEqual([])
  })

  test("a child silent for the idle window is cancelled and the turn fails as stalled: an error kind, not a quota and not a network outage", async () => {
    const { sessions, cancelled } = watched({ idleMs: 60, capMs: 5_000, script: (emit) => { emit({ type: "item.delta", itemId: "itm_1", delta: "thinking" }) } })
    const child = await sessions.factory({ directory: "/x" })({ purpose: "verify" })
    const error = await child.send("verify").catch((caught: unknown) => caught)
    expect(isStalled(error)).toBe(true)
    const stalled = error as ReviewTurnStalled
    expect({ kind: stalled.kind, stalled: stalled.stalled }).toEqual({ kind: "error", stalled: "idle" })
    expect(stalled.message).toStartWith("[PR_REVIEW]: the review turn stalled: no activity from the model for")
    expect(stalled.message).not.toMatch(/time(d)? ?out/i)
    expect(classifyStop(stalled.message).kind).toBe("error")
    // Each retry of a stall spends an attempt: a deterministic stall cannot be retried for a day as if the network were down.
    expect(failureKind(stalled.message)).toBe("unknown")
    expect(cancelled).toEqual(["ses_1"])
  })

  test("the hard cap stops a turn that is still streaming", async () => {
    let streaming = true
    const { sessions, cancelled } = watched({ idleMs: 60, capMs: 200, script: async (emit) => { while (streaming) { await Bun.sleep(20); emit({ type: "item.delta", itemId: "itm_1", delta: "." }) } } })
    const child = await sessions.factory({ directory: "/x" })({ purpose: "review" })
    const error = await child.send("review").catch((caught: unknown) => caught) as ReviewTurnStalled
    streaming = false
    expect(error).toBeInstanceOf(ReviewTurnStalled)
    expect(error.stalled).toBe("cap")
    expect(error.message).toContain("was still running at its")
    expect(cancelled).toEqual(["ses_1"])
  })

  test("a fix session waiting for the user's approval is not idle; the approval's answer resumes the idle watch", async () => {
    const { sessions, cancelled } = watched({ idleMs: 60, capMs: 5_000, script: async (emit) => {
      emit({ type: "server.request", requestId: "req_1" })
      await Bun.sleep(250)
      emit({ type: "item.delta", itemId: "itm_1", delta: "approved, editing" })
      await Bun.sleep(20)
      answer(emit, "fixed")
    } })
    const fix = await sessions.factory({ directory: "/x", editing: true })({ purpose: "review" })
    expect((await fix.send("fix it")).text).toBe("fixed")
    expect(cancelled).toEqual([])
  })

  test("the session's own waiting_approval report after the request keeps the wait; the answer ends it and a later silence stalls", async () => {
    // Seen live (e2e #16): the daemon reports `waiting_approval` right after the request, which ended the wait, so the fix was
    // stopped as stalled after 10 minutes of waiting for the user.
    const { sessions, cancelled } = watched({ idleMs: 60, capMs: 5_000, script: async (emit) => {
      emit({ type: "server.request", requestId: "req_1" })
      emit({ type: "foreground.state", state: "waiting_approval" })
      await Bun.sleep(250)
      emit({ type: "server.request.resolved", requestId: "req_1", resolution: "approved" })
      emit({ type: "foreground.state", state: "tool" })
      await Bun.sleep(20)
      answer(emit, "fixed")
    } })
    const fix = await sessions.factory({ directory: "/x", editing: true })({ purpose: "review" })
    expect((await fix.send("fix it")).text).toBe("fixed")
    expect(cancelled).toEqual([])

    const silent = watched({ idleMs: 60, capMs: 5_000, script: async (emit) => {
      emit({ type: "server.request", requestId: "req_1" })
      emit({ type: "foreground.state", state: "waiting_approval" })
      emit({ type: "server.request.resolved", requestId: "req_1", resolution: "approved" })
    } })
    const stalled = await silent.sessions.factory({ directory: "/x", editing: true })({ purpose: "review" })
    await expect(stalled.send("fix it")).rejects.toThrow("stalled")
    expect(silent.cancelled).toHaveLength(1)
  })
})

// ── Large diffs in parts (context.ts, engine.ts) ─────────────────────────────────────────────────────────────────────────

/** A unified diff that adds `files` new files of `lines` lines each (about 10 tokens a line). */
function largeDiff(files: number, lines: number): string {
  return Array.from({ length: files }, (_, index) => {
    const file = `ml/layer_${String(index).padStart(2, "0")}.py`
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, line) => `+weights_${index}[${line}] = compute(x, ${line})  # tensor`).join("\n")}\n`
  }).join("")
}
const gitWith = (diff: string): GitRun => async (args) => args[0] === "diff" ? { code: 0, out: diff } : { code: 1, out: "" }
const filesOf = (prompt: string) => [...prompt.slice(prompt.indexOf("Diff:")).matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]!)
const idsOf = (prompt: string) => [...prompt.matchAll(/"id":"([0-9a-f]{40})"/g)].map((match) => match[1]!)

/**
 * A scripted engine for a diff in parts: each review child reports one finding on line 1 of every file its part's diff shows (and
 * a walkthrough), each verify child confirms every id it is asked about. `stallAt`: the review call (1-based) that stalls.
 */
function partsEngine({ stallAt, tokens = { input: 1_000, output: 100 } }: { stallAt?: number; tokens?: { input: number; output: number } } = {}) {
  const reviewed: string[][] = []
  const verified: string[] = []
  let reviews = 0
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      if (purpose === "verify") {
        const ids = idsOf(prompt)
        verified.push(...ids)
        return { text: JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "confirmed", evidence: [] })) }), tokens }
      }
      reviews++
      if (reviews === stallAt) throw new ReviewTurnStalled("idle", 600_000)
      const files = filesOf(prompt)
      reviewed.push(files)
      const findings = files.map((file) => ({ path: file, line: 1, severity: "major", category: "correctness", summary: `unchecked shape in ${file}`, detail: "d", evidence: [`${file}:1`] }))
      const walkthrough = { overview: `Part ${reviewed.length}.`, changes: [{ layer: `Layer ${reviewed.length}`, files, summary: "adds layers" }], type: "feature", risk: { level: reviewed.length === 2 ? "high" : "low", reason: `part ${reviewed.length}` }, checks: [] }
      return { text: JSON.stringify({ summary: `Part ${reviewed.length} adds ${files.length} layers.`, findings, walkthrough }), tokens }
    },
    async close() {},
  })
  return { factory, reviewed, verified, reviews: () => reviews }
}

/** A context of `files` new files of `lines` lines, built by the real builder within `contextTokens`. */
/** One call's bound in these tests: a 300-line file is about 3,300 tokens, so ten of them make five parts. */
const CALL = 16_000
const largeContext = (files: number, lines: number, contextTokens: number) => buildReviewContext({ directory: "/nonexistent", base: "base0000", head: "head1111", budgetTokens: contextTokens, git: gitWith(largeDiff(files, lines)) })
const config = (extra: Partial<ReviewEngineConfig> = {}): ReviewEngineConfig => ({ ...DEFAULT_ENGINE_CONFIG, budgetTokens: Number.POSITIVE_INFINITY, ...extra })

describe("a diff larger than one call is reviewed in parts of whole files", () => {
  test("every file is in exactly one part, in diff order, and every part fits half of the call's bound", async () => {
    const context = await largeContext(10, 300, CALL)
    const limit = CALL * CONTEXT_SHARE
    expect(context.tokens).toBeLessThanOrEqual(limit)
    expect(context.parts!.length).toBeGreaterThan(1)
    expect(context.parts!.flatMap((part) => part.files)).toEqual(context.files.map((file) => file.path))
    for (const part of context.parts!) expect(part.tokens).toBeLessThanOrEqual(limit)
    expect(context.notes.join("\n")).toContain(`so it was reviewed in ${context.parts!.length} parts of whole files`)
    expect(context.notes.join("\n")).not.toContain("left out")
  })

  test("a diff that fits one call has no parts and keeps its old shape", async () => {
    const context = await largeContext(3, 20, 200_000)
    expect(context.parts).toBeUndefined()
    expect(context.truncated).toBe(false)
  })

  test("a file larger than a call by itself is a note in its part; past the part limit the rest are notes in the last part", () => {
    const files = parseUnifiedDiff(largeDiff(3, 2_000))
    const big = splitIntoParts({ files, symbols: [], limit: 2_000 })
    expect(big.cut).toEqual(files.map((file) => file.path))
    expect(big.parts.every((part) => part.tokens <= 2_000)).toBe(true)
    const many = parseUnifiedDiff(largeDiff(MAX_REVIEW_PARTS + 6, 40))
    const one = estimateTokens(many[0]!.text.length)
    const capped = splitIntoParts({ files: many, symbols: [], limit: one + 10 })
    expect(capped.parts).toHaveLength(MAX_REVIEW_PARTS)
    expect(capped.parts.flatMap((part) => part.files)).toHaveLength(many.length)
    expect(capped.cut).toHaveLength(6)
    expect(capped.parts.at(-1)!.diff).toContain("left out by the review's limit of 12 parts")
  })

  test("one review call per part, the findings of every part merged, one verify pass over all of them, walkthroughs merged", async () => {
    const context = await largeContext(10, 300, CALL)
    const kids = partsEngine()
    const outcome = await reviewPullRequest({ sessionFactory: kids.factory, context, config: config(), cap: 50 })
    expect(kids.reviewed).toEqual(context.parts!.map((part) => part.files))
    expect(outcome.stop).toBeUndefined()
    expect(outcome.verified).toBe(true)
    expect(outcome.result.findings).toHaveLength(10)
    expect(new Set(kids.verified).size).toBe(10)
    const walkthrough = outcome.result.walkthrough!
    expect(walkthrough.changes.flatMap((group) => group.files)).toEqual(context.files.map((file) => file.path))
    expect(walkthrough.risk.level).toBe("high")
    expect(outcome.result.summary).toContain("Part 1 adds")
    expect(outcome.result.summary).toContain(`Part ${context.parts!.length} adds`)
    expect(outcome.result.summary.match(/reviewed in \d+ parts of whole files/g)).toHaveLength(1)
  })

  test("each part's prompt says which part it is; only the first judges the pre-merge checks", async () => {
    const context = await largeContext(6, 300, CALL)
    const prompts: string[] = []
    const factory: ReviewSessionFactory = async ({ purpose }) => ({ async send(prompt) { if (purpose === "review") prompts.push(prompt); return { text: JSON.stringify({ summary: "s", findings: [], verdicts: [] }), tokens: { input: 1, output: 1 } } }, async close() {} })
    await reviewPullRequest({ sessionFactory: factory, context, config: config(), cap: 50 })
    expect(prompts).toHaveLength(context.parts!.length)
    expect(prompts[0]).toContain(`this is part 1 of ${context.parts!.length}`)
    expect(prompts[0]).not.toContain("leave `checks` empty")
    expect(prompts[1]).toContain("leave `checks` empty, the first part judges them")
  })
})

describe("a stalled or budget-stopped review keeps the parts it finished", () => {
  test("a stall in part 3 keeps parts 1 and 2 and their candidates; the retry reviews only the rest, then verifies every candidate", async () => {
    const context = await largeContext(10, 300, CALL)
    const total = context.parts!.length
    expect(total).toBeGreaterThanOrEqual(4)
    const first = partsEngine({ stallAt: 3 })
    const stopped = await attemptReview({ sessionFactory: first.factory, account: undefined, context, config: config(), plan: DEFAULT_PHASE_PLAN, cap: 50 })
    if (stopped.ok || !stopped.stalled) throw new Error("expected a stalled attempt")
    expect(stopped.checkpoint.phase).toBe(partPhase(2, total))
    expect(parsePartPhase(stopped.checkpoint.phase)).toEqual({ done: 2, total })
    const kept = [...context.parts![0]!.files, ...context.parts![1]!.files]
    expect(stopped.checkpoint.candidates.map((finding) => finding.path)).toEqual(kept)
    expect(stopped.checkpoint.result!.findings).toEqual([])
    expect(first.verified).toEqual([])

    const second = partsEngine()
    const resumed = await resumeReview({ sessionFactory: second.factory, context, config: config(), checkpoint: stopped.checkpoint, cap: 50 })
    expect(second.reviewed).toEqual(context.parts!.slice(2).map((part) => part.files))
    expect(resumed.stop).toBeUndefined()
    expect(resumed.result.findings).toHaveLength(10)
    expect(new Set(second.verified).size).toBe(10)
    expect(resumed.result.tokens.input).toBe(1_000 * total + 1_000 * Math.ceil(10 / 10))
  })

  test("a budget the rest of the parts cannot fit stops before the next part, not after paying for it; a resume that cannot review another part is no_progress", async () => {
    const context = await largeContext(10, 300, CALL)
    const total = context.parts!.length
    const diff = context.parts!.reduce((sum, part) => sum + part.tokens, 0)
    // The estimate fits the review pass, but each part really counts about twice its estimate (a dense diff, the files it reads).
    const budgetTokens = Math.ceil((1.5 * diff) / REVIEW_PASS_SHARE)
    const kids = partsEngine({ tokens: { input: Math.ceil((2 * diff) / total), output: 0 } })
    const stopped = await reviewPullRequest({ sessionFactory: kids.factory, context, config: config({ budgetTokens }), cap: 50 })
    expect(kids.reviews()).toBe(1)
    expect(stopped.stop).toMatchObject({ kind: "budget", resumable: true, unit: "tokens", limit: budgetTokens })
    expect(stopped.stop!.detail).toContain(`Stopped before part 2 of ${total} without spending on it`)
    expect(stopped.stop!.remaining).toContain(`${total - 1} of ${total} parts of the diff not reviewed`)
    expect(stopped.checkpoint!.phase).toBe(partPhase(1, total))
    // It does not end empty: the closing check verified part 1's candidates, and the rest is said to be missing.
    expect(stopped.partial).toMatchObject({ reviewed: context.parts![0]!.files, notReviewed: context.parts!.slice(1).flatMap((part) => part.files), unverified: 0 })
    expect(stopped.result.findings.map((finding) => finding.path)).toEqual(context.parts![0]!.files)
    expect(stopped.result.summary).toContain(`the ${total - 1} remaining parts need about`)

    // An allowance too small for any further part makes no progress, and says so.
    const again = partsEngine()
    const stuck = await resumeReview({ sessionFactory: again.factory, context, config: config({ budgetTokens: 1_000 }), checkpoint: stopped.checkpoint!, cap: 50 })
    expect(again.reviews()).toBe(0)
    expect(stuck.stop).toMatchObject({ kind: "no_progress", resumable: false })
    expect(stuck.partial).toBeUndefined()

    const raised = await resumeReview({ sessionFactory: again.factory, context, config: config(), checkpoint: stopped.checkpoint!, cap: 50 })
    expect(again.reviewed).toEqual(context.parts!.slice(1).map((part) => part.files))
    expect(raised.stop).toBeUndefined()
    expect(raised.result.findings).toHaveLength(10)
  })

  test("a budget that fits the measured cost changes nothing: every part is reviewed once and every candidate verified", async () => {
    const context = await largeContext(10, 300, CALL)
    const total = context.parts!.length
    const diff = context.parts!.reduce((sum, part) => sum + part.tokens, 0)
    const kids = partsEngine({ tokens: { input: Math.ceil(diff / total), output: 100 } })
    const done = await reviewPullRequest({ sessionFactory: kids.factory, context, config: config({ budgetTokens: Math.ceil((2 * diff) / REVIEW_PASS_SHARE) }), cap: 50 })
    expect(kids.reviews()).toBe(total)
    expect(done.stop).toBeUndefined()
    expect(done.result.findings).toHaveLength(10)
  })

  test("a diff larger than all the review pass may spend is never sent: the stop says so before any model call", async () => {
    const context = await largeContext(10, 300, CALL)
    const diff = context.parts!.reduce((sum, part) => sum + part.tokens, 0)
    const kids = partsEngine()
    const stopped = await reviewPullRequest({ sessionFactory: kids.factory, context, config: config({ budgetTokens: Math.floor(diff / REVIEW_PASS_SHARE) - 1_000 }), cap: 50 })
    expect(kids.reviews()).toBe(0)
    expect(stopped.stop).toMatchObject({ kind: "budget", resumable: true, used: 0 })
    expect(stopped.stop!.detail).toContain("Nothing was sent to a model")
    expect(stopped.stop!.detail).toContain(`needs at least about ${diff.toLocaleString("en-US")} tokens`)
    expect(stopped.checkpoint!.phase).toBe("analysis")
    expect(stopped.checkpoint!.result).toBeUndefined()
  })

  test("PR #23 as it ran (four parts of JSON results, about 365K counted each, cap 1,000,000): it stops after part 1, not mid part 3 after 1,071,143", async () => {
    // The real parts of Eden-sudo/Symbex-1#23 at 0afbdcdc (buildReviewContext with a 400K call bound): 180,171 · 192,279 · 193,631 · 121,438.
    const parts = [180_171, 192_279, 193_631, 121_438].map((tokens) => ({ tokens }))
    const budgetTokens = 1_000_000
    expect(passShortfall({ parts, index: 0, used: 0, budgetTokens })).toBeUndefined()
    // Part 1 counted about what parts 1 and 2 did together on average (729,106 / 2).
    const afterOne = passShortfall({ parts, index: 1, used: 364_553, budgetTokens })
    expect(afterOne).toBeDefined()
    expect(afterOne!.left).toBe(800_000 - 364_553)
    expect(afterOne!.needed).toBeGreaterThan(1_000_000)
    // As it ran: two parts done, 70,894 left for part 3 (800,000 - 729,106), whose first request alone counted 341,975.
    const beforeThree = passShortfall({ parts, index: 2, used: 729_106, budgetTokens })
    expect(beforeThree).toMatchObject({ left: 70_894 })
    expect(beforeThree!.needed).toBeGreaterThan(341_975)
    expect(passShortfall({ parts, index: 1, used: 364_553, budgetTokens: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  test("a checkpoint whose diff now splits differently runs the review pass again, still counting the tokens it spent", async () => {
    const before = await largeContext(10, 300, CALL)
    const first = partsEngine({ stallAt: 2 })
    const stopped = await attemptReview({ sessionFactory: first.factory, account: undefined, context: before, config: config(), plan: DEFAULT_PHASE_PLAN, cap: 50 })
    if (stopped.ok) throw new Error("expected a stopped attempt")
    const after = await largeContext(10, 300, 30_000)
    expect(after.parts!.length).not.toBe(before.parts!.length)
    const second = partsEngine()
    const resumed = await resumeReview({ sessionFactory: second.factory, context: after, config: config(), checkpoint: stopped.checkpoint, cap: 50 })
    expect(second.reviewed).toEqual(after.parts!.map((part) => part.files))
    expect(resumed.result.summary).toContain("the review pass ran again from the start")
    expect(resumed.result.tokens.input).toBeGreaterThanOrEqual(1_000 * (after.parts!.length + 1))
  })
})

// ── runPrReview on a large pull request (run.ts) ─────────────────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

/** main with the config, feature adding eight 200-line files: about 16,000 tokens of diff against a call bound of 4,000. */
async function largeRepository() {
  const dir = temp("mc-long-turns-")
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", "enabled: true\nbudget:\n  context_tokens: 8000\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  for (let index = 0; index < 8; index++) write(dir, `ml/layer_${index}.py`, Array.from({ length: 200 }, (_, line) => `weights_${index}[${line}] = compute(x, ${line})  # tensor`).join("\n") + "\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "feature")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}
const input = (repo: { dir: string; base: string; head: string }, sessionFactory: ReviewSessionFactory) => ({ repo: "acme/ml", number: 7, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory, publish: false })

describe("runPrReview: a large pull request whose review stalls", () => {
  test("the stall is a retryable failure with no stop, so the job keeps the checkpoint and backs off; the retry resumes; the notice names the head", async () => {
    const repo = await largeRepository()
    const first = partsEngine({ stallAt: 2 })
    const run = await runPrReview(input(repo, first.factory))
    expect(run.status).toBe("failed")
    expect(run.retryable).toBe(true)
    expect(run.stop).toBeUndefined()
    const part = parsePartPhase(run.checkpoint!.phase)!
    expect(part.done).toBe(1)
    expect(part.total).toBeGreaterThan(2)
    expect(run.checkpoint!.candidates.length).toBeGreaterThan(0)
    expect(run.checkpoint!.result!.head).toBe(repo.head)
    expect(run.reason).toContain("the review turn stalled")
    expect(run.reason).toContain(`1 of ${part.total} parts of the diff reviewed`)
    expect(run.reason).toContain("the retry continues from there")
    expect(classifyStop(run.reason!).kind).toBe("error")
    expect(failureKind(run.reason!)).toBe("unknown")
    const notice = reviewNotice({ repo: "acme/ml", number: 7, run })
    expect(notice).toStartWith("PR review of acme/ml#7: failed (review incomplete, the review turn stalled")
    expect(notice.split("\n")[1]).toBe(`Head: ${repo.head.slice(0, 12)}.`)

    const second = partsEngine()
    const resumed = await runPrReview({ ...input(repo, second.factory), checkpoint: run.checkpoint })
    expect(second.reviews()).toBe(part.total - 1)
    expect(resumed.status).toBe("reviewed")
    expect(resumed.stop).toBeUndefined()
    expect(resumed.outcome!.result.findings).toHaveLength(8)
  })

  test("a stall in the verify pass keeps the judged and unjudged candidates for a retry that verifies only those", async () => {
    const repo = await repository()
    let verifies = 0
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send(prompt) {
        if (purpose === "review") return { text: JSON.stringify({ summary: "s", findings: [{ path: "src/a.ts", line: 1, severity: "major", category: "correctness", summary: "a bug", detail: "d", evidence: ["src/a.ts:1"] }] }), tokens: { input: 10, output: 1 } }
        verifies++
        if (verifies === 1) throw new ReviewTurnStalled("idle", 600_000)
        return { text: JSON.stringify({ verdicts: idsOf(prompt).map((id) => ({ id, verdict: "confirmed", evidence: [] })) }), tokens: { input: 10, output: 1 } }
      },
      async close() {},
    })
    const run = await runPrReview(input(repo, factory))
    expect(run.status).toBe("failed")
    expect(run.retryable).toBe(true)
    expect(run.stop).toBeUndefined()
    expect(run.checkpoint).toMatchObject({ phase: "corroboration" })
    expect(run.checkpoint!.candidates).toHaveLength(1)
    expect(run.reason).toContain("the work before it is kept (1 candidate not verified)")
    const resumed = await runPrReview({ ...input(repo, factory), checkpoint: run.checkpoint })
    expect(resumed.status).toBe("reviewed")
    expect(resumed.outcome!.result.findings).toHaveLength(1)
  })

  test("a stall in a review pass with nothing finished yet is retryable too, and the retry runs the review pass again", async () => {
    const repo = await repository()
    const factory: ReviewSessionFactory = async () => ({ async send() { throw new ReviewTurnStalled("cap", 7_200_000) }, async close() {} })
    const run = await runPrReview(input(repo, factory))
    expect(run).toMatchObject({ status: "failed", retryable: true })
    expect(run.stop).toBeUndefined()
    expect(run.checkpoint).toMatchObject({ phase: "analysis", candidates: [] })
    expect(run.reason).toContain("was still running at its 2 hours cap")
    expect(run.reason).toContain("the retry runs the review pass again")
  })
})

/** A small repository: one new file, for the cases that do not need a large diff. */
async function repository() {
  const dir = temp("mc-long-turns-small-")
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", "enabled: true\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "src/a.ts", "export const a = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "feature")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}
