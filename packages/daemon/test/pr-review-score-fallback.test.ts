import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelInfo } from "@mendcode/protocol"
import { PrFinding } from "@mendcode/protocol"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { chooseFallbackModel, isProviderFailure, newFallbackState, withFallbacks } from "../src/pr-review/fallback"
import { findingId } from "../src/pr-review/findings"
import { parseReviewConfig } from "../src/pr-review/config"
import type { ModelCatalog } from "../src/models"
import { runPrReview } from "../src/pr-review/run"
import { ReviewTurnError, ReviewTurnStalled } from "../src/pr-review/sessions"
import { commentBody, renderReviewBody } from "../src/pr-review/template"
import { emptyState } from "../src/pr-review/state"
import { publishable, rankFindings } from "../src/pr-review/verify"

/** The verifier's score (`min_score`) and `fallback_models`: the config, the filter and order, the comment, and the model switch. */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }
const MATH_BASE = "export function total(values: number[]) {\n  let sum = 0\n  for (const value of values) sum += value\n  return sum\n}\nexport const half = (n: number) => n / 2\n"
const MATH_FEATURE = "export function total(values: number[]) {\n  let sum = 0\n  for (let i = 1; i < values.length; i++) sum += values[i]!\n  return sum\n}\nexport const half = (n: number) => n >> 1\n"
async function repository(config: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-score-")))
  temps.push(dir)
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", config)
  write(dir, "src/math.ts", MATH_BASE)
  await git(dir, "add", "-A"); await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "src/math.ts", MATH_FEATURE)
  await git(dir, "add", "-A"); await git(dir, "commit", "-q", "-m", "feature")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}
const LOOP = { path: "src/math.ts", line: 3, severity: "major", category: "correctness", summary: "The loop skips the first value", detail: "d", evidence: ["src/math.ts:3"] }
const HALF = { path: "src/math.ts", line: 6, severity: "major", category: "correctness", summary: "half() truncates odd numbers", detail: "d", evidence: ["src/math.ts:6"] }

/** A child that reviews with LOOP and HALF and judges every finding with `scores[summary]` (a missing score is omitted). */
function kids({ scores = {}, failReview }: { scores?: Record<string, number | string>; failReview?: Error } = {}) {
  const turns: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      turns.push(purpose)
      if (failReview && purpose === "review") throw failReview
      if (purpose === "review") return { text: JSON.stringify({ summary: "Changes the math helpers.", findings: [LOOP, HALF] }), tokens: { input: 1000, output: 100 } }
      const block = prompt.slice(prompt.indexOf("<findings"), prompt.indexOf("</findings>"))
      const rows = block.split("\n").flatMap((line) => { try { const value = JSON.parse(line) as { id?: string; summary?: string }; return value.id ? [value] : [] } catch { return [] } })
      return { text: JSON.stringify({ verdicts: rows.map((row) => ({ id: row.id, verdict: "confirmed", evidence: [], ...(row.summary! in scores ? { score: scores[row.summary!] } : {}) })) }), tokens: { input: 1000, output: 100 } }
    },
    async close() {},
  })
  return { factory, turns }
}
const input = (repo: { dir: string; base: string; head: string }, sessionFactory: ReviewSessionFactory) => ({ repo: "acme/app", number: 12, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory, publish: false })

