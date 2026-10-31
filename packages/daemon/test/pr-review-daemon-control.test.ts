import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import { PrReviewConfigView, PrReviewDashboard, type SessionId } from "@mendcode/protocol"
import { read } from "@mendcode/tools"
import { stop } from "../../engine-native/test/harness"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import { remoteTokens } from "../src/remote"

/**
 * The daemon's `pr.review` handler with the review platform's actions: it forwards jobId, reason, scope, patch and version to the
 * service and answers `{ text, watches }` plus `dashboard` (status) or `config` (config-*). gh is faked; nothing reaches the network.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

async function boot() {
  const data = temp("mendd-prreview-")
  const project = temp("mendd-prreview-repo-")
  const git = async (...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], project); if (done.code) throw new Error(args.join(" ")) }
  await git("init", "-q", "-b", "main")
  writeFileSync(path.join(project, "README.md"), "x\n")
  await git("add", "-A")
  await git("commit", "-q", "-m", "init")
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const daemon = await startDaemon({ dir: data, socketPath: path.join(data, "mendd.sock"), listen: "127.0.0.1:0", prReview: { run, call: async () => ({ code: 0, out: "[]" }), intervalMs: 3_600_000 }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "prreview" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  async function remote() {
    const token = remoteTokens(data).create({ name: "full", readOnly: false }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  return { client, sessionId, project, remote }
}

test("status answers the reviews page's dashboard in the ack", async () => {
  const { client, sessionId } = await boot()
  const done = await client.send({ type: "pr.review", sessionId, action: "status" })
  expect(done.ok).toBe(true)
  const result = (done.ok ? done.result : undefined) as { text: string; watches: unknown[]; dashboard?: unknown } | undefined
  expect(Array.isArray(result?.watches)).toBe(true)
  expect(PrReviewDashboard.safeParse(result?.dashboard).success).toBe(true)
})

test("a job action reaches the platform with its jobId, and an unknown job is refused by name", async () => {
  const { client, sessionId } = await boot()
  const done = await client.send({ type: "pr.review", sessionId, action: "job-cancel", jobId: "job_missing" })
  expect(done.ok).toBe(false)
  expect(done.ok ? "" : done.error.message).toContain("no job job_missing")
  const retry = await client.send({ type: "pr.review", sessionId, action: "job-retry", jobId: "job_missing", reason: "gh was down" })
  expect(retry.ok ? "" : retry.error.message).toContain("job_missing")
})

test("config actions forward scope: without it the answer names both targets; with it the config view comes back", async () => {
  const { client, sessionId, project } = await boot()
  const ambiguous = await client.send({ type: "pr.review", sessionId, action: "config-apply", patch: { cap: 3 } })
  expect(ambiguous.ok).toBe(false)
  expect(ambiguous.ok ? "" : ambiguous.error.message).toContain("Which reviewer's config?")
  const shown = await client.send({ type: "pr.review", sessionId, action: "config-show", scope: "global", directory: project })
  expect(shown.ok).toBe(true)
  const config = (shown.ok ? shown.result?.config : undefined) as unknown
  expect(PrReviewConfigView.parse(config)).toMatchObject({ scope: "global", target: path.join(project, ".mendcode", "review.yaml") })
  const preview = await client.send({ type: "pr.review", sessionId, action: "config-preview", scope: "personal", directory: project, patch: { cap: 3 } })
  expect(preview.ok && (preview.result?.config as { scope?: string } | undefined)?.scope).toBe("personal")
})

/** A checkout whose origin holds `refs/pull/12/head`, with `enabled: true` on the base. */
async function repository() {
  const origin = temp("pr-mem-origin-"), dir = temp("pr-mem-clone-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\n")
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

test("the global reviewer's prompt carries the checkout's shared project memory, never the user's own", async () => {
  const { dir: project, base, head } = await repository()
  const data = temp("pr-mem-data-")
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, title: "Change one", headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const prompts: string[] = []
  const provider = { id: "scripted", model: "script-1", async *stream(request: ModelRequest) { prompts.push(JSON.stringify(request.messages)); yield* stop(JSON.stringify({ summary: "Changes one.", findings: [] })) } }
  const daemon = await startDaemon({
    dir: data, socketPath: path.join(data, "mendd.sock"), prReview: { run, call: async ({ argv }) => argv[1] === "repos/acme/app" ? { code: 0, out: "false" } : { code: 0, out: "[]" }, intervalMs: 3_600_000 },
    engine: ({ store, runLimits }) => createNativeEngine({ provider, tools: [read], history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize", cwdFor: (id) => store.sessionDirectory(id) ?? data, runLimits: (id) => runLimits.get(id) }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "pr-mem" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  expect(await client.send({ type: "memory.add", scope: "project", directory: project, text: "Constants in a.ts are exported one per line for the codegen", category: "conventions" })).toMatchObject({ ok: true })
  expect(await client.send({ type: "memory.add", scope: "user", text: "Nora prefers tabs over spaces everywhere", category: "conventions" })).toMatchObject({ ok: true })
  expect(await client.send({ type: "memory.sharing.configure", scope: "project", directory: project, enabled: true, confirmation: "ENABLE PROJECT" })).toMatchObject({ ok: true })
  expect(await client.send({ type: "pr.review", sessionId, action: "review", pr: "12" })).toMatchObject({ ok: true })
  const notice = () => daemon.store.readAfter(sessionId, 0, 10_000).flatMap((event) => event.type === "queue.added" && event.notice && event.text.startsWith("PR review of") ? [event.text] : [])[0]
  for (let i = 0; i < 300 && !notice(); i++) await Bun.sleep(20)
  expect(notice()).toContain("PR review of acme/app#12")
  const first = prompts[0] ?? ""
  expect(first).toContain("<review_memory sources=\\\"memory:project:")
  expect(first).toContain("Constants in a.ts are exported one per line")
  expect(prompts.join("\n")).not.toContain("prefers tabs")
})

test("a remote client is refused before anything runs", async () => {
  const { sessionId, remote } = await boot()
  const peer = await remote()
  const done = await peer.send({ type: "pr.review", sessionId, action: "status" })
  expect(done).toMatchObject({ ok: false, error: { code: "forbidden" } })
})
