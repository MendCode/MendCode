import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { PROGRAM_NAME } from "@mendcode/program"
import type { ModelInfo } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createGithub, githubHostedWorkflow, hostedNoSecretLine, HOSTED_WORKFLOW_FILE } from "../src/github"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { ACTIONS_BOT, asksForReview, HOSTED_CHECKS_SKIPPED, hostedReview } from "../src/pr-review/hosted"
import type { GhCall } from "../src/pr-review/publish"
import { fakeGithub } from "./github-fake"

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const SHA = "0123456789abcdef".repeat(4)
const pinned = { model: "openai/gpt-6-luna", release: "v0.4.0", sha256: SHA }

type Step = { uses?: string; name?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }
type Workflow = { on: Record<string, { types: string[] }>; permissions: Record<string, string>; jobs: { review: { "runs-on": string; if: string; steps: Step[] } } }
const parsed = () => Bun.YAML.parse(githubHostedWorkflow(pinned)) as Workflow

describe("hosted workflow", () => {
  test("the YAML for openai/gpt-6-luna is stable", () => {
    expect(githubHostedWorkflow(pinned)).toMatchSnapshot()
  })
  test("pull_request (never pull_request_target) and comments, ubuntu-latest, least permissions, a pinned and checked installer", () => {
    const yaml = githubHostedWorkflow(pinned)
    const workflow = parsed()
    expect(yaml).not.toContain("pull_request_target")
    expect(workflow.on).toEqual({ pull_request: { types: ["opened", "synchronize", "ready_for_review"] }, issue_comment: { types: ["created"] } })
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write" })
    expect(workflow.jobs.review["runs-on"]).toBe("ubuntu-latest")
    expect(workflow.jobs.review.if).toContain("author_association")
    const [checkout, , install, review] = workflow.jobs.review.steps
    expect(checkout!.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false })
    expect(install!.env).toEqual({ MENDCODE_VERSION: "v0.4.0", INSTALLER_SHA256: SHA })
    expect(install!.run).toContain("sha256sum -c -")
    expect(install!.run!.indexOf("sha256sum -c -")).toBeLessThan(install!.run!.indexOf("sh \"$RUNNER_TEMP/install.sh\""))
    expect(review!.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}", MODEL: "openai/gpt-6-luna" })
    expect(review!.run).toContain(`${PROGRAM_NAME} --safe-mode --dir "$RUNNER_TEMP/mc" github run --publish --review`)
  })
  test("the secret is named per provider, and a provider with no API key is refused with the ones that have one", () => {
    expect((Bun.YAML.parse(githubHostedWorkflow({ ...pinned, model: "openrouter/some-model" })) as Workflow).jobs.review.steps[3]!.env).toHaveProperty("OPENROUTER_API_KEY")
    expect(() => githubHostedWorkflow({ ...pinned, model: "ollama/llama" })).toThrow(/no API key.*openai/)
  })

  /** Runs the Review step's script with bash, a fake `mendcode` on PATH, and the given provider key. */
  async function reviewStep(key: string) {
    const dir = temp("hosted-step-"), bin = path.join(dir, "bin"), summary = path.join(dir, "summary.md"), calls = path.join(dir, "calls")
    mkdirSync(bin)
    writeFileSync(path.join(bin, PROGRAM_NAME), `#!/bin/sh\necho "$@" >> "${calls}"\necho "PR review of acme/app#12: published"\n`)
    chmodSync(path.join(bin, PROGRAM_NAME), 0o755)
    const step = parsed().jobs.review.steps[3]!
    const child = Bun.spawn(["bash", "-c", step.run!], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, OPENAI_API_KEY: key, GH_TOKEN: "ghs_test" }, stdout: "pipe", stderr: "pipe" })
    const code = await child.exited
    return { code, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "", calls: existsSync(calls) ? readFileSync(calls, "utf8") : "", dir }
  }
  test("a fork's run has no secret: the job ends successfully with the maintainer line and MendCode never starts", async () => {
    const run = await reviewStep("")
    expect(run.code).toBe(0)
    expect(run.summary.trim()).toBe(hostedNoSecretLine("OPENAI_API_KEY"))
    expect(run.summary).toContain("`@mendcode review`")
    expect(run.calls).toBe("")
  })
  test("with the secret the review runs once and its text lands in the job summary", async () => {
    const run = await reviewStep("sk-test")
    expect(run.code).toBe(0)
    expect(run.calls.trim()).toBe(`--safe-mode --dir ${run.dir}/mc github run --publish --review`)
    expect(run.summary).toContain("PR review of acme/app#12: published")
  })

  test("install --hosted previews, writes only when absent, and refuses an existing file with its path", async () => {
    const directory = temp("hosted-install-")
    const fake = fakeGithub(directory)
    const service = createGithub({ process: fake.process })
    cleanups.push(() => service.dispose())
    const preview = await service.install(directory, { ...pinned, hosted: true })
    expect(preview).toMatchObject({ file: HOSTED_WORKFLOW_FILE, written: false, workflow: githubHostedWorkflow(pinned) })
    expect(preview.blocked.join("\n")).toContain("OPENAI_API_KEY")
    expect(existsSync(path.join(directory, HOSTED_WORKFLOW_FILE))).toBe(false)
    expect(await service.install(directory, { ...pinned, hosted: true, write: true })).toMatchObject({ written: true })
    expect(readFileSync(path.join(directory, HOSTED_WORKFLOW_FILE), "utf8")).toBe(githubHostedWorkflow(pinned))
    await expect(service.install(directory, { ...pinned, model: "openai/gpt-6-terra", hosted: true, write: true })).rejects.toThrow(`Existing workflow ${HOSTED_WORKFLOW_FILE} is preserved`)
    expect(readFileSync(path.join(directory, HOSTED_WORKFLOW_FILE), "utf8")).toBe(githubHostedWorkflow(pinned))
    await expect(service.install(directory, { model: pinned.model, hosted: true })).rejects.toThrow("--release TAG and --sha256 HEX")
  })
})

