import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseRunArgs } from "../run"
import { runDirFor, runMatrix, runOne, type RunOptions } from "../lib/runner"
import { loadTask, selectTasks } from "../lib/tasks"
import type { RunRecord } from "../lib/types"
import { buildReport, loadRecords, renderReport } from "../lib/report"
import { tempDir } from "./helpers"

function options(outDir: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return { outDir, effort: "medium", timeoutScale: 1, adapterOptions: {}, keepWork: false, resume: false, ...overrides }
}

describe("runner with the fake adapter", () => {
  test("a solved run: workspace measured, check green, usage and transcript recorded", async () => {
    const out = tempDir("out")
    const record = await runOne({ harness: "fake", model: "m1", task: loadTask("bug-offbyone"), repeat: 1 }, options(out, { adapterOptions: { fakeSolve: "all" } }))
    expect(record.solved).toBe(true)
    expect(record.outcome).toBe("solved")
    expect(record.check.exitCode).toBe(0)
    expect(record.diff.filesChanged).toBe(1)
    expect(record.diff.insertions).toBe(1)
    expect(record.diff.deletions).toBe(1)
    expect(record.usage.inputTokens).toBeGreaterThan(0)
    const dir = runDirFor(out, "m1", "fake", "bug-offbyone", 1)
    expect(existsSync(path.join(dir, "result.json"))).toBe(true)
    expect(readFileSync(path.join(dir, "work.diff"), "utf8")).toContain("paginate.ts")
    expect(record.transcript).toBe(path.join("m1", "fake", "bug-offbyone", "r1", "transcript.jsonl"))
    expect(JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")).taskId).toBe("bug-offbyone")
  })

  test("an unsolved run: the agent changed nothing, the check is red", async () => {
    const out = tempDir("out")
    const record = await runOne({ harness: "fake", model: "m1", task: loadTask("bug-offbyone"), repeat: 1 }, options(out, { adapterOptions: { fakeSolve: "none" } }))
    expect(record.solved).toBe(false)
    expect(record.outcome).toBe("failed")
    expect(record.check.exitCode).not.toBe(0)
    expect(record.diff.filesChanged).toBe(0)
  })

  test("each run starts from a fresh copy: one run's changes never reach the next", async () => {
    const out = tempDir("out")
    const task = loadTask("bug-offbyone")
    const solved = await runOne({ harness: "fake", model: "m1", task, repeat: 1 }, options(out, { adapterOptions: { fakeSolve: "all" } }))
    const untouched = await runOne({ harness: "fake", model: "m1", task, repeat: 2 }, options(out, { adapterOptions: { fakeSolve: "none" } }))
    expect(solved.solved).toBe(true)
    expect(untouched.solved).toBe(false)
  })

  test("a harness that hangs is cut off by the timeout and recorded as such", async () => {
    const out = tempDir("out")
    // 600 s * 0.0002 = 120 ms
    const record = await runOne({ harness: "fake", model: "m1", task: loadTask("bug-offbyone"), repeat: 1 }, options(out, { timeoutScale: 0.0002, adapterOptions: { fakeMode: "hang" } }))
    expect(record.timedOut).toBe(true)
    expect(record.outcome).toBe("timeout")
    expect(record.solved).toBe(false)
  })

  test("a harness that crashes before doing anything is a harness error, not a failed attempt", async () => {
    const out = tempDir("out")
    const record = await runOne({ harness: "fake", model: "m1", task: loadTask("bug-offbyone"), repeat: 1 }, options(out, { adapterOptions: { fakeMode: "crash" } }))
    expect(record.outcome).toBe("error")
    expect(record.exitCode).toBe(1)
  })

  test("an adapter that throws still leaves a result and cleans up", async () => {
    const out = tempDir("out")
    let cleaned = false
    const record = await runOne(
      { harness: "fake", model: "m1", task: loadTask("bug-offbyone"), repeat: 1 },
      options(out, {
        adapterFactory: async () => ({
          name: "fake",
          prepare: async () => {},
          run: async () => { throw new Error("boom") },
          cleanup: async () => { cleaned = true },
          describe: async () => ({}),
        }),
      }),
    )
    expect(record.outcome).toBe("error")
    expect(record.notes.join(" ")).toContain("boom")
    expect(cleaned).toBe(true)
  })

  test("the agent's cwd is a git repo with the base commit, and the temp tree is gone afterwards", async () => {
    const out = tempDir("out")
    let seenCwd = ""
    let gitDirExisted = false
    await runOne(
      { harness: "fake", model: "m1", task: loadTask("bug-boundary"), repeat: 1 },
      options(out, {
        adapterFactory: async () => ({
          name: "fake",
          prepare: async () => {},
          run: async (_prompt, cwd) => {
            seenCwd = cwd
            gitDirExisted = existsSync(path.join(cwd, ".git"))
            expect(readdirSync(cwd).sort()).toEqual([".git", "package.json", "src", "test"])
            return { exitCode: 0, timedOut: false, transcriptPath: null, usage: { inputTokens: null, cachedReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, modelCalls: null, toolCalls: null, failedToolCalls: null, compactions: null, turnMs: null }, agentMs: 1, notes: [] }
          },
          cleanup: async () => {},
          describe: async () => ({}),
        }),
      }),
    )
    expect(gitDirExisted).toBe(true)
    expect(existsSync(seenCwd)).toBe(false)
  })

  test("resume skips a run that already has a result", async () => {
    const out = tempDir("out")
    const task = loadTask("bug-offbyone")
    const first = await runOne({ harness: "fake", model: "m1", task, repeat: 1 }, options(out, { adapterOptions: { fakeSolve: "all" } }))
    const again = await runOne({ harness: "fake", model: "m1", task, repeat: 1 }, options(out, { resume: true, adapterOptions: { fakeSolve: "none" } }))
    expect(again.startedAt).toBe(first.startedAt)
    expect(again.solved).toBe(true)
  })

  test("a matrix over models, tasks and repeats feeds the report", async () => {
    const out = tempDir("out")
    const tasks = selectTasks("bug-offbyone,bug-boundary,feat-lru-ttl")
    const lines: string[] = []
    const records: RunRecord[] = await runMatrix({ harnesses: ["fake"], models: ["m1", "m2"], tasks, repeat: 2 }, options(out, { adapterOptions: { fakeSolve: "bug-offbyone,feat-lru-ttl" }, log: (line) => lines.push(line) }))
    expect(records).toHaveLength(12)
    expect(lines).toHaveLength(12)
    const { records: loaded, skipped } = loadRecords(out)
    expect(skipped).toEqual([])
    expect(loaded).toHaveLength(12)
    const report = buildReport(loaded)
    expect(report.models.map((model) => model.model)).toEqual(["m1", "m2"])
    expect(report.models[0]!.harnesses[0]!.solved).toBe(4)
    expect(report.models[0]!.tasks.find((task) => task.taskId === "bug-boundary")!.outcomes.fake).toBe("FF")
    expect(renderReport(report)).toContain("Model m2")
  }, 120_000)
})

describe("run.ts arguments", () => {
  const base = ["--harness", "fake", "--model", "m", "--tasks", "all", "--out", "/tmp/x"]

  test("defaults: one repeat, medium effort", () => {
    const parsed = parseRunArgs(base)
    expect(parsed.repeat).toBe(1)
    expect(parsed.effort).toBe("medium")
    expect(parsed.taskSpec).toBe("all")
  })

  test("comma lists, resume and engine", () => {
    const parsed = parseRunArgs(["--harness", "mendcode,codex", "--model", "a,b", "--tasks", "x", "--out", "/tmp/x", "--repeat", "3", "--effort", "high", "--resume", "--engine", "faux"])
    expect(parsed.harnesses).toEqual(["mendcode", "codex"])
    expect(parsed.models).toEqual(["a", "b"])
    expect(parsed.repeat).toBe(3)
    expect(parsed.resume).toBe(true)
    expect(parsed.adapterOptions.engine).toBe("faux")
  })

  test("--data-dir and --auth-from become absolute paths for the adapters", () => {
    const parsed = parseRunArgs([...base, "--data-dir", "rel/data", "--auth-from", "rel/auth"])
    expect(path.isAbsolute(parsed.adapterOptions.dataDir!)).toBe(true)
    expect(path.isAbsolute(parsed.adapterOptions.authFrom!)).toBe(true)
  })

  test("--tier reaches the mendcode adapter; without it the adapter keeps its balanced default", () => {
    expect(parseRunArgs([...base, "--tier", "minimalist"]).adapterOptions.tier).toBe("minimalist")
    expect(parseRunArgs(base).adapterOptions.tier).toBeUndefined()
    expect(() => parseRunArgs([...base, "--tier", "huge"])).toThrow("--tier must be")
  })

  test("rejects unknown harnesses, unknown options and bad numbers", () => {
    expect(() => parseRunArgs(["--harness", "pi", "--model", "m", "--tasks", "all", "--out", "/tmp/x"])).toThrow("unknown harness")
    expect(() => parseRunArgs([...base, "--bogus", "1"])).toThrow("unknown option")
    expect(() => parseRunArgs([...base, "--repeat", "0"])).toThrow("--repeat")
    expect(() => parseRunArgs([...base, "--timeout-scale", "-1"])).toThrow("--timeout-scale")
    expect(() => parseRunArgs(["--model", "m", "--tasks", "all", "--out", "/tmp/x"])).toThrow("--harness")
  })
})
