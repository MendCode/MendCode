import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { defineTool, read, shell } from "@mendcode/tools"
import { z } from "zod"
import { callTool, stop } from "../../engine-native/test/harness"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { GhCall } from "../src/pr-review/publish"
import { REVIEW_APPROVAL_REFUSED } from "../src/pr-review/sessions"
import type { RunLimits } from "../src/run-limits"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/** A repository whose origin holds `refs/pull/12/head` and a base config with `enabled: true`. */
async function repository() {
  const origin = temp("pr-child-origin-"), dir = temp("pr-child-clone-")
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

/** Stands for the user's skill loader: a session that is offered it can pull in instructions from outside the checkout. */
const skill = defineTool({ name: "skill", description: "Load a skill", permission: "read", args: z.object({ name: z.string().optional() }), execute: async () => ({ output: "Skill folder: /elsewhere", truncated: false, title: "skill", isError: false }) })

/** Runs `/pr review 12` in a real daemon whose review child is the scripted model `steps`; returns what the child was offered and got. */
async function reviewWith(steps: ModelEvent[][]) {
  const { dir: project, base, head } = await repository()
  const data = temp("pr-child-data-")
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv }) => argv[1] === "repos/acme/app" ? { code: 0, out: "false" } : { code: 0, out: "[]" }
  const requests: ModelRequest[] = []
  const limits: Array<RunLimits | undefined> = []
  const provider = { id: "scripted", model: "script-1", async *stream(request: ModelRequest) { requests.push({ ...request, messages: structuredClone(request.messages) }); yield* steps.shift() ?? stop("{}") } }
  const daemon = await startDaemon({
    dir: data, socketPath: path.join(data, "mendd.sock"), prReview: { run, call, intervalMs: 3_600_000 },
    engine: ({ store, runLimits }) => createNativeEngine({
      provider, tools: [read, shell, skill], history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize",
      cwdFor: (id) => { if (store.sessionDirectory(id) !== project) limits.push(runLimits.get(id)); return store.sessionDirectory(id) ?? data },
      runLimits: (id) => runLimits.get(id),
    }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "pr-child" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  expect(await client.send({ type: "pr.review", sessionId, action: "review", pr: "12" })).toMatchObject({ ok: true })
  const notice = () => daemon.store.readAfter(sessionId, 0, 10_000).flatMap((event) => event.type === "queue.added" && event.notice && event.text.startsWith("PR review of") ? [event.text] : [])[0]
  for (let i = 0; i < 300 && !notice(); i++) await Bun.sleep(20)
  expect(notice()).toContain("PR review of acme/app#12: reviewed")
  // The review turn's last model call holds every tool result of that turn.
  const results = requests.map((request) => request.messages.filter((message) => message.role === "tool")).reduce((most, next) => next.length > most.length ? next : most, [])
  return { offered: requests[0]!.tools.map((tool) => tool.name), results, limits }
}

test("a review child reads the pull request with read, grep and glob; it is not offered shell, which plan mode refuses on every call (a live review: 'repository reads were denied')", async () => {
  // The review child's model reads the changed file the way models often do, with a command first, then with `read`.
  const { offered, results } = await reviewWith([callTool("shell", { command: "git show HEAD:a.ts" }), callTool("read", { path: "a.ts" }), stop(JSON.stringify({ summary: "Changes one.", findings: [] }))])
  expect(offered).toContain("read")
  expect(offered).not.toContain("shell")
  // A call to a tool it is not offered is unknown, never a denied read; `read` returns the file at the head.
  expect(results[0]).toMatchObject({ output: "unknown tool: shell", isError: true })
  expect(JSON.stringify(results[1])).toContain("export const one = 2")
})

test("a review child gets no skills and no instruction files; a read that names a file outside the checkout is refused with what it may read, and it reads the checkout next", async () => {
  // A live review: the child loaded the user's review skill, then asked in one read for two files of that skill's folder and
  // five of the repository; the outside ones asked for approval, the whole read was refused ("Do not retry") and nothing was read.
  const outside = path.join(temp("pr-child-outside-"), "SKILL.md")
  writeFileSync(outside, "outside the checkout\n")
  const { offered, results, limits } = await reviewWith([
    callTool("read", { paths: [{ path: outside }, { path: "a.ts" }] }),
    callTool("read", { path: "a.ts" }),
    stop(JSON.stringify({ summary: "Changes one.", findings: [] })),
  ])
  expect(offered).not.toContain("skill")
  expect(limits[0]).toMatchObject({ noContextFiles: true, excludeTools: expect.arrayContaining(["skill"]) })
  expect(results[0]).toMatchObject({ isError: true })
  expect(JSON.stringify(results[0])).toContain(REVIEW_APPROVAL_REFUSED)
  expect(JSON.stringify(results[0])).not.toContain("Do not retry")
  expect(JSON.stringify(results[1])).toContain("export const one = 2")
})
