import { expect, test } from "bun:test"
import path from "node:path"

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string>; "continue-on-error"?: unknown }
type Job = { needs?: string | string[]; steps: Step[]; permissions?: Record<string, string>; "timeout-minutes"?: number; strategy?: { matrix: { include: { target: string; runner: string; suffix: string }[] } } }
type Workflow = { on: { push: { tags: string[] }; workflow_dispatch: { inputs: { tag: { required: boolean } } } }; permissions: Record<string, string>; jobs: Record<string, Job> }
const workflowsDir = path.join(import.meta.dir, "../.github/workflows")
const gateFile = path.join(import.meta.dir, "../.github/actions/checks/action.yml")
const source = await Bun.file(path.join(workflowsDir, "release.yml")).text()
const workflow = Bun.YAML.parse(source) as Workflow
const gateSource = await Bun.file(gateFile).text()
const gate = Bun.YAML.parse(gateSource) as { runs: { using: string; steps: Step[] } }
const ciSource = await Bun.file(path.join(workflowsDir, "ci.yml")).text()
const ci = Bun.YAML.parse(ciSource) as Workflow & { on: { push: { branches: string[] }; pull_request: unknown; workflow_dispatch: unknown } }
const LOCAL_GATE = "./.github/actions/checks"

/** Every `uses:` of a workflow or action is pinned to a commit with its version in a comment; the one local action is the shared gate. */
function expectPinned(steps: Step[], text: string) {
  for (const step of steps) {
    if (!step.uses || step.uses === LOCAL_GATE) continue
    expect(step.uses).toMatch(/^[\w/-]+@[0-9a-f]{40}$/)
    expect(text).toMatch(new RegExp(`${step.uses} # v[0-9]`))
  }
}

