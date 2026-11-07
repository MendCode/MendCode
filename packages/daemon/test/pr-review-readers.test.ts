import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelInfo } from "@mendcode/protocol"
import { gitRun, parseUnifiedDiff } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { ModelCatalog } from "../src/models"
import { chooseReaderModel, isCheapReaderModel } from "../src/pr-review/reader-models"
import { batchGroups, groupFiles, localSummary, readGroups, READER_TURN_OVERHEAD, READERS_BY_TIER, type ReaderSource } from "../src/pr-review/readers"
import { runPrReview } from "../src/pr-review/run"
import { emptyState } from "../src/pr-review/state"
import { triageFile, triageFiles } from "../src/pr-review/triage"

/**
 * Readers (docs/pr-review.md, "Data files and readers"): triage keeps data and generated files from the review pass, readers on a
 * cheap model of the reviewer's own provider summarize them, a model off the cheap list is never called, no cheap model means a
 * local summary, and the tier sets how many read at once. Scripted children and a temp git repository; no provider is called.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-readers-"))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

/** A training result like those of a benchmark PR: run parameters, then one record per epoch of numbers. */
const result = (seed: number, epochs = 60) => JSON.stringify({ model: "binary", seed, epochs, train_acc: 70.74, val_acc: 69.02, history: Array.from({ length: epochs }, (_, index) => ({ epoch: index + 1, lr: 0.005 - index * 1e-5, loss: 1.84 / (index + 1), train_acc: 41.18 + index / 3, val_acc: 40.86 + index / 3 })) }, null, 1) + "\n"
const newFileDiff = (file: string, text: string) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${text.split("\n").length - 1} @@\n${text.replace(/\n$/, "").split("\n").map((line) => `+${line}`).join("\n")}\n`
const fileOf = (file: string, text: string) => parseUnifiedDiff(newFileDiff(file, text))[0]!

describe("triage", () => {
  test("result JSON, lockfiles, minified bundles, snapshots, assets and numeric tables go to readers; code, manifests and small changes stay", () => {
    expect(triageFile(fileOf("benchmarks/experiments/results/train_gap/binary_s42.json", result(42)))).toBe("data")
    expect(triageFile(fileOf("bun.lock", Array.from({ length: 80 }, (_, index) => `"pkg${index}": "1.0.${index}",`).join("\n") + "\n"))).toBe("lockfile")
    expect(triageFile(fileOf("dist/app.min.js", Array.from({ length: 50 }, () => "var a=1;").join("\n") + "\n"))).toBe("minified")
    expect(triageFile(fileOf("src/__snapshots__/view.test.ts.snap", Array.from({ length: 60 }, (_, index) => `exports[\`row ${index}\`] = \`x\`;`).join("\n") + "\n"))).toBe("snapshot")
    expect(triageFile(fileOf("docs/chart.svg", Array.from({ length: 60 }, (_, index) => `<rect x="${index}" y="0"/>`).join("\n") + "\n"))).toBe("asset")
    expect(triageFile(fileOf("tables/scores.txt", Array.from({ length: 300 }, (_, index) => `${index}, ${index * 0.5}, ${index * 2.25}`).join("\n") + "\n"))).toBe("numeric")
    const code = Array.from({ length: 300 }, (_, index) => `export function f${index}(value: number) { return value + ${index} }`).join("\n") + "\n"
    expect(triageFile(fileOf("src/many.ts", code))).toBeUndefined()
    expect(triageFile(fileOf("package.json", JSON.stringify({ name: "a", dependencies: Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`dep${index}`, "1.0.0"])) }, null, 2) + "\n"))).toBeUndefined()
    // A small result file costs less to read than to summarize: the review pass reads it.
    expect(triageFile(fileOf("benchmarks/results/tiny.json", "{\n \"a\": 1\n}\n"))).toBeUndefined()
  })

  test("only the base branch's .gitattributes marks files generated; the last matching rule wins", () => {
    const generated = fileOf("src/gen/api.ts", Array.from({ length: 60 }, (_, index) => `export const op${index} = "${index}"`).join("\n") + "\n")
    const triaged = triageFiles([generated], "src/gen/** linguist-generated\n")
    expect(triaged.data.map((entry) => entry.reason)).toEqual(["generated"])
    expect(triageFiles([generated], "src/gen/** linguist-generated\nsrc/gen/api.ts -linguist-generated\n").data).toEqual([])
    expect(triageFiles([generated], "*.ts linguist-vendored=true\n").data.map((entry) => entry.reason)).toEqual(["generated"])
    expect(triageFiles([generated]).data).toEqual([])
  })

  test("results of one experiment are one group with their keys; the local summary names sizes, keys and rarities without values", () => {
    const files = [42, 43, 44].map((seed) => fileOf(`results/run/binary_s${seed}.json`, result(seed)))
    const leaky = fileOf("results/other/env.json", JSON.stringify({ path: "/Users/alice/data/train.bin", token: "ghp_" + "a".repeat(36), loss: "NaN" }, null, 1).replace("\"NaN\"", "NaN") + "\n" + Array.from({ length: 60 }, () => " ").join("\n") + "\n")
    const groups = groupFiles({ data: triageFiles([...files, leaky]).data })
    expect(groups.map((group) => group.files.length)).toEqual([3, 1])
    const first = localSummary(groups[0]!)
    expect(first.text).toContain("results/run/ (3 .json files)")
    expect(first.text).toContain("keys: model, seed, epochs, train_acc, val_acc, history")
    const second = localSummary(groups[1]!).text
    expect(second).toContain("absolute paths")
    expect(second).toContain("possible github-token")
    expect(second).toContain("NaN or Infinity")
    expect(second).not.toContain("ghp_")
  })
})