describe("min_score", () => {
  test("the config key defaults to 0, takes 0 to 10 and is a style a personal layer may set", () => {
    expect(parseReviewConfig("enabled: true\n").config.min_score).toBe(0)
    expect(parseReviewConfig("min_score: 6\n").config.min_score).toBe(6)
    expect(parseReviewConfig("min_score: 11\n").problem).toContain("min_score")
    expect(parseReviewConfig("min_score: 2.5\n").problem).toContain("min_score")
  })

  test("the verify prompt asks for a score and a verdict's score is kept on the finding, clamped to 0..10", async () => {
    const repo = await repository("enabled: true\n")
    const child = kids({ scores: { [LOOP.summary]: 9, [HALF.summary]: 40 } })
    const prompts: string[] = []
    const factory: ReviewSessionFactory = async (request) => { const session = await child.factory(request); return { ...session, send: (prompt, options) => { if (request.purpose === "verify") prompts.push(prompt); return session.send(prompt, options) } } }
    const run = await runPrReview(input(repo, factory))
    expect(prompts[0]).toContain("score")
    expect(run.outcome!.result.findings.map((finding) => [finding.summary, finding.score])).toEqual([[HALF.summary, 10], [LOOP.summary, 9]])
  })

  test("a finding below min_score is not published; the default publishes both as before", async () => {
    const repo = await repository("enabled: true\nmin_score: 6\n")
    const run = await runPrReview(input(repo, kids({ scores: { [LOOP.summary]: 9, [HALF.summary]: 3 } }).factory))
    expect(run.outcome!.result.findings.map((finding) => finding.summary)).toEqual([LOOP.summary])
    expect(run.outcome!.result.dropped).toBe(1)
    const plain = await repository("enabled: true\n")
    const all = await runPrReview(input(plain, kids({ scores: { [LOOP.summary]: 9, [HALF.summary]: 3 } }).factory))
    expect(all.outcome!.result.findings).toHaveLength(2)
  })

  test("a finding the verifier gave no score is never dropped by min_score", async () => {
    const repo = await repository("enabled: true\nmin_score: 10\n")
    const run = await runPrReview(input(repo, kids({ scores: { [HALF.summary]: 2 } }).factory))
    expect(run.outcome!.result.findings.map((finding) => finding.summary)).toEqual([LOOP.summary])
  })

  test("within a severity the higher score comes first, before the cap cuts", () => {
    const base = { path: "a.ts", line: 1, side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, detail: "d", evidence: [], verdict: "confirmed" as const }
    const make = (summary: string, score?: number) => PrFinding.parse({ ...base, id: findingId({ path: "a.ts", line: 1, category: "correctness", summary }), summary, ...(score !== undefined ? { score } : {}) })
    const low = make("low", 2), high = make("high", 9), none = make("none")
    expect(rankFindings([low, none, high], 2).shown.map((finding) => finding.summary)).toEqual(["high", "low"])
    expect(publishable([low, none, high], "normal", 5).map((finding) => finding.summary)).toEqual(["none", "high"])
  })

  test("the score shows small in the inline comment and in the findings table, and not at all without one", () => {
    const finding = PrFinding.parse({ id: findingId({ path: "a.ts", line: 1, category: "correctness", summary: "s" }), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "s", detail: "d", evidence: [], verdict: "confirmed", score: 8 })
    expect(commentBody(finding)).toContain("<sub>score 8/10</sub>")
    expect(commentBody({ ...finding, score: undefined })).not.toContain("score")
    const body = renderReviewBody({ result: { head: "h".repeat(40), base: "b".repeat(40), findings: [finding], dropped: 0, summary: "", tokens: { input: 1, output: 1 }, budgetHit: false }, inline: 1, moved: [], repo: "a/b" })
    expect(body).toContain("<sub>8/10</sub>")
  })
})

