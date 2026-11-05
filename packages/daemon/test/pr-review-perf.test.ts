import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { canAffectCost, measurePerf, perfOutcome, pruneCache, type PerfRunInput, type PerfRunResult } from "../src/pr-review/perf"
import { runPrReview } from "../src/pr-review/run"

/**
 * The cost phase of a review of the MendCode repository (docs/pr-review.md "Performance of MendCode's own pull requests"): real git in
 * temp directories, a scripted review child, and a fake runner standing in for `scripts/perf-attrib.ts` (no build, no binary).
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-perf-"))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}

/** A repository on main plus a branch that changes `changed`; `name` is the root package's name. */
async function pullRequest({ name = "mendcode", changed }: { name?: string; changed: Record<string, string> }) {
  const dir = temp()
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }))
  mkdirSync(path.join(dir, "scripts"))
  writeFileSync(path.join(dir, "scripts", "perf-attrib.ts"), "// stand-in\n")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  for (const [file, text] of Object.entries(changed)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "change")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

const TABLE = (headline: string) => `| metric | base | cand |\n|---|---|---|\n| ready RSS | 100 MB | 101 MB |\n\n**perf-attrib: ${headline}**`
const RISE = "sube: ready RSS +1 MB (noise 0.2 MB). Causes: module x"
const SAME = "igual o baja"

/** A runner that answers `result` and counts its calls. */
function runner(result: Partial<PerfRunResult>) {
  const calls: PerfRunInput[] = []
  return { calls, run: async (input: PerfRunInput): Promise<PerfRunResult> => { calls.push(input); return { code: 0, out: "", err: "", timedOut: false, ...result } } }
}

function child() {
  const prompts: string[] = []
  const factory: ReviewSessionFactory = async () => ({ async send(prompt) { prompts.push(prompt); return { text: JSON.stringify({ summary: "A change.", findings: [] }), tokens: { input: 10, output: 1 } } }, async close() {} })
  return { prompts, factory }
}
const review = (repo: { dir: string; base: string; head: string }, perf: Parameters<typeof runPrReview>[0]["perf"], kids: ReturnType<typeof child>) =>
  runPrReview({ repo: "MendCode/MendCode", number: 7, directory: repo.dir, base: repo.base, head: repo.head, publish: false, sessionFactory: kids.factory, state: { version: 1, lastHead: undefined, published: {} }, perf } as Parameters<typeof runPrReview>[0])

describe("which files can change what MendCode costs", () => {
  test("code and manifests count; docs, tests and fixtures alone do not", () => {
    expect(canAffectCost("apps/cli/src/ui/app.ts")).toBe(true)
    expect(canAffectCost("packages/daemon/src/daemon.ts")).toBe(true)
    expect(canAffectCost("package.json")).toBe(true)
    expect(canAffectCost("docs/pr-review.md")).toBe(false)
    expect(canAffectCost("apps/cli/test/model-page.test.ts")).toBe(false)
    expect(canAffectCost("packages/daemon/test/fixtures/a.ts")).toBe(false)
    expect(canAffectCost("README.md")).toBe(false)
  })
})

describe("measurePerf", () => {
  test("a repository that is not MendCode is not measured and the runner never starts", async () => {
    const repo = await pullRequest({ name: "shop", changed: { "apps/web/src/a.ts": "export const a = 1\n" } })
    const fake = runner({ out: TABLE(SAME) })
    expect(await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), run: fake.run } })).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  test("a docs-only or test-only diff is skipped", async () => {
    const repo = await pullRequest({ changed: { "docs/a.md": "# a\n", "apps/cli/test/a.test.ts": "export {}\n", "README.md": "x\n" } })
    const fake = runner({ out: TABLE(SAME) })
    expect(await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), run: fake.run } })).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  test("a fork's head is not built or run", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const fake = runner({ out: TABLE(SAME) })
    const outcome = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, fork: true, options: { dir: temp(), run: fake.run } })
    expect(outcome).toMatchObject({ status: "not-measured" })
    expect(fake.calls).toHaveLength(0)
  })

  test("exit 1 with a table is a measured rise; the runner gets the merge base, the head and a cache under the data dir", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const dir = temp()
    const fake = runner({ code: 1, out: TABLE(RISE) })
    const outcome = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir, run: fake.run } })
    expect(outcome).toMatchObject({ status: "measured", rose: true, base: repo.base, head: repo.head })
    expect(fake.calls[0]).toMatchObject({ base: repo.base, head: repo.head, cacheDir: path.join(dir, "cache") })
    expect(readdirSync(path.join(dir, "tmp"))).toEqual([])
  })

  test("a timeout and a failing script are not-measured with the reason", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const timeout = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), timeoutMs: 120_000, run: runner({ code: null, timedOut: true }).run } })
    expect(timeout).toEqual({ status: "not-measured", reason: "perf-attrib did not finish in 2 minutes" })
    const failed = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), run: runner({ code: 2, err: "build failed in base\n" }).run } })
    expect(failed).toEqual({ status: "not-measured", reason: "perf-attrib failed (exit 2): build failed in base" })
    const thrown = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), run: async () => { throw new Error("spawn bun ENOENT") } } })
    expect(thrown).toMatchObject({ status: "not-measured", reason: expect.stringContaining("spawn bun ENOENT") })
  })

  test("without bun the phase says so", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const outcome = await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir: temp(), hasBun: () => false } })
    expect(outcome).toMatchObject({ status: "not-measured", reason: expect.stringContaining("bun is not installed") })
  })
})

