import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@mendcode/protocol"
import { buildReviewContext } from "../src/pr-review/context"
import { DEFAULT_ENGINE_CONFIG, reviewPrompt, reviewPullRequest, type ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId, parseFindings } from "../src/pr-review/findings"
import { groupFiles, readGroups, READER_TURN_OVERHEAD } from "../src/pr-review/readers"

/**
 * The live review of Eden-sudo/Symbex-1 #23 (a manual `full` review, 116 files: 106 result JSON files, 10 code files) stopped with
 * "could not review" because the model wrote a caveat into `incomplete`: the data files reached it as reader summaries and it has
 * no shell. The diff here has the PR's shape and its real result-file keys; the model's answer is the one the job recorded.
 */

const addedFile = (file: string, text: string) => {
  const lines = text.replace(/\n$/, "").split("\n")
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`
}
const probe = (seed: number) => JSON.stringify({ net: "binary", kind: "bop", seed, val_acc: 69.02, probe: Array.from({ length: 40 }, (_, index) => ({ layer: index, flip: 0.1 + index / 1000, acc: 60 + index / 10 })), convs: [3, 3, 3], flip: 0.12 }, null, 1) + "\n"
const BOP = "import numpy as np\n\n\ndef bop_step(weights, grad, momentum, gamma, tau):\n    momentum = (1 - gamma) * momentum + gamma * grad\n    flip = (np.abs(momentum) > tau) & (np.sign(momentum) == np.sign(weights))\n    return np.where(flip, -weights, weights), momentum\n"
const DIFF = [
  addedFile("tools/compiler_core/train/bop.py", BOP),
  ...Array.from({ length: 24 }, (_, index) => addedFile(`benchmarks/experiments/results/layer_probe/binary_s${40 + index}.json`, probe(40 + index))),
].join("")

const git = async () => ({ code: 0, out: DIFF, err: "" })
const localReaders = async ({ data, cut }: Parameters<NonNullable<Parameters<typeof buildReviewContext>[0]["readers"]>>[0]) =>
  [...(await readGroups({ groups: groupFiles({ data, cut }), source: { ok: false, reason: "test" }, parallel: 1, allowance: Number.POSITIVE_INFINITY })).summaries.values()]
const contextOf = () => buildReviewContext({ directory: "/x", base: "main", head: "feature", budgetTokens: 1_000_000, git, readers: localReaders })

/** What the job recorded: one finding, and the caveat the engine took for "could not review". */
const RECORDED_CAVEAT = "This is a partial source review: the summarized JSON artifacts were not independently inspected, and no shell execution tool was available to run tests or reproduce the experiments."
const bop = { path: "tools/compiler_core/train/bop.py", line: 6, severity: "major", category: "correctness", summary: "The flip rule compares the signs the wrong way", detail: "A weight flips when its momentum agrees with it, which reinforces the weight.", evidence: ["tools/compiler_core/train/bop.py:6"] }
const answer = (extra: Record<string, unknown>) => JSON.stringify({ summary: "The PR adds a Bop optimizer and recorded probe results.", findings: [bop], ...extra })
const verdict = JSON.stringify({ verdicts: [{ id: findingId({ path: bop.path, line: bop.line, category: bop.category, summary: bop.summary }), verdict: "confirmed", evidence: [] }] })

function scripted(answers: string[]) {
  const purposes: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send() { purposes.push(purpose); return { text: answers.shift() ?? "", tokens: { input: 1000, output: 100 } } },
    async close() {},
  })
  return { factory, purposes }
}

describe("a review whose data files reached the model as reader summaries", () => {
  test("the prompt says the data is summarized and that there is no shell, and the engine's cost matches its estimate", async () => {
    const context = await contextOf()
    expect(context.readers).toEqual({ files: 24 })
    const prompt = reviewPrompt(context, DEFAULT_ENGINE_CONFIG)
    expect(prompt).toContain("there is no shell")
    expect(prompt).toContain("reviewing the rest of the change with those summaries is a complete review")
    expect(prompt).toContain("Do not put the summarization in `incomplete`")
    // Instructions plus the diff and the summaries: nothing else rides along, so the call the cap was sized for is the call that is sent.
    expect(estimateTokens(prompt.length) - context.tokens).toBeLessThan(2_500)
    expect(prompt).toContain("Reader summary (local scan, no model, unverified): benchmarks/experiments/results/layer_probe/ (24 .json files)")
    expect(prompt).not.toContain('"seed": 40')
  })

  test("a caveat about summaries and a missing shell, next to a finding, goes to verify and is published with a note", async () => {
    const context = await contextOf()
    const engine = scripted([answer({ incomplete: RECORDED_CAVEAT }), verdict])
    const outcome = await reviewPullRequest({ sessionFactory: engine.factory, context, config: DEFAULT_ENGINE_CONFIG, cap: 100_000 })
    expect(engine.purposes).toEqual(["review", "verify"])
    expect(outcome.stop).toBeUndefined()
    expect(outcome.result.findings.map((entry) => entry.verdict)).toEqual(["confirmed"])
    expect(outcome.result.summary).toContain(`Reviewer's note: ${RECORDED_CAVEAT}`)
  })

  test("a caveat with a walkthrough and no findings is a clean review of what was reviewed, with the note", async () => {
    const context = await contextOf()
    const walkthrough = { overview: "Adds Bop and result files.", changes: [{ layer: "Optimizer", files: ["tools/compiler_core/train/bop.py"], summary: "A Bop step." }], type: "feature", risk: { level: "low", reason: "Opt-in." }, checks: [] }
    const engine = scripted([answer({ findings: [], incomplete: RECORDED_CAVEAT, walkthrough })])
    const outcome = await reviewPullRequest({ sessionFactory: engine.factory, context, config: DEFAULT_ENGINE_CONFIG, cap: 100_000 })
    expect(engine.purposes).toEqual(["review"])
    expect(outcome.stop).toBeUndefined()
    expect(outcome.result.summary).toContain("Reviewer's note: This is a partial source review")
  })

  test("a pass that read nothing still stops: no findings and nothing from the data files to go on", async () => {
    const context = await contextOf()
    const engine = scripted([answer({ findings: [], incomplete: "my tools are read-only and I could not open the changed files" })])
    const outcome = await reviewPullRequest({ sessionFactory: engine.factory, context, config: DEFAULT_ENGINE_CONFIG, cap: 100_000 })
    expect(outcome.stop).toMatchObject({ kind: "error" })
    expect(engine.purposes).toEqual(["review"])
    const bare = await buildReviewContext({ directory: "/x", base: "main", head: "feature", budgetTokens: 1_000_000, git })
    // A finding is something to go on even without readers: it goes to verify, which grounds it.
    const withFinding = scripted([answer({ incomplete: "I could not read the diff" }), verdict])
    const proceeded = await reviewPullRequest({ sessionFactory: withFinding.factory, context: bare, config: DEFAULT_ENGINE_CONFIG, cap: 100_000 })
    expect(withFinding.purposes).toEqual(["review", "verify"])
    expect(proceeded.stop).toBeUndefined()
  })

  test("parseFindings keeps the recorded caveat as incomplete; deciding what it means is the engine's job", () => {
    expect(parseFindings(answer({ incomplete: RECORDED_CAVEAT }))).toMatchObject({ ok: true, incomplete: RECORDED_CAVEAT })
  })
})

describe("the bound of a reader call", () => {
  test("a Claude Haiku reader as measured live (12,087 tokens of excerpt, 69,020 counted in one call) is not stopped before it answers", () => {
    const limit = Math.ceil(12_087 * 1.5) + READER_TURN_OVERHEAD
    expect(limit).toBeGreaterThanOrEqual(58_641 + 10_379 + 5_000)
  })
})