const catalogOf = (models: ModelInfo[]): ModelCatalog => ({ selectable: true, list: () => models, defaults: { model: models[0]!.id } })
const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, efforts: [], ...extra })
const CATALOG = catalogOf([
  model("claude-opus", { engine: "claude" }), model("claude-sonnet", { engine: "claude" }), model("claude-haiku", { engine: "claude" }),
  model("codex:gpt-6-sol", { engine: "codex" }), model("codex:gpt-6-luna", { engine: "codex" }),
  model("gpt-6-sol"), model("gpt-6-terra"), model("gpt-6-luna"),
  model("deepseek:deepseek-reasoner", { provider: "deepseek" }), model("deepseek:deepseek-chat", { provider: "deepseek" }),
  model("anthropic:claude-opus-4-1", { provider: "anthropic" }),
])

describe("reader models", () => {
  test("each subscription reads with its own cheap model: Claude Code → Haiku, Codex and the ChatGPT login → luna, DeepSeek → chat", () => {
    expect(chooseReaderModel({ owner: { model: "claude-opus" }, catalog: CATALOG })).toEqual({ ok: true, model: "claude-haiku", family: "Claude Haiku" })
    expect(chooseReaderModel({ owner: { model: "codex:gpt-6-sol" }, catalog: CATALOG })).toMatchObject({ ok: true, model: "codex:gpt-6-luna" })
    expect(chooseReaderModel({ owner: { model: "gpt-6-sol" }, catalog: CATALOG })).toMatchObject({ ok: true, model: "gpt-6-luna" })
    expect(chooseReaderModel({ owner: { model: "deepseek:deepseek-reasoner" }, catalog: CATALOG })).toMatchObject({ ok: true, model: "deepseek:deepseek-chat" })
    // The Anthropic API key provider has no cheap model listed: never Claude Code's Haiku (another transport), never the large model.
    expect(chooseReaderModel({ owner: { model: "anthropic:claude-opus-4-1" }, catalog: CATALOG }).ok).toBe(false)
  })

  test("an ACP harness model is never the reader, though the ChatGPT login lists them first (live job on Symbex-1 #23)", () => {
    const live = catalogOf([
      model("acp:opencode/opencode-go/claude-haiku-5-5"), model("acp:opencode/openai/gpt-6-luna"), model("acp:opencode/opencode/gemini-3.5-flash-lite"),
      model("gpt-5.6-luna"), model("gpt-6-luna"), model("gpt-6.1-sol"), model("gpt-6.1-terra"),
    ])
    const picked = chooseReaderModel({ owner: { model: "gpt-6.1-sol" }, catalog: live })
    expect(picked).toMatchObject({ ok: true, model: "gpt-5.6-luna", family: "GPT luna" })
    const asked = chooseReaderModel({ owner: { model: "gpt-6.1-sol" }, catalog: live, requested: "acp:opencode/openai/gpt-6-luna" })
    expect(!asked.ok && asked.reason).toContain("not a model of the reviewer's own provider")
    expect(chooseReaderModel({ owner: { model: "gpt-6.1-sol" }, catalog: catalogOf([model("acp:opencode/openai/gpt-6-luna"), model("gpt-6.1-sol")]) }).ok).toBe(false)
  })

  test("a configured model off the cheap list, or of another provider, is refused with the reason", () => {
    const expensive = chooseReaderModel({ owner: { model: "claude-opus" }, catalog: CATALOG, requested: "claude-opus" })
    expect(expensive).toMatchObject({ ok: false })
    expect(!expensive.ok && expensive.reason).toContain("is not a cheap reader model")
    const foreign = chooseReaderModel({ owner: { model: "claude-opus" }, catalog: CATALOG, requested: "gpt-6-luna" })
    expect(!foreign.ok && foreign.reason).toContain("not a model of the reviewer's own provider")
    expect(chooseReaderModel({ owner: { model: "claude-opus" }, catalog: CATALOG, requested: "claude-haiku" })).toMatchObject({ ok: true, model: "claude-haiku" })
    for (const id of ["claude-haiku-5-5", "gpt-5.2-mini", "deepseek:deepseek-chat", "gemini-3.0-flash", "codex:gpt-6-luna"]) expect(isCheapReaderModel(id)).toBe(true)
    for (const id of ["claude-opus", "claude-sonnet", "gpt-6-sol", "gpt-6-terra", "deepseek-reasoner", "gemini-3.0-pro"]) expect(isCheapReaderModel(id)).toBe(false)
  })
})