describe("perfOutcome", () => {
  test("exit 0 without the headline is a failure, not a table", () => {
    expect(perfOutcome({ result: { code: 0, out: "garbage", err: "", timedOut: false }, from: "a", head: "b", timeoutMs: 1 }).status).toBe("not-measured")
  })
})

describe("the build cache", () => {
  test("keeps the newest builds, drops the old and the abandoned partial ones, and a reuse refreshes a build", () => {
    const cacheDir = temp()
    const now = 10 * 24 * 60 * 60_000
    const put = (name: string, ageMs: number) => { const file = path.join(cacheDir, name); writeFileSync(file, "x"); utimesSync(file, new Date(now - ageMs), new Date(now - ageMs)) }
    put("a-darwin-arm64", 60_000); put("b-darwin-arm64", 120_000); put("c-darwin-arm64", 180_000)
    put("old-darwin-arm64", 5 * 24 * 60 * 60_000); put("d-darwin-arm64.part-1", 2 * 60 * 60_000); put("e-darwin-arm64.part-2", 60_000)
    pruneCache({ cacheDir, now, keep: 2 })
    expect(readdirSync(cacheDir).sort()).toEqual(["a-darwin-arm64", "b-darwin-arm64", "e-darwin-arm64.part-2"])
  })

  test("a second review of the same commits hands the runner the same cache with the builds still there", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const dir = temp()
    const seen: boolean[] = []
    const run = async (input: PerfRunInput): Promise<PerfRunResult> => {
      const built = path.join(input.cacheDir, `${input.head}-test`)
      seen.push(existsSync(built))
      writeFileSync(built, "binary")
      return { code: 0, out: TABLE(SAME), err: "", timedOut: false }
    }
    await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir, run } })
    await measurePerf({ directory: repo.dir, base: repo.base, head: repo.head, git: gitRun, options: { dir, run } })
    expect(seen).toEqual([false, true])
  })
})

describe("the review of a MendCode pull request", () => {
  test("the table goes to the model and the review details; no rise, no finding", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const kids = child()
    const run = await review(repo, { dir: temp(), run: runner({ code: 0, out: TABLE(SAME) }).run }, kids)
    expect(kids.prompts[0]).toContain("<perf_attrib>")
    expect(kids.prompts[0]).toContain("ready RSS")
    expect(run.info?.perf).toContain("| ready RSS | 100 MB | 101 MB |")
    expect(run.outcome?.result.findings ?? []).toEqual([])
  })

  test("a measured rise is a critical performance finding on the changed line, cited with the numbers", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const kids = child()
    const run = await review(repo, { dir: temp(), run: runner({ code: 1, out: TABLE(RISE) }).run }, kids)
    const finding = run.outcome?.result.findings.find((item) => item.category === "performance")
    expect(finding).toMatchObject({ severity: "critical", path: "apps/cli/src/a.ts", line: 1 })
    expect(finding?.summary).toContain("ready RSS +1 MB")
    expect(run.info?.perf).toContain("sube")
  })

  test("a timeout leaves the review whole, with a note that performance was not measured and why", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const kids = child()
    const run = await review(repo, { dir: temp(), timeoutMs: 60_000, run: runner({ code: null, timedOut: true }).run }, kids)
    expect(run.status).not.toBe("failed")
    expect(run.info?.notes.some((note) => note.startsWith("Performance was not measured: perf-attrib did not finish"))).toBe(true)
    expect(kids.prompts[0]).toContain("NOT measured")
    expect(run.info?.perf).toBeUndefined()
  })

  test("without the phase configured (other repositories, or the setting off) nothing about performance reaches the model", async () => {
    const repo = await pullRequest({ changed: { "apps/cli/src/a.ts": "export const a = 1\n" } })
    const kids = child()
    const run = await review(repo, undefined, kids)
    expect(kids.prompts[0]).not.toContain("perf_attrib")
    expect(run.info?.perf).toBeUndefined()
  })
})