describe("github run --review", () => {
  async function repository() {
    const dir = temp("hosted-repo-")
    const git = async (...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
    await git("init", "-q", "-b", "main")
    mkdirSync(path.join(dir, ".mendcode"))
    writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\nchecks: [\"bun test\"]\n")
    writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
    await git("add", "-A")
    await git("commit", "-q", "-m", "base")
    const base = await git("rev-parse", "HEAD")
    writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
    await git("commit", "-q", "-am", "feature")
    const head = await git("rev-parse", "HEAD")
    return { dir, base, head }
  }

  /** GitHub as `gh api` sees it with GITHUB_TOKEN: the PR, its reviews and comments, and who may write. */
  function fakeApi({ base, head }: { base: string; head: string }) {
    const reviews: Array<{ id: number; body: string; submitted_at: string; user: { login: string } }> = []
    const comments: Array<{ id: number; body: string; path: string; line: number; user: { login: string }; review: number }> = []
    const posts: Array<{ commit_id: string; event: string; body: string; comments: Array<{ path: string; line: number; body: string }> }> = []
    const replies: Array<{ id: number; body: string; created_at: string; user: { login: string } }> = []
    const writers = new Set(["maintainer"])
    const gh: GhCall = async ({ argv, stdin }) => {
      const [, endpoint = ""] = argv
      if (endpoint === "user") return { code: 1, out: "", err: "Resource not accessible by integration (HTTP 403)" }
      if (endpoint.endsWith("/permission")) return { code: 0, out: writers.has(endpoint.split("/")[4]!) ? "write" : "read" }
      if (endpoint === "repos/acme/app/pulls/12") return { code: 0, out: JSON.stringify({ number: 12, draft: false, head: { sha: head }, base: { sha: base } }) }
      if (endpoint.startsWith("repos/acme/app/pulls/12/reviews?")) return { code: 0, out: reviews.map((item) => JSON.stringify(item)).join("\n") }
      if (endpoint.startsWith("repos/acme/app/pulls/12/comments?")) return { code: 0, out: comments.map((item) => JSON.stringify(item)).join("\n") }
      if (endpoint.startsWith("repos/acme/app/issues/12/comments?")) return { code: 0, out: replies.map((item) => JSON.stringify(item)).join("\n") }
      if (endpoint === "repos/acme/app/issues/12/comments" && stdin) { replies.push({ id: 900 + replies.length, body: JSON.parse(stdin).body, created_at: `2026-10-28T01:00:0${replies.length}Z`, user: { login: ACTIONS_BOT } }); return { code: 0, out: "{}" } }
      if (endpoint === "repos/acme/app/pulls/12/reviews" && stdin) {
        const post = JSON.parse(stdin)
        posts.push(post)
        const id = 100 + posts.length
        reviews.push({ id, body: post.body, submitted_at: `2026-10-28T00:00:0${posts.length}Z`, user: { login: ACTIONS_BOT } })
        for (const comment of post.comments) comments.push({ ...comment, id: id * 10 + comments.length, user: { login: ACTIONS_BOT }, review: id })
        return { code: 0, out: JSON.stringify({ id }) }
      }
      const listed = /^repos\/acme\/app\/pulls\/12\/reviews\/(\d+)\/comments/.exec(endpoint)
      if (listed) return { code: 0, out: JSON.stringify(comments.filter((comment) => comment.review === Number(listed[1]))) }
      return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }
    }
    return { gh, reviews, comments, posts, replies }
  }

  function reviewer() {
    const prompts: string[] = []
    const finding = { path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send(prompt) {
        prompts.push(prompt)
        if (purpose === "review") return { text: JSON.stringify({ summary: "Changes one.", findings: [finding] }), tokens: { input: 1200, output: 80 } }
        const ids = [...prompt.matchAll(/"id":"([0-9a-f]{40})"/g)].map((match) => match[1])
        return { text: JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "confirmed" })) }), tokens: { input: 600, output: 20 } }
      },
      async close() {},
    })
    return { factory, prompts }
  }
  const event = (eventName: string, extra: Record<string, unknown> = {}) => JSON.stringify({ eventName, repo: { owner: "acme", repo: "app" }, actor: "maintainer", ...extra, payload: eventName === "pull_request" ? { action: "opened", pull_request: { number: 12 } } : { issue: { number: 12, pull_request: {} }, comment: { id: 5, body: "@mendcode review please" } } })

  test("a pull_request event posts one COMMENT review; the next run of the same head, rebuilt from markers alone, posts nothing", async () => {
    const repo = await repository()
    const api = fakeApi(repo)
    const first = reviewer()
    const report = await hostedReview({ directory: repo.dir, event: event("pull_request"), gh: api.gh, publish: true, sessionFactory: first.factory })
    expect(report).toMatchObject({ repository: "acme/app", number: 12, status: "published", posted: true, comments: 1, tokens: { input: 1800, output: 100 } })
    expect(api.posts).toHaveLength(1)
    expect(api.posts[0]).toMatchObject({ commit_id: repo.head, event: "COMMENT", comments: [{ path: "a.ts", line: 1 }] })
    // Checks from the base config are never run on a hosted runner; the verifier is told why.
    expect(first.prompts.some((prompt) => prompt.includes(HOSTED_CHECKS_SKIPPED))).toBe(true)
    const again = reviewer()
    const second = await hostedReview({ directory: repo.dir, event: event("pull_request"), gh: api.gh, publish: true, sessionFactory: again.factory })
    expect(second).toMatchObject({ status: "skipped", posted: false })
    expect(second.reason).toContain("already reviewed")
    expect(again.prompts).toEqual([])
    expect(api.posts).toHaveLength(1)
  })
  test("a marker pasted by someone else does not count: the review still runs", async () => {
    const repo = await repository()
    const api = fakeApi(repo)
    api.reviews.push({ id: 1, body: `<!-- mendcode:review head=${repo.head} -->`, submitted_at: "2026-10-27T00:00:00Z", user: { login: "mallory" } })
    const report = await hostedReview({ directory: repo.dir, event: event("pull_request"), gh: api.gh, publish: true, sessionFactory: reviewer().factory })
    expect(report.status).toBe("published")
  })
  test("@mendcode review from a maintainer re-reviews the whole PR; from a reader it is refused without a model call", async () => {
    const repo = await repository()
    const api = fakeApi(repo)
    const asked = reviewer()
    expect((await hostedReview({ directory: repo.dir, event: event("issue_comment"), gh: api.gh, publish: false, sessionFactory: asked.factory })).status).toBe("reviewed")
    expect(asked.prompts.length).toBeGreaterThan(0)
    const stranger = reviewer()
    const refused = await hostedReview({ directory: repo.dir, event: event("issue_comment", { actor: "drive-by" }), gh: api.gh, publish: true, sessionFactory: stranger.factory })
    expect(refused).toMatchObject({ status: "skipped", command: "review", posted: true })
    expect(refused.reason).toContain("only maintainers")
    expect(api.replies.at(-1)!.body).toContain("Only maintainers")
    expect(stranger.prompts).toEqual([])
    expect(asksForReview("@mendcode review")).toBe(true)
    expect(asksForReview("thanks @mendcode, reviewing later")).toBe(false)
  })
  test("through the daemon: github.run with review posts with the run's token and answers with the report", async () => {
    const repo = await repository()
    const api = fakeApi(repo)
    const tokens: Array<string | undefined> = []
    const dir = temp("hosted-daemon-")
    const daemon = await startDaemon({
      dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 0 }),
      prReview: { noGraph: true, sessions: () => reviewer().factory, hosted: async ({ argv, token, stdin }) => { tokens.push(token); return api.gh({ argv: argv.slice(1), ...(stdin === undefined ? {} : { stdin }) }) } },
    })
    const client = createClient({ socketPath: daemon.socketPath, name: "hosted" })
    await client.connect()
    try {
      const done = await client.send({ type: "github.run", directory: repo.dir, input: { event: event("pull_request"), token: "ghs_job_token", publish: true, review: true } })
      expect(done.ok && done.result).toMatchObject({ status: "published", posted: true, comments: 1 })
      expect(api.posts).toHaveLength(1)
      expect(new Set(tokens)).toEqual(new Set(["ghs_job_token"]))
    } finally { client.close(); await daemon.stop() }
  })
  test("@mendcode pause is answered and read back from GitHub on the next push; @mendcode fix says why it does not run here", async () => {
    const repo = await repository()
    const api = fakeApi(repo)
    const comment = (body: string) => JSON.stringify({ eventName: "issue_comment", repo: { owner: "acme", repo: "app" }, actor: "maintainer", payload: { issue: { number: 12, pull_request: {} }, comment: { id: 7, body } } })
    expect(await hostedReview({ directory: repo.dir, event: comment("@mendcode pause"), gh: api.gh, publish: true, sessionFactory: reviewer().factory })).toMatchObject({ status: "answered", command: "pause", posted: true })
    const push = reviewer()
    const skipped = await hostedReview({ directory: repo.dir, event: JSON.stringify({ eventName: "pull_request", repo: { owner: "acme", repo: "app" }, payload: { action: "synchronize", pull_request: { number: 12 } } }), gh: api.gh, publish: true, sessionFactory: push.factory })
    expect(skipped.reason).toContain("paused")
    expect(push.prompts).toEqual([])
    expect(await hostedReview({ directory: repo.dir, event: comment("@mendcode fix it"), gh: api.gh, publish: true, sessionFactory: reviewer().factory })).toMatchObject({ status: "answered", command: "fix" })
    expect(api.replies.at(-1)!.body).toContain("contents: read")
  })
  test("a checkout without the base commit fails with what to change", async () => {
    const repo = await repository()
    const api = fakeApi({ base: "f".repeat(40), head: repo.head })
    await expect(hostedReview({ directory: repo.dir, event: event("pull_request"), gh: api.gh, publish: true, sessionFactory: reviewer().factory })).rejects.toThrow("fetch-depth: 0")
  })
})

