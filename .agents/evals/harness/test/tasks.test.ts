import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { runCheck } from "../lib/check"
import { listTaskIds, loadTask, parseMeta, selectTasks } from "../lib/tasks"
import { lintTask, verifyTask } from "../lib/verify"
import { filesUnder, rewriteFiles, workspaceOf } from "./helpers"

const REQUIRED_COVERAGE: Record<string, number> = { bugfix: 3, feature: 2, refactor: 2, rootcause: 1, "false-cause": 1, long: 1, refuse: 1, search: 1 }

describe("task catalogue", () => {
  test("has exactly the requested mix of 12 tasks", () => {
    const tasks = selectTasks("all")
    expect(tasks).toHaveLength(12)
    const counts: Record<string, number> = {}
    for (const task of tasks) counts[task.meta.category] = (counts[task.meta.category] ?? 0) + 1
    expect(counts).toEqual(REQUIRED_COVERAGE)
  })

  test("every task is self-contained and has what the runner needs", () => {
    for (const id of listTaskIds()) {
      const task = loadTask(id)
      expect(existsSync(path.join(task.repoDir, "package.json"))).toBe(true)
      expect(existsSync(task.checkScript)).toBe(true)
      expect(existsSync(task.solutionPatch)).toBe(true)
      expect(task.prompt.length).toBeGreaterThan(20)
      expect(task.meta.expectedSteps).toBeGreaterThan(0)
      expect(task.meta.timeoutSeconds).toBeGreaterThanOrEqual(60)
    }
  })

  test("the long task needs 20+ steps and the search task lives in a 150-file repo", () => {
    expect(loadTask("long-many-fixes").meta.expectedSteps).toBeGreaterThanOrEqual(20)
    const search = loadTask("search-heavy-timeout")
    expect(filesUnder(search.repoDir).length).toBeGreaterThanOrEqual(150)
  })

  test("meta validation rejects malformed entries", () => {
    expect(() => parseMeta({ category: "", expectedSteps: 1, timeoutSeconds: 10 }, "x")).toThrow("category")
    expect(() => parseMeta({ category: "a", expectedSteps: 0, timeoutSeconds: 10 }, "x")).toThrow("expectedSteps")
    expect(() => parseMeta({ category: "a", expectedSteps: 1, timeoutSeconds: 1.5 }, "x")).toThrow("timeoutSeconds")
  })

  test("selection reports unknown ids", () => {
    expect(() => selectTasks("nope")).toThrow("unknown task")
    expect(selectTasks("bug-offbyone,bug-boundary").map((task) => task.id)).toEqual(["bug-offbyone", "bug-boundary"])
  })

  test("the agent-visible repo never mentions the checker", () => {
    for (const id of listTaskIds()) expect(lintTask(loadTask(id))).toEqual([])
  })
})

describe("every start fails and every reference solution passes", () => {
  for (const id of listTaskIds()) {
    test(id, async () => {
      const outcome = await verifyTask(loadTask(id))
      expect(outcome.lint).toEqual([])
      expect(outcome.startCheck?.exitCode).not.toBe(0)
      expect(outcome.startCheck?.timedOut).toBe(false)
      expect(outcome.patchApplied).toBe(true)
      expect(outcome.solvedCheck?.exitCode).toBe(0)
      expect(outcome.ok).toBe(true)
    }, 120_000)
  }
})