test("release YAML has five native targets, a single test gate and scoped write permissions", () => {
  expect(workflow.on.push.tags).toContain("v*")
  expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true)
  expect(workflow.permissions).toEqual({ contents: "read" })
  const { checks, build, release } = workflow.jobs
  // The gate is the shared action: exactly one use of it in the release workflow, and in it exactly one test step, which runs the parts script.
  expect(checks!.steps.filter((step) => step.uses === LOCAL_GATE)).toHaveLength(1)
  expect(checks!.steps.filter((step) => step.run?.includes("bun test"))).toHaveLength(0)
  expect(gate.runs.steps.filter((step) => step.run?.includes("test-shards.sh"))).toHaveLength(1)
  expect(gate.runs.steps.filter((step) => step.run?.includes("bun test"))).toHaveLength(0)
  expect(gate.runs.steps.some((step) => step.run?.includes("bun run typecheck"))).toBe(true)
  // A failing part must fail the release: nothing in the gate or the job may swallow a failure.
  for (const step of [...gate.runs.steps, ...checks!.steps]) expect(step["continue-on-error"]).toBeUndefined()
  expect(gateSource).not.toContain("|| true")
  expect(gate.runs.steps.find((step) => step.run?.includes("test-shards.sh"))?.env).toMatchObject({ MENDCODE_TEST_TIME_SCALE: "3", MENDCODE_REQUIRE_TOOLS: "rg,zsh" })
  expect(gateSource).toContain("--config.minimumReleaseAge=10080")
  expect(build!.needs).toEqual(["checks", "notes"])
  expect(release!.needs).toEqual(["checks", "notes", "build"])
  const matrix = build!.strategy!.matrix.include
  expect(matrix.map((row) => row.target).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"])
  expect(matrix.find((row) => row.target === "windows-x64")?.suffix).toBe(".exe")
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "release") expect(job.permissions).toBeUndefined()
    expectPinned(job.steps, source)
  }
  expectPinned(gate.runs.steps, gateSource)
  expect(release!.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" })
  expect(release!.steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"))?.if).toBe("${{ !github.event.repository.private }}")
  expect(release!.steps.some((step) => step.if === "github.event.repository.private" && step.run?.includes("skipped"))).toBe(true)
  expect(source).toContain('test "$WORKFLOW_REF" = "refs/tags/$TAG"')
  expect(source).toContain('MENDCODE_TEST_BINARY:')
  expect(source).toContain('MENDCODE_REQUIRE_COMPILE: "1"')
  expect(source).toContain("--config.minimumReleaseAge=10080")
  expect(source).toContain('bun scripts/release-index.ts "$TAG" "$GITHUB_REPOSITORY" dist')
  expect(release!.steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"))?.with?.["subject-path"]).toContain("dist/release-index.json")
  expect(source).toContain("-nightly\\.[0-9]{8}")
})

test("the CI workflow runs the same gate on Linux for pull requests and on demand, not for a push, and only the gate sets the CI time scale", () => {
  // Every tag runs the gate once in release.yml; a push to main running it again was the second run per version.
  expect("push" in ci.on).toBe(false)
  expect("pull_request" in ci.on).toBe(true)
  expect("workflow_dispatch" in ci.on).toBe(true)
  expect(ci.permissions).toEqual({ contents: "read" })
  expect(Object.keys(ci.jobs)).toEqual(["checks"])
  const job = ci.jobs.checks!
  expect(job.steps.filter((step) => step.uses === LOCAL_GATE)).toHaveLength(1)
  expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(20)
  expectPinned(job.steps, ciSource)
  expect(ciSource).toContain("ubuntu-24.04")
  // The scale loosens time budgets for a slow shared runner; it must not leak into the smoke of the release binaries or any local run.
  for (const text of [source, ciSource]) expect(text).not.toContain("MENDCODE_TEST_TIME_SCALE")
  expect(gateSource.match(/MENDCODE_TEST_TIME_SCALE/g)).toHaveLength(1)
  // One time limit for both uses of the gate, long enough that a hung part is cut by its own limit (and reported) before the job is cancelled:
  // the part limit plus about 15 minutes for the other three parts and the setup.
  const partSeconds = Number(gate.runs.steps.find((step) => step.run?.includes("test-shards.sh"))?.env?.MENDCODE_TEST_PART_SECONDS)
  expect(partSeconds).toBeGreaterThan(0)
  expect(job["timeout-minutes"]).toBe(workflow.jobs.checks!["timeout-minutes"])
  expect(workflow.jobs.checks!["timeout-minutes"]! * 60).toBeGreaterThanOrEqual(partSeconds + 15 * 60)
})

test("the gate keeps what it needs to explain a run that ends without a failing test: logs whatever the outcome, a heartbeat, a session per part", () => {
  const tests = gate.runs.steps.find((step) => step.run?.includes("test-shards.sh"))!
  expect(tests.env).toMatchObject({ MENDCODE_TEST_HEARTBEAT_SECONDS: "20", MENDCODE_TEST_NEW_SESSION: "1" })
  // A cancelled job has failure() false: the upload and the memory report must not wait for one.
  const upload = gate.runs.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
  expect(upload?.if).toBe("always()")
  expect(gate.runs.steps.find((step) => step.run?.includes("dmesg"))?.if).toBe("always()")
})

test("the Linux release builds install bubblewrap before the script-host smoke, which must not skip", () => {
  const { build } = workflow.jobs
  const names = build!.steps.map((step) => (step as { name?: string }).name ?? "")
  const bubblewrap = build!.steps.findIndex((step) => step.run?.includes("apt-get install") && step.run.includes("bubblewrap"))
  const smoke = build!.steps.findIndex((step) => step.run?.includes("bun run test:compiled"))
  expect(bubblewrap).toBeGreaterThanOrEqual(0)
  expect(bubblewrap).toBeLessThan(smoke)
  expect(build!.steps[bubblewrap]!.if).toBe("runner.os == 'Linux'")
  expect(names[smoke]).toContain("Smoke the exact release binary")
  expect(build!.steps[smoke]!.env).toMatchObject({ MENDCODE_REQUIRE_COMPILE: "1" })
})

test("every release and gate shell block and the POSIX installer parse without execution", () => {
  const bash = Bun.which("bash")
  expect(bash).not.toBeNull()
  const blocks = [...Object.values(workflow.jobs).flatMap((job) => job.steps), ...Object.values(ci.jobs).flatMap((job) => job.steps), ...gate.runs.steps]
  for (const step of blocks) {
    if (!step.run) continue
    const result = Bun.spawnSync([bash!, "-n"], { stdin: new TextEncoder().encode(step.run), stderr: "pipe" })
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
  }
  for (const script of ["install.sh", "test-shards.sh"]) {
    const checked = Bun.spawnSync(["sh", "-n", path.join(import.meta.dir, script)], { stderr: "pipe" })
    expect({ script, code: checked.exitCode, stderr: checked.stderr.toString() }).toEqual({ script, code: 0, stderr: "" })
  }
})

const nightlySource = await Bun.file(path.join(workflowsDir, "nightly.yml")).text()
const nightly = Bun.YAML.parse(nightlySource) as { on: { schedule: { cron: string }[]; workflow_dispatch: unknown }; permissions: Record<string, string>; jobs: Record<string, Job> }

test("the nightly workflow runs daily, writes only from its one job, and its shell blocks parse", () => {
  expect(nightly.on.schedule).toHaveLength(1)
  expect(nightly.on.workflow_dispatch).toBeDefined()
  expect(nightly.permissions).toEqual({ contents: "read" })
  expect(nightly.jobs.tag!.permissions).toEqual({ contents: "write", actions: "write" })
  expectPinned(nightly.jobs.tag!.steps, nightlySource)
  for (const step of nightly.jobs.tag!.steps) {
    if (!step.run) continue
    const result = Bun.spawnSync([Bun.which("bash")!, "-n"], { stdin: new TextEncoder().encode(step.run), stderr: "pipe" })
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
  }
})

/** Runs the tagging step in a throwaway repository with a `gh` that only logs its arguments. */
function tagStep(setup: (git: (...args: string[]) => void) => void) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } = require("node:fs") as typeof import("node:fs")
  const dir = mkdtempSync(path.join(require("node:os").tmpdir(), "mendcode-nightly-"))
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  const log = path.join(dir, "gh.log")
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`)
  chmodSync(path.join(bin, "gh"), 0o755)
  const repo = path.join(dir, "repo")
  mkdirSync(path.join(repo, "apps/cli"), { recursive: true })
  writeFileSync(path.join(repo, "apps/cli/package.json"), '{\n  "name": "mendcode",\n  "version": "0.0.1-dev",\n  "private": true\n}\n')
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", ...args], { cwd: repo, env }); if (result.exitCode !== 0) throw new Error(result.stderr.toString()) }
  git("init", "-q")
  git("add", ".")
  git("commit", "-q", "-m", "first")
  setup(git)
  const script = nightly.jobs.tag!.steps.find((step) => step.run?.includes("gh workflow run"))!.run!
  const result = Bun.spawnSync([Bun.which("bash")!, "-e", "-c", script], { cwd: repo, env: { ...env, RUN: "42", GITHUB_REPOSITORY: "MendCode/MendCode" }, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), gh: existsSync(log) ? readFileSync(log, "utf8") : "" }
}

test("a nightly takes the patch after the newest stable, or the package version before one, and is dispatched on its own tag", () => {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const first = tagStep(() => {})
  expect(first.code).toBe(0)
  expect(first.gh).toContain(`-f ref=refs/tags/v0.0.1-nightly.${today}.42`)
  expect(first.gh).toContain(`workflow run release.yml --repo MendCode/MendCode --ref v0.0.1-nightly.${today}.42 -f tag=v0.0.1-nightly.${today}.42`)
  const after = tagStep((git) => { git("tag", "v0.0.1-beta.7"); git("tag", "v0.0.1"); git("commit", "-q", "--allow-empty", "-m", "next") })
  expect(after.gh).toContain(`--ref v0.0.2-nightly.${today}.42`)
})

test("a run number a nightly of the same day already holds is skipped, not reused", () => {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const taken = tagStep((git) => { git("tag", `v0.0.1-nightly.${today}.42`); git("tag", `v0.0.1-nightly.${today}.43`); git("commit", "-q", "--allow-empty", "-m", "next") })
  expect(taken.code).toBe(0)
  expect(taken.gh).toContain(`-f ref=refs/tags/v0.0.1-nightly.${today}.44`)
  expect(taken.gh).toContain(`--ref v0.0.1-nightly.${today}.44 -f tag=v0.0.1-nightly.${today}.44`)
})

test("a release's title and notes come from scripts/release-notes.ts in a job beside the gate, never from GitHub's generated notes", () => {
  const { notes, build, release } = workflow.jobs
  expect(build!.needs).toEqual(["checks", "notes"])
  expect(release!.needs).toEqual(["checks", "notes", "build"])
  expectPinned(notes!.steps, source)
  expect(notes!.steps[0]!.with).toMatchObject({ "fetch-depth": 0, "fetch-tags": true, "persist-credentials": false })
  const write = notes!.steps.find((step) => step.run?.includes("scripts/release-notes.ts"))!.run!
  expect(write).toContain("--out notes/notes.md --title-out notes/title.txt")
  const create = release!.steps.find((step) => step.run?.includes("gh release create"))!.run!
  expect(create).toContain('--notes-file "$RUNNER_TEMP/notes/notes.md"')
  expect(create).toContain('--title "$(cat "$RUNNER_TEMP/notes/title.txt")"')
  expect(source).not.toContain("--generate-notes")
})

test("main that already has a nightly is not tagged again", () => {
  const again = tagStep((git) => git("tag", "v0.0.2-nightly.20261027.41"))
  expect(again.code).toBe(0)
  expect(again.out).toContain("already has a nightly")
  expect(again.gh).toBe("")
})
