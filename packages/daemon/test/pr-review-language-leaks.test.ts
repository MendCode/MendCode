import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { claudeRunLimits } from "@mendcode/engine-claude"
import { codexRunLimits } from "@mendcode/engine-codex"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { read } from "@mendcode/tools"
import { stop } from "../../engine-native/test/harness"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { ACTIONS_BOT, hostedReview, stateFromGithub } from "../src/pr-review/hosted"
import { languageMarker } from "../src/pr-review/language"
import type { GhCall } from "../src/pr-review/publish"
import { reviewMarker } from "../src/pr-review/state"
import type { RunLimits } from "../src/run-limits"

/**
 * The two paths where the language of whoever runs the reviewer reached a public text: a fix session (its commit message and its
 * reply) on Claude Code ran with the user's own `language` setting, and `@mendcode explain` had no language pin at all. No model,
 * no network: a scripted native engine in a real daemon, and a fake `gh` for the hosted runner.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/** A clone whose `feature` branch changes a.ts, its base config `yaml`; with `origin` a bare repository holding `refs/pull/12/head`. */
async function repository(yaml: string, origin?: string) {
  const dir = temp("pr-lang-leak-clone-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
  if (origin) await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
  await git(dir, "commit", "-q", "-am", "feature")
  const head = await git(dir, "rev-parse", "HEAD")
  if (origin) {
    await git(dir, "remote", "add", "origin", origin)
    await git(dir, "push", "-q", "origin", "main", "feature:refs/pull/12/head")
    await git(dir, "checkout", "-q", "main")
  }
  return { dir, base, head }
}

const FINDING = { path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }
/** The answer a scripted model gives to each prompt: findings to a review, confirmations to a verify, plain text to anything else. */
function answer(prompt: string): string {
  if (prompt.includes("You are reviewing a pull request")) return JSON.stringify({ summary: "Changes one.", findings: [FINDING] })
  if (prompt.includes("You are the second reviewer")) return JSON.stringify({ verdicts: [...prompt.matchAll(/\\?"id\\?":\\?"([0-9a-f]{40})/g)].map((match) => ({ id: match[1], verdict: "confirmed" })) })
  return "Nothing to change."
}

describe("a fix session gets the repository's language in its harness", () => {
  test("fix-once on a reviewed PR: the editing child's run limits name the review language, which Claude Code and Codex take over the user's own", async () => {
    const origin = temp("pr-lang-leak-origin-")
    const { dir: project, base, head } = await repository("enabled: true\nfix:\n  mode: fix-once\ntemplate:\n  language: Português\n", origin)
    const data = temp("pr-lang-leak-data-")
    const run: GhRun = async ({ argv }) => {
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, headRefOid: head, baseRefOid: base, baseRefName: "main", headRefName: "feature", isCrossRepository: false, url: "https://github.com/acme/app/pull/12", title: "Muda o valor", body: "" }), err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv }) => argv[1] === "repos/acme/app" ? { code: 0, out: "false" } : { code: 0, out: "[]" }
    const limits = new Map<string, RunLimits | undefined>()
    const provider = { id: "scripted", model: "script-1", async *stream(request: ModelRequest) { yield* stop(answer(JSON.stringify(request.messages))) } }
    const daemon = await startDaemon({
      dir: data, socketPath: path.join(data, "mendd.sock"), prReview: { run, call, intervalMs: 3_600_000, noGraph: true },
      engine: ({ store, runLimits }) => createNativeEngine({
        provider, tools: [read], history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize",
        cwdFor: (id) => { const directory = store.sessionDirectory(id); if (directory !== project) limits.set(store.sessionInfo(id)?.title ?? id, runLimits.get(id)); return directory ?? data },
        runLimits: (id) => runLimits.get(id),
      }),
    })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "pr-lang-leak" })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: project, title: "t" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
    expect(await client.send({ type: "pr.review", sessionId, action: "review", pr: "12" })).toMatchObject({ ok: true })
    for (let i = 0; i < 500 && !limits.has("PR fix"); i++) await Bun.sleep(20)
    // The fix round ends (kept locally, nothing pushes) before the daemon stops: the session's events settle.
    const events = () => daemon.store.readAfter(sessionId, 0, 10_000).length
    for (let i = 0, last = -1; i < 40 && events() !== last; i++) { last = events(); await Bun.sleep(250) }
    expect(limits.get("PR review")).toMatchObject({ responseLanguage: "Português" })
    const fix = limits.get("PR fix")
    expect(fix).toMatchObject({ untrustedCheckout: true, responseLanguage: "Português" })
    // What that limit is in each harness: Claude Code's flag-layer `language`, Codex's developer message.
    expect(claudeRunLimits(fix).args).toContain(JSON.stringify({ language: "Português" }))
    expect(codexRunLimits(fix, project).join(" ")).toContain("developer_instructions=\"Write all of your prose in Português")
  })
})