/** Reader children that answer every group of their prompt, recording prompts and how many ran at once. */
function readerKids() {
  const prompts: string[] = []
  let running = 0
  let most = 0
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      if (purpose !== "read") throw new Error(`unexpected ${purpose}`)
      prompts.push(prompt)
      running++; most = Math.max(most, running)
      await Bun.sleep(5)
      running--
      const ids = [...prompt.matchAll(/<group id="(g\d+)">/g)].map((match) => match[1])
      return { text: JSON.stringify({ groups: ids.map((id) => ({ id, contains: "training history per epoch", schema: "run parameters and history[epoch, lr, loss, train_acc, val_acc]", rarities: [] })) }), tokens: { input: 3_000, output: 200, cached: 1_000 } }
    },
    async close() {},
  })
  return { factory, prompts, most: () => most }
}

describe("readGroups", () => {
  /** Six experiments whose records are wide lines: each group's excerpt is large, so they need several reader calls. */
  const wide = (seed: number) => Array.from({ length: 300 }, (_, epoch) => JSON.stringify({ seed, epoch, values: Array.from({ length: 30 }, (_, index) => (epoch * 31 + index) / 7) })).join("\n") + "\n"
  const groups = () => groupFiles({ data: triageFiles(Array.from({ length: 6 }, (_, index) => fileOf(`results/exp${index}/run.jsonl`, wide(index)))).data })

  test("a source on a model off the cheap list is never called: every group gets the local summary", async () => {
    const kids = readerKids()
    const read = await readGroups({ groups: groups(), source: { ok: true, model: "claude-opus", factory: kids.factory }, parallel: 2, allowance: Number.POSITIVE_INFINITY })
    expect(kids.prompts).toEqual([])
    expect(read.byLocal).toBe(6)
    expect(read.reasons.join(" ")).toContain("claude-opus is not a cheap reader model")
  })

  test("no cheap model: local summaries, no call", async () => {
    const read = await readGroups({ groups: groups(), source: { ok: false, reason: "no cheap model" }, parallel: 3, allowance: Number.POSITIVE_INFINITY })
    expect([read.calls, read.byModel, read.byLocal]).toEqual([0, 0, 6])
    expect([...read.summaries.values()].every((summary) => summary.by === "local")).toBe(true)
  })

  test("the readers' share of the cap is checked before each call; the rest is summarized locally", async () => {
    const kids = readerKids()
    const batches = batchGroups(groups())
    expect(batches.length).toBeGreaterThan(1)
    // Room for the first call's bound only: after it, what is left cannot carry another.
    const first = Math.ceil(batches[0]!.tokens * 1.5) + READER_TURN_OVERHEAD
    const read = await readGroups({ groups: groups(), source: { ok: true, model: "claude-haiku", factory: kids.factory }, parallel: 1, allowance: first + 1_000 })
    expect(read.calls).toBe(1)
    expect(read.byModel + read.byLocal).toBe(6)
    expect(read.byLocal).toBeGreaterThan(0)
    expect(read.reasons).toContain("the readers' share of the review's token cap is spent")
  })

  test("the tier sets how many read at once: minimalist 1, balanced 2, full 3", async () => {
    expect(READERS_BY_TIER).toEqual({ minimalist: 1, balanced: 2, full: 3 })
    for (const parallel of [1, 2, 3]) {
      const kids = readerKids()
      const source: ReaderSource = { ok: true, model: "claude-haiku", factory: kids.factory }
      await readGroups({ groups: groups(), source, parallel, allowance: Number.POSITIVE_INFINITY })
      expect(kids.most()).toBe(parallel)
    }
  })
})