describe("daemon", () => {
  test("github.install --hosted with a model the catalog does not know fails with the near ones", async () => {
    const dir = temp("hosted-daemon-"), directory = temp("hosted-project-")
    const models: ModelInfo[] = [{ id: "openai:gpt-6-luna", name: "Luna", provider: "openai", efforts: [] }, { id: "openai:gpt-6-terra", name: "Terra", provider: "openai", efforts: [] }]
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), githubProcess: fakeGithub(directory).process, models: { selectable: true, list: () => models, defaults: { model: "openai:gpt-6-luna" } }, log: () => {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 0 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: "hosted" })
    await client.connect()
    try {
      const unknown = await client.send({ type: "github.install", directory, input: { model: "openai/gpt-6-lunar", hosted: true, release: "v0.4.0", sha256: SHA } })
      expect(!unknown.ok && unknown.error.message).toBe("unknown model openai/gpt-6-lunar; did you mean openai:gpt-6-luna, openai:gpt-6-terra")
      const known = await client.send({ type: "github.install", directory, input: { model: "openai/gpt-6-luna", hosted: true, release: "v0.4.0", sha256: SHA } })
      expect(known.ok && (known.result as { file?: string }).file).toBe(HOSTED_WORKFLOW_FILE)
    } finally { client.close(); await daemon.stop() }
  })
})