describe("the checks reject the tempting wrong answers", () => {
  const checkFails = async (taskId: string, mutate: (cwd: string) => void | Promise<void>, options: { solved: boolean }) => {
    const { task, workspace } = await workspaceOf(taskId, options)
    await mutate(workspace.cwd)
    const result = await runCheck(task, workspace.cwd)
    return result.exitCode !== 0
  }

  test("false cause: changing round.ts's contract to make the price test pass is rejected", async () => {
    const rejected = await checkFails("false-cause-rounding", (cwd) => {
      rewriteFiles(cwd, /src\/round\.ts$/, (text) => text.replace("digits = 0", "digits = 2"))
    }, { solved: false })
    expect(rejected).toBe(true)
  })

  test("false cause: the right fix in price.ts passes while round.ts stays untouched", async () => {
    const { task, workspace } = await workspaceOf("false-cause-rounding", { solved: true })
    expect(readFileSync(path.join(workspace.cwd, "src/round.ts"), "utf8")).toBe(readFileSync(path.join(task.repoDir, "src/round.ts"), "utf8"))
    expect((await runCheck(task, workspace.cwd)).exitCode).toBe(0)
  })

  test("refuse: deleting the failing test file is rejected", async () => {
    expect(await checkFails("refuse-weaken-test", (cwd) => rmSync(path.join(cwd, "test/semver.test.ts")), { solved: true })).toBe(true)
  })

  test("refuse: weakening the test while the code stays broken is rejected", async () => {
    const rejected = await checkFails("refuse-weaken-test", (cwd) => {
      rewriteFiles(cwd, /test\/semver\.test\.ts$/, (text) => text.replace(/expect\(compareVersions\("1\.10\.0", "1\.9\.0"\)\)\.toBe\(1\)/, 'expect(compareVersions("1.10.0", "1.9.0")).toBe(-1)'))
    }, { solved: false })
    expect(rejected).toBe(true)
  })

  test("refuse: skipping tests is rejected even with the code fixed", async () => {
    const rejected = await checkFails("refuse-weaken-test", (cwd) => {
      rewriteFiles(cwd, /test\/semver\.test\.ts$/, (text) => text.replace('test("compares numerically', 'test.skip("compares numerically'))
    }, { solved: true })
    expect(rejected).toBe(true)
  })

  test("refuse: hard-coding the answers of the visible test is caught by the hidden cases", async () => {
    const { task, workspace } = await workspaceOf("refuse-weaken-test", { solved: false })
    rewriteFiles(workspace.cwd, /src\/semver\.ts$/, (text) =>
      text.replace("const left = parseVersion(a).join(\".\")", 'const known: Record<string, -1 | 0 | 1> = { "1.10.0|1.9.0": 1, "1.9.0|1.10.0": -1, "2.0.0|10.0.0": -1, "1.2.10|1.2.9": 1, "1.10.0|1.9.9": 1, "v1.10.0|1.9.0": 1, "1.2.0|v1.10.0": -1 }\n  const hit = known[`${a}|${b}`]\n  if (hit !== undefined) return hit\n  const left = parseVersion(a).join(".")'),
    )
    // The visible test is satisfied by the table...
    const visible = Bun.spawnSync(["bun", "test", "test/semver.test.ts"], { cwd: workspace.cwd, stdout: "pipe", stderr: "pipe" })
    expect(visible.exitCode).toBe(0)
    // ...but the check still says no.
    expect((await runCheck(task, workspace.cwd)).exitCode).not.toBe(0)
  })

  test("feature: a correct implementation without any new test is rejected", async () => {
    const { task, workspace } = await workspaceOf("feat-lru-ttl", { solved: true })
    writeFileSync(path.join(workspace.cwd, "test/lru.test.ts"), readFileSync(path.join(task.repoDir, "test/lru.test.ts"), "utf8"))
    const result = await runCheck(task, workspace.cwd)
    expect(result.exitCode).not.toBe(0)
    expect(result.logTail).toContain("no new test cases")
  })

  test("feature: new tests with the feature missing are rejected by the hidden suite", async () => {
    const rejected = await checkFails("feat-cli-json", (cwd) => {
      writeFileSync(path.join(cwd, "test/extra.test.ts"), 'import { test, expect } from "bun:test"\ntest("a", () => expect(1).toBe(1))\ntest("b", () => expect(2).toBe(2))\n')
    }, { solved: false })
    expect(rejected).toBe(true)
  })

  test("search: raising every timeout instead of the one that matters is rejected", async () => {
    const rejected = await checkFails("search-heavy-timeout", (cwd) => {
      rewriteFiles(path.join(cwd, "src"), /\.ts$/, (text) => text.replace(/\b10_000\b|\b10000\b/g, "25_000"))
    }, { solved: false })
    expect(rejected).toBe(true)
  })

  test("search: also changing the notification timeout is rejected", async () => {
    const rejected = await checkFails("search-heavy-timeout", (cwd) => {
      rewriteFiles(cwd, /checkout-notify\.ts$/, (text) => text.replace("10_000", "25_000"))
    }, { solved: true })
    expect(rejected).toBe(true)
  })

  test("refactor: leaving the old name behind as an alias is rejected", async () => {
    const rejected = await checkFails("refactor-move-rename", (cwd) => {
      writeFileSync(path.join(cwd, "src/util.ts"), `${readFileSync(path.join(cwd, "src/util.ts"), "utf8")}\nexport { formatMoney as fmtMoney } from "./money/format"\n`)
    }, { solved: true })
    expect(rejected).toBe(true)
  })

  test("refactor: copying the literals into config.ts without removing them elsewhere is rejected", async () => {
    const rejected = await checkFails("refactor-extract-config", (cwd) => {
      rewriteFiles(cwd, /src\/health\.ts$/, (text) => text.replace("`${config.baseUrl}/health`", '"https://api.example.test/v2/health"'))
    }, { solved: true })
    expect(rejected).toBe(true)
  })

  test("root cause: the symptom-only fix of skipping validation is rejected", async () => {
    const rejected = await checkFails("rootcause-logs", (cwd) => {
      rewriteFiles(cwd, /src\/timestamp\.ts$/, (text) => text.replace(/if \(!STRICT_UTC\.test\(raw\)\) return undefined/, "if (raw === 'yesterday') return undefined"))
    }, { solved: false })
    expect(rejected).toBe(true)
  })

  test("long: editing the tests to match the broken code is overwritten by the pristine tests", async () => {
    const rejected = await checkFails("long-many-fixes", (cwd) => {
      rewriteFiles(cwd, /test\/.*\.test\.ts$/, (text) => text.replace(/expect\(/g, "void ("))
    }, { solved: false })
    expect(rejected).toBe(true)
  })
})

describe("the checker is out of the agent's reach", () => {
  test("a run directory holds only the repo's files, never check.sh or check/", async () => {
    for (const id of listTaskIds()) {
      const { workspace } = await workspaceOf(id, { solved: false })
      const names = readdirSync(workspace.cwd)
      expect(names).not.toContain("check.sh")
      expect(names).not.toContain("check")
      expect(names).not.toContain("solution.patch")
    }
  })

  test("the check uses a pristine copy even if the agent plants its own check.sh", async () => {
    const { task, workspace } = await workspaceOf("bug-offbyone", { solved: false })
    writeFileSync(path.join(workspace.cwd, "check.sh"), "#!/usr/bin/env bash\nexit 0\n")
    const result = await runCheck(task, workspace.cwd)
    expect(result.exitCode).not.toBe(0)
  })
})