/** A repository shaped like a benchmark PR: a small code change and many result JSON files. */
async function benchmarkRepository({ config = "enabled: true\n", files = 30 }: { config?: string; files?: number } = {}) {
  const dir = temp()
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", config)
  write(dir, "tools/train.py", "def train(epochs):\n    return epochs\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "tools/train.py", "def train(epochs):\n    return epochs * 2\n")
  for (let index = 0; index < files; index++) write(dir, `benchmarks/experiments/results/train_gap/binary_s${index}.json`, result(index, 300))
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "results")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

/** Review children: the review pass answers with no findings and records its prompt. */
function reviewKids() {
  const prompts: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      if (purpose === "read") throw new Error("the review's own factory never runs a reader")
      prompts.push(prompt)
      return { text: JSON.stringify({ summary: "Doubles the epochs.", findings: [] }), tokens: { input: 5_000, output: 300 } }
    },
    async close() {},
  })
  return { factory, prompts }
}

describe("runPrReview with readers (a benchmark PR: many result JSON files, little code)", () => {
  test("the review pass gets the code diff and the readers' summaries, never the JSON numbers; readers run on the cheap model and are accounted", async () => {
    const repo = await benchmarkRepository()
    const review = reviewKids()
    const readers = readerKids()
    const accounted: Array<{ purpose: string; input: number }> = []
    const asked: Array<string | undefined> = []
    const run = await runPrReview({
      repo: "acme/bench", number: 23, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: review.factory, publish: false,
      readers: { tier: "full", source: (requested) => { asked.push(requested); return { ok: true, model: "claude-haiku", factory: readers.factory } } },
      account: ({ purpose, tokens }) => accounted.push({ purpose, input: tokens.input }),
    })
    expect(run.status).toBe("reviewed")
    const main = review.prompts[0]!
    expect(main).toContain("return epochs * 2")
    expect(main).not.toContain("\"train_acc\": 41.18")
    expect(main).toContain("Reader summary (claude-haiku, unverified)")
    expect(main).toContain("training history per epoch")
    expect(main).toContain("diff --git a/benchmarks/experiments/results/train_gap/binary_s9.json")
    expect(readers.prompts.join("\n")).toContain("\"train_acc\": 41.18")
    expect(asked).toEqual([undefined])
    // One group of 30 files is one reader call, accounted as its own purpose (cheap-model tokens show apart from the review pass).
    expect(readers.prompts).toHaveLength(1)
    expect(accounted.filter((entry) => entry.input === 3_000).map((entry) => entry.purpose)).toEqual(["read"])
    const notes = run.info!.notes.join("\n")
    expect(notes).toContain("Readers: 30 files went to readers instead of the review pass whole: 30 files by claude-haiku (1 call, up to 3 at once")
    expect(run.checkpoint?.readers?.[0]?.paths).toHaveLength(30)
  })

  test("readers.model naming a large model is refused with a note and the automatic cheap pick is used", async () => {
    const repo = await benchmarkRepository({ config: "enabled: true\nreaders: { model: claude-opus, parallel: 1 }\n", files: 4 })
    const readers = readerKids()
    const asked: Array<string | undefined> = []
    const run = await runPrReview({
      repo: "acme/bench", number: 23, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: reviewKids().factory, publish: false,
      readers: { tier: "balanced", source: (requested) => { asked.push(requested); return { ok: true, model: "claude-haiku", factory: readers.factory } } },
    })
    expect(asked).toEqual([undefined])
    expect(run.info!.notes.join("\n")).toContain("readers.model claude-opus was refused: it is not a cheap reader model")
  })

  test("without a cheap model the data files get a local summary and no model reads them", async () => {
    const repo = await benchmarkRepository({ files: 5 })
    const review = reviewKids()
    const run = await runPrReview({
      repo: "acme/bench", number: 23, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: review.factory, publish: false,
      readers: { tier: "balanced", source: () => ({ ok: false, reason: "claude-opus's provider has no cheap reader model" }) },
    })
    expect(review.prompts[0]).toContain("Reader summary (local scan, no model, unverified)")
    expect(review.prompts[0]).toContain("keys: model, seed, epochs")
    expect(review.prompts[0]).not.toContain("\"train_acc\": 41.18")
    expect(run.info!.notes.join("\n")).toContain("5 files by a local summary without a model (claude-opus's provider has no cheap reader model)")
  })

  test("readers.enabled false sends every diff to the review pass as before", async () => {
    const repo = await benchmarkRepository({ config: "enabled: true\nreaders: { enabled: false }\n", files: 2 })
    const review = reviewKids()
    await runPrReview({ repo: "acme/bench", number: 23, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: review.factory, publish: false })
    expect(review.prompts[0]).toContain("\"train_acc\": 41.18")
    expect(review.prompts[0]).not.toContain("Reader summary")
  })
})
