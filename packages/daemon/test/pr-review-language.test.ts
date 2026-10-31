import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import type { PrFinding, SessionId } from "@mendcode/protocol"
import { read } from "@mendcode/tools"
import { stop } from "../../engine-native/test/harness"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from "../src/pr-review/config"
import { effectiveConfig } from "../src/pr-review/config-layers"
import { gitRun, type ReviewContext } from "../src/pr-review/context"
import { reviewPrompt, type ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import { engineConfigFor, meteredSessions } from "../src/pr-review/run"
import { inLanguage } from "../src/pr-review/sessions"
import { verifyPrompt } from "../src/pr-review/verify"
import type { RunLimits } from "../src/run-limits"

/**
 * The review language (live e2e D3: the same PR got an English review, then a Spanish one, because the review child ran with the
 * user's own Claude Code `language` setting). `template.language` in the repository's config (default English) is pinned in the
 * review and verify prompts and handed to the review child's harness; a personal or task layer cannot change it.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const context: ReviewContext = { base: "a".repeat(40), head: "b".repeat(40), diff: "diff --git a/a.ts b/a.ts\n", files: [], changedSymbols: [], notes: [] } as unknown as ReviewContext
const finding: PrFinding = { id: "f1", path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "s", detail: "d", evidence: ["a.ts:1"] } as PrFinding

test("the review language defaults to English, takes a language name and refuses anything else with its key path", () => {
  expect(DEFAULT_REVIEW_CONFIG.template.language).toBe("English")
  expect(parseReviewConfig("template:\n  language: Português\n").config.template.language).toBe("Português")
  const bad = parseReviewConfig("template:\n  language: \"<b>English</b>\"\n")
  expect(bad.problem).toContain("template.language")
  expect(bad.config.template.language).toBe("English")
})

test("only the repository sets the review language: a personal or task layer that changes it is refused by name, its other template keys apply", () => {
  const layered = effectiveConfig({ repository: { template: { language: "Español" } }, personal: { template: { language: "English", tone: "concise" } } })
  expect(layered.config.template).toMatchObject({ language: "Español", tone: "concise" })
  expect(layered.problems.join("\n")).toContain("personal template.language: only the repository sets the review language (Español); not applied")
  const task = effectiveConfig({ repository: {}, task: { template: { language: "Deutsch" } } })
  expect(task.config.template.language).toBe("English")
  expect(task.origins.template).toBe("preset")
  // Repeating the repository's language is no change and no problem.
  expect(effectiveConfig({ repository: { template: { language: "Español" } }, personal: { template: { language: "Español" } } }).problems).toEqual([])
})

test("the review and verify prompts pin the configured language; without one they say nothing about it", () => {
  const config = engineConfigFor({ config: { ...DEFAULT_REVIEW_CONFIG, template: { ...DEFAULT_REVIEW_CONFIG.template, language: "Português" } }, context, learnings: "", budgetTokens: 1_000, plan: { phases: [], decisions: [] } as never })
  expect(config.language).toBe("Português")
  const review = reviewPrompt(context, config)
  expect(review).toContain("Write all of your prose in Português")
  // The pin is part of the instructions, before the pull request's untrusted data.
  expect(review.indexOf("Write all of your prose in")).toBeLessThan(review.indexOf("<pull_request"))
  expect(verifyPrompt([finding], context, [], undefined, "Português")).toContain("Write all of your prose in Português")
  expect(verifyPrompt([finding], context, [])).not.toContain("Write all of your prose")
  expect(reviewPrompt(context, { ...config, language: undefined })).not.toContain("Write all of your prose")
})

test("each review child is created with the language, and a fix prompt built outside the engine gets the same pin", async () => {
  const asked: Array<{ purpose: string; language?: string | undefined }> = []
  const sent: string[] = []
  const factory: ReviewSessionFactory = async (input) => { asked.push(input); return { send: async (prompt) => { sent.push(prompt); return { text: "ok", tokens: { input: 1, output: 1 } } }, close: async () => {} } }
  const metered = meteredSessions({ factory, account: undefined, resuming: false, failures: [], language: "Español" })
  await (await metered({ purpose: "review" })).send("review it")
  expect(asked).toEqual([{ purpose: "review", language: "Español" }])
  await (await inLanguage(factory, "Español")({ purpose: "review" })).send("fix it")
  expect(sent[1]).toStartWith("fix it\n\n")
  expect(sent[1]).toContain("Write all of your prose in Español")
})

/** A repository whose origin holds `refs/pull/12/head` and the base config `yaml`. */
async function repository(yaml: string) {
  const origin = temp("pr-lang-origin-"), dir = temp("pr-lang-clone-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
  await git(origin, "init", "-q", "--bare", "-b", "main")
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
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main", "feature:refs/pull/12/head")
  await git(dir, "checkout", "-q", "main")
  return { dir, base, head }
}

/** `/pr review 12` in a real daemon: the review child's run limits and its first prompt. */
async function reviewChild(yaml: string) {
  const { dir: project, base, head } = await repository(yaml)
  const data = temp("pr-lang-data-")
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv }) => argv[1] === "repos/acme/app" ? { code: 0, out: "false" } : { code: 0, out: "[]" }
  const prompts: string[] = []
  const limits: Array<RunLimits | undefined> = []
  const provider = { id: "scripted", model: "script-1", async *stream(request: ModelRequest) { prompts.push(JSON.stringify(request.messages)); yield* stop(JSON.stringify({ summary: "Changes one.", findings: [] })) } }
  const daemon = await startDaemon({
    dir: data, socketPath: path.join(data, "mendd.sock"), prReview: { run, call, intervalMs: 3_600_000, noGraph: true },
    engine: ({ store, runLimits }) => createNativeEngine({
      provider, tools: [read], history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize",
      cwdFor: (id) => { if (store.sessionDirectory(id) !== project) limits.push(runLimits.get(id)); return store.sessionDirectory(id) ?? data },
      runLimits: (id) => runLimits.get(id),
    }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "pr-lang" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  expect(await client.send({ type: "pr.review", sessionId, action: "review", pr: "12" })).toMatchObject({ ok: true })
  const notice = () => daemon.store.readAfter(sessionId, 0, 10_000).some((event) => event.type === "queue.added" && event.notice && event.text.startsWith("PR review of"))
  for (let i = 0; i < 300 && !notice(); i++) await Bun.sleep(20)
  expect(notice()).toBe(true)
  return { limits, prompt: prompts[0] ?? "" }
}

test("a review child runs in the repository's language: English by default, pinned in its prompt and handed to its harness over the user's own setting", async () => {
  const { limits, prompt } = await reviewChild("enabled: true\n")
  expect(limits[0]).toMatchObject({ noContextFiles: true, untrustedCheckout: true, responseLanguage: "English" })
  expect(prompt).toContain("Write all of your prose in English")
})

test("a repository that sets template.language gets every review child in that language", async () => {
  const { limits, prompt } = await reviewChild("enabled: true\ntemplate:\n  language: Español\n")
  expect(limits[0]).toMatchObject({ responseLanguage: "Español" })
  expect(prompt).toContain("Write all of your prose in Español")
})
