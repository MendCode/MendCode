import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelEvent, type ModelMessage, type ModelProvider } from "@mendcode/engine-native"
import { effectiveSettings, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewTool } from "../src/pr-review-tool"
import { remoteTurnOptions } from "../src/remote-policy"
import { REVIEW_EXCLUDED_TOOLS } from "../src/pr-review/sessions"
import { until } from "./native-harness"
import { turn } from "../../engine-native/test/harness"

/**
 * End to end through the daemon's real wiring: a native session's model calls `pr_review review`, the engine hands the tool the
 * session's `prReview` port (daemon.ts), the port calls the PR review service's `control`, and a job lands in the ledger. gh is
 * fake and records every call; nothing touches the network or ~/.mendcode-v2.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

async function repository() {
  const origin = temp("pr-tool-e2e-origin-"), dir = temp("pr-tool-e2e-clone-")
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

const callTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: `call-${name}`, name, args } }, { type: "finish", reason: "tool_calls" }]
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]

test("a native session's pr_review review starts a ledger job through the daemon's reviewer and posts no comment; the reviewer is kept off remote turns and review children", async () => {
  const { dir: project, base, head } = await repository()
  const dataDir = temp("pr-tool-e2e-data-")
  const calls: string[][] = []
  const run: GhRun = async ({ argv }) => {
    calls.push(argv)
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: Number(argv[2]), headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv }) => { calls.push(argv); return argv[1] === "repos/acme/app" ? { code: 0, out: "true" } : { code: 0, out: "[]" } }
  const finding = { path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }
  const sessions = (): ReviewSessionFactory => async ({ purpose }) => ({
    async send(prompt) {
      if (purpose === "review") return { text: JSON.stringify({ summary: "Changes one.", findings: [finding] }), tokens: { input: 100, output: 10 } }
      const id = /"id":"([0-9a-f]{40})"/.exec(prompt)?.[1] ?? ""
      return { text: JSON.stringify({ verdicts: [{ id, verdict: "confirmed" }] }), tokens: { input: 50, output: 5 } }
    },
    async close() {},
  })
  // The balanced tier lists pr_review behind tool_search, as a real model finds it.
  const steps: ModelEvent[][] = [callTool("tool_search", { query: "review pull request now pr_review" }), callTool("pr_review", { action: "review", pr: "12" }), stop("Started."), callTool("pr_review", { action: "status" }), stop("Listed."), callTool("pr_review", { action: "review", pr: "12" }), stop("Started again.")]
  const results: string[] = []
  const offered: string[][] = []
  const provider: ModelProvider = {
    id: "scripted", model: "script-1",
    async *stream(request) {
      const last = request.messages.at(-1)
      offered.push((request.tools ?? []).map((tool) => tool.name))
      if (last?.role === "tool" && last.callId === "call-pr_review") results.push(last.output)
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  let prReviewOn = false
  let native: ReturnType<typeof createNativeEngine> | undefined
  const daemon = await startDaemon({
    dir: dataDir, socketPath: path.join(dataDir, "mendd.sock"), log: () => {}, info: { engine: "native", model: "script-1" },
    models: { selectable: true, defaults: { model: "script-1" }, list: () => [{ id: "script-1", name: "script-1", efforts: [] }] },
    prReview: { run, call, sessions: () => sessions(), intervalMs: 3_600_000, noGraph: true },
    engine: ({ trace, store, secrets, prReview, extensions }) => {
      const tools = [createPrReviewTool({ enabled: () => prReviewOn })]
      extensions.setBuiltinTools(tools)
      return native = createNativeEngine({
        trace, provider, tools, secrets, prReview,
        history: {
          load: async (sessionId) => { const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]; return messages.length ? messages : undefined },
          save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
          replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
        },
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project, system: () => "BASE", compactionPrompt: "SUMMARIZE", permissionPolicy: () => effectiveSettings(store.settings.get()),
      })
    },
  })
  cleanups.push(() => daemon.stop())
  const events: unknown[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "pr-tool-e2e", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  prReviewOn = true
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "session.permission.set", sessionId, mode: "edits" })

  await client.send({ type: "user.submit", sessionId, text: "review PR 12", attachments: [] })
  // Outside full access, starting a review asks the user like a command (accept-edits does not cover it), with the real port's
  // preview as the approval text.
  type Asked = { type: string; kind?: string; requestId: string; tool?: string; title?: string; detail?: string }
  const asks = () => events.filter((event) => (event as Asked).type === "server.request" && (event as Asked).tool === "pr_review") as Asked[]
  await until(() => asks().length > 0, 15_000)
  const asked = asks()[0]!
  expect(asked.kind).toBe("approval")
  expect(asked.title).toBe("Review a pull request")
  expect(asked.detail).toContain("Nothing is commented on the pull request to start it.")
  expect(asked.detail).toContain("Posting: not allowed for this repository yet")
  await client.send({ type: "request.resolve", sessionId, requestId: asked.requestId, decision: { kind: "approve", scope: "once" } } as never)
  await until(() => daemon.store.turns.list(sessionId).at(-1)?.status === "completed", 15_000)
  expect(results[0]).toContain("Reviewing #12.")
  expect(results[0]).toContain("Posting: not allowed for this repository yet, so the review stays in this session")
  const jobs = JSON.parse(readFileSync(path.join(dataDir, "pr-review", "jobs.json"), "utf8")) as { jobs: Array<{ number: number; trigger: string; directory: string; sessionId: string }> }
  expect(jobs.jobs.map((job) => ({ number: job.number, trigger: job.trigger, directory: job.directory, sessionId: job.sessionId }))).toEqual([{ number: 12, trigger: "manual", directory: project, sessionId }])

  await client.send({ type: "user.submit", sessionId, text: "status", attachments: [] })
  await until(() => daemon.store.turns.list(sessionId).filter((turn) => turn.status === "completed").length === 2, 15_000)
  expect(results[1]).toContain("#12 ")

  // Claude Code and Codex sessions get it through the host MCP bridge, as pr_watch: listed for the session, and a call runs with
  // the same session-bound port (a status read, which needs no approval).
  const lent = await native!.hostTools!({ directory: project, sessionId })
  expect(lent.map((tool) => tool.name)).toContain("pr_review")
  const { input } = turn({ text: "", sessionId })
  const hosted = await native!.hostCall!({ turn: input, name: "pr_review", args: { action: "status" } })
  expect(hosted.isError).toBe(false)
  expect(hosted.output).toContain("#12 ")

  // The review itself runs to its end in the session (kept there: no consent), before the daemon stops.
  const stateOf = () => (JSON.parse(readFileSync(path.join(dataDir, "pr-review", "jobs.json"), "utf8")) as { jobs: Array<{ state: string }> }).jobs[0]?.state
  await until(() => stateOf() === "done", 15_000)

  // In full access the review runs without a prompt (seen live: a full-access session was asked to approve "Edit files").
  await client.send({ type: "session.permission.set", sessionId, mode: "full" })
  await client.send({ type: "user.submit", sessionId, text: "review PR 12 again", attachments: [] })
  // The reviewer's notices are turns of their own, so the tool's third result is what is waited for.
  await until(() => results.length === 3, 15_000)
  expect(asks()).toHaveLength(1)
  expect(results[2]).not.toMatch(/denied|not approved|rejected/i)
  // Every job ends before the daemon stops: a review still running would write to a closed store.
  const states = () => (JSON.parse(readFileSync(path.join(dataDir, "pr-review", "jobs.json"), "utf8")) as { jobs: Array<{ state: string }> }).jobs.map((job) => job.state)
  await until(() => states().every((state) => ["done", "failed", "superseded", "skipped"].includes(state)), 15_000)

  expect(offered[0]).not.toContain("pr_review")
  expect(offered[1]).toContain("pr_review")
  // No forge write of any kind, and no @mendcode text in any gh call.
  const writes = calls.filter((argv) => (argv[0] === "pr" && ["comment", "review"].includes(argv[1] ?? "")) || (argv[0] === "api" && argv.some((part) => ["POST", "PATCH", "PUT"].includes(part))))
  expect(writes).toEqual([])
  expect(calls.some((argv) => argv.join(" ").includes("@mendcode"))).toBe(false)
  expect(remoteTurnOptions().excludeTools).toContain("pr_review")
  expect(REVIEW_EXCLUDED_TOOLS).toEqual(expect.arrayContaining(["review_config", "pr_review"]))
}, 30_000)