describe("fallback_models", () => {
  const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, efforts: [], ...extra })
  const catalog = (allow?: string[]): ModelCatalog => {
    const models = [model("gpt-6-sol"), model("gpt-6-terra"), model("claude-opus", { engine: "claude" }), model("claude-sonnet", { engine: "claude" }), model("deepseek:deepseek-chat", { provider: "deepseek" })]
    return { selectable: true, list: () => models, defaults: { model: "gpt-6-sol" }, ...(allow ? { allows: (id: string) => allow.includes(id) } : {}) }
  }

  test("the config key is an empty list by default and takes up to five names", () => {
    expect(parseReviewConfig("enabled: true\n").config.fallback_models).toEqual([])
    expect(parseReviewConfig("fallback_models: [gpt-6-terra]\n").config.fallback_models).toEqual(["gpt-6-terra"])
    expect(parseReviewConfig("fallback_models: [a, b, c, d, e, f]\n").problem).toContain("fallback_models")
  })

  test("a fallback is taken from the reviewer's own provider and the allowed list only", () => {
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(), requested: "gpt-6-terra" })).toEqual({ ok: true, model: "gpt-6-terra" })
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(), requested: "claude-sonnet" })).toMatchObject({ ok: false, reason: expect.stringContaining("own provider") })
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(), requested: "deepseek:deepseek-chat" }).ok).toBe(false)
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(["gpt-6-sol"]), requested: "gpt-6-terra" })).toMatchObject({ ok: false, reason: expect.stringContaining("allowed model list") })
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(), requested: "nope" })).toMatchObject({ ok: false, reason: expect.stringContaining("not in the model catalog") })
    expect(chooseFallbackModel({ owner: { model: "gpt-6-sol" }, catalog: catalog(), requested: "gpt-6-sol" }).ok).toBe(false)
    expect(chooseFallbackModel({ owner: undefined, catalog: catalog(), requested: "gpt-6-terra" }).ok).toBe(false)
  })

  test("only a provider error moves a review: not a quota, a rate limit, a stall or a cancelled turn", () => {
    expect(isProviderFailure(new ReviewTurnError("[PR_REVIEW]: the review turn failed: model_not_found", "error"))).toBe(true)
    expect(isProviderFailure(new ReviewTurnError("[PR_REVIEW]: the review turn failed: usage_limit_reached", "quota"))).toBe(false)
    expect(isProviderFailure(new ReviewTurnError("[PR_REVIEW]: the review turn failed: 429", "rate_limit"))).toBe(false)
    expect(isProviderFailure(new ReviewTurnStalled("idle", 600_000))).toBe(false)
    expect(isProviderFailure(new ReviewTurnError("[PR_REVIEW]: the review turn stopped", "error"))).toBe(false)
    expect(isProviderFailure(new Error("boom"))).toBe(false)
  })

  const unavailable = () => new ReviewTurnError("[PR_REVIEW]: the review turn failed: The model `gpt-6-sol` does not exist or you do not have access to it", "error")
  const answering = (name: string, log: string[]): ReviewSessionFactory => async () => ({ async send() { log.push(name); return { text: name, tokens: { input: 1, output: 1 } } }, async close() {} })
  const failing = (log: string[], error: () => Error = unavailable): ReviewSessionFactory => async () => ({ async send() { log.push("primary"); throw error() }, async close() {} })

  test("the first turn moves to the fallback and the next sessions start there; a session already answering is never moved", async () => {
    const log: string[] = []
    const state = newFallbackState()
    const factory = withFallbacks({ primary: failing(log), sources: [{ model: "gpt-6-terra", factory: answering("terra", log) }], state })
    expect((await (await factory({ purpose: "review" })).send("p")).text).toBe("terra")
    expect((await (await factory({ purpose: "verify" })).send("p")).text).toBe("terra")
    expect(log).toEqual(["primary", "terra", "terra"])
    expect(state.at).toBe(0)
    expect(state.reason).toContain("does not exist")
    let turns = 0
    const midway: ReviewSessionFactory = async () => ({ async send() { if (turns++ === 1) throw unavailable(); return { text: "ok", tokens: { input: 1, output: 1 } } }, async close() {} })
    const session = await withFallbacks({ primary: midway, sources: [{ model: "x", factory: answering("x", log) }], state: newFallbackState() })({ purpose: "review" })
    await session.send("one")
    await expect(session.send("two")).rejects.toThrow("does not exist")
  })

  test("without a fallback, or when every fallback fails, the error is the model's; a quota is not moved", async () => {
    const log: string[] = []
    await expect((await withFallbacks({ primary: failing(log), sources: [], state: newFallbackState() })({ purpose: "review" })).send("p")).rejects.toThrow("does not exist")
    await expect((await withFallbacks({ primary: failing(log), sources: [{ model: "a", factory: failing(log, () => new ReviewTurnError("[PR_REVIEW]: the review turn failed: overloaded_model", "error")) }], state: newFallbackState() })({ purpose: "review" })).send("p")).rejects.toThrow("overloaded_model")
    const quota = () => new ReviewTurnError("[PR_REVIEW]: the review turn failed: usage_limit_reached", "quota")
    const before = log.length
    await expect((await withFallbacks({ primary: failing(log, quota), sources: [{ model: "a", factory: answering("a", log) }], state: newFallbackState() })({ purpose: "review" })).send("p")).rejects.toThrow("usage_limit_reached")
    expect(log.slice(before)).toEqual(["primary"])
  })

  test("a session that cannot be created moves to the fallback too", async () => {
    const log: string[] = []
    const broken: ReviewSessionFactory = async () => { throw unavailable() }
    const session = await withFallbacks({ primary: broken, sources: [{ model: "a", factory: answering("a", log) }], state: newFallbackState() })({ purpose: "review" })
    expect((await session.send("p")).text).toBe("a")
  })

  test("a review whose model is unavailable is done by the fallback, and the comment says which model reviewed", async () => {
    const repo = await repository("enabled: true\nfallback_models: [gpt-6-terra]\n")
    const primary = kids({ failReview: unavailable() })
    const backup = kids()
    const run = await runPrReview({ ...input(repo, primary.factory), fallbacks: { source: (requested) => requested === "gpt-6-terra" ? { ok: true, model: "gpt-6-terra", factory: backup.factory } : { ok: false, reason: "no" } } })
    expect(run.status).toBe("reviewed")
    expect(primary.turns).toEqual(["review"])
    expect(backup.turns[0]).toBe("review")
    expect(run.info!.fallback!.model).toBe("gpt-6-terra")
    expect(run.info!.fallback!.why).toContain("does not exist")
    const body = renderReviewBody({ result: run.outcome!.result, inline: run.outcome!.result.findings.length, moved: [], repo: "a/b", info: run.info! })
    expect(body).toContain("reviewed by fallback model `gpt-6-terra` after the reviewer's own model failed")
    // A review that needed no fallback says nothing about one.
    const clean = await runPrReview({ ...input(repo, kids().factory), fallbacks: { source: () => ({ ok: true, model: "gpt-6-terra", factory: backup.factory }) } })
    expect(clean.info!.fallback).toBeUndefined()
  })

  test("a quota on the reviewer's model still stops the job and never reaches the fallback", async () => {
    const repo = await repository("enabled: true\nfallback_models: [gpt-6-terra]\n")
    const backup = kids()
    const run = await runPrReview({ ...input(repo, kids({ failReview: new ReviewTurnError("[PR_REVIEW]: the review turn failed: usage_limit_reached", "quota") }).factory), fallbacks: { source: () => ({ ok: true, model: "gpt-6-terra", factory: backup.factory }) } })
    expect(run.stop?.kind).toBe("quota")
    expect(backup.turns).toEqual([])
  })

  test("a fallback that may not be used is skipped with a note, and the primary's error stands", async () => {
    const repo = await repository("enabled: true\nfallback_models: [claude-sonnet]\n")
    const run = await runPrReview({ ...input(repo, kids({ failReview: unavailable() }).factory), fallbacks: { source: () => ({ ok: false, reason: "fallback model claude-sonnet is not on the reviewer's own provider" }) } })
    expect(run.status).not.toBe("reviewed")
    const noted = await runPrReview({ ...input(repo, kids().factory), fallbacks: { source: () => ({ ok: false, reason: "fallback model claude-sonnet is not on the reviewer's own provider" }) } })
    expect(noted.info!.notes.join("\n")).toContain("fallback_models: fallback model claude-sonnet is not on the reviewer's own provider; skipped.")
  })
})