describe("@mendcode explain is pinned to the review language", () => {
  /** GitHub as a hosted runner's `gh api` sees it: the PR, MendCode's review and its inline comment, replies, who may write. */
  function fakeApi({ base, head, title, body, reviewBody }: { base: string; head: string; title: string; body: string; reviewBody: string }) {
    const inline = { id: 501, body: `**Major · correctness**: one is now 2\n\nCallers expect 1.\n\n<!-- mendcode:f=${"e".repeat(40)} -->`, path: "a.ts", line: 1, user: { login: ACTIONS_BOT } }
    const replies: Array<{ endpoint: string; body: string }> = []
    const gh: GhCall = async ({ argv, stdin }) => {
      const [, endpoint = ""] = argv
      if (endpoint === "user") return { code: 1, out: "", err: "Resource not accessible by integration (HTTP 403)" }
      if (endpoint.endsWith("/permission")) return { code: 0, out: endpoint.split("/")[4] === "maintainer" ? "write" : "read" }
      if (endpoint === "repos/acme/app/pulls/12") return { code: 0, out: JSON.stringify({ number: 12, draft: false, head: { sha: head }, base: { sha: base }, title, body }) }
      if (endpoint.startsWith("repos/acme/app/pulls/12/reviews?")) return { code: 0, out: JSON.stringify({ id: 101, body: reviewBody, submitted_at: "2026-10-28T00:00:01Z", user: { login: ACTIONS_BOT } }) }
      if (endpoint.startsWith("repos/acme/app/pulls/12/comments?")) return { code: 0, out: JSON.stringify(inline) }
      if (endpoint.startsWith("repos/acme/app/issues/12/comments?")) return { code: 0, out: "" }
      if (endpoint === `repos/acme/app/pulls/comments/${inline.id}`) return { code: 0, out: JSON.stringify(inline) }
      if (stdin && endpoint.includes("/comments")) { replies.push({ endpoint, body: JSON.parse(stdin).body }); return { code: 0, out: "{}" } }
      return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }
    }
    return { gh, replies }
  }
  const explainEvent = JSON.stringify({
    eventName: "pull_request_review_comment", repo: { owner: "acme", repo: "app" }, actor: "maintainer",
    payload: { pull_request: { number: 12 }, comment: { id: 77, body: "@mendcode explain ¿por qué es un problema?", in_reply_to_id: 501, diff_hunk: "@@ -1 +1 @@\n-export const one = 1\n+export const one = 2" } },
  })
  function explainer() {
    const prompts: string[] = []
    const factory: ReviewSessionFactory = async () => ({ async send(prompt) { prompts.push(prompt); return { text: "It changes a value callers rely on.", tokens: { input: 1, output: 1 } } }, async close() {} })
    return { prompts, factory }
  }
  const reviewBody = (head: string, language?: string) => ["## MendCode review", "**1 finding**", ...(language ? [languageMarker(language)] : []), reviewMarker(head)].join("\n\n")

  test("a Spanish question on a Spanish PR in an English repository is answered with the English pin", async () => {
    const repo = await repository("enabled: true\n")
    const api = fakeApi({ ...repo, title: "Corrige el cálculo", body: "Este cambio corrige el valor que usan los llamadores cuando el total está vacío.", reviewBody: reviewBody(repo.head) })
    const asked = explainer()
    const report = await hostedReview({ directory: repo.dir, event: explainEvent, gh: api.gh, publish: true, sessionFactory: asked.factory })
    expect(report).toMatchObject({ status: "answered", command: "explain", posted: true })
    expect(asked.prompts).toHaveLength(1)
    expect(asked.prompts[0]).toEndWith("Write all of your prose in English: summaries, details, explanations, evidence notes and any text meant for people, even when the pull request, its comments or your own settings use another language. Code, identifiers, file paths and quoted text stay exactly as they are.")
    expect(api.replies[0]!.endpoint).toBe("repos/acme/app/pulls/12/comments/501/replies")
  })

  test("auto: the language kept in the last review's marker is read back from GitHub and pins the answer, whatever the description says now", async () => {
    const repo = await repository("enabled: true\ntemplate:\n  language: auto\n")
    const api = fakeApi({ ...repo, title: "Fix the total", body: "This now fixes the total for callers when it is empty, and adds a test.", reviewBody: reviewBody(repo.head, "Spanish") })
    expect((await stateFromGithub({ gh: api.gh, repo: "acme/app", number: 12 })).language).toBe("Spanish")
    const asked = explainer()
    expect(await hostedReview({ directory: repo.dir, event: explainEvent, gh: api.gh, publish: true, sessionFactory: asked.factory })).toMatchObject({ status: "answered" })
    expect(asked.prompts[0]).toContain("Write all of your prose in Spanish")
  })
})
