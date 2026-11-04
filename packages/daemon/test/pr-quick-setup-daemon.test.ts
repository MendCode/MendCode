import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { gitRun } from "../src/pr-review/context"
import type { QuickSetupReport } from "../src/pr-review/quick-setup"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "quick-setup-daemon-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
test("real daemon applies a matching preview once, rejects changed facts and skips configured steps", async () => {
  const dir = temp(), project = temp()
  const git = async (...args: string[]) => {
    const done = await gitRun(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], project)
    if (done.code) throw new Error(`git ${args[0]} failed`)
  }
  await git("init", "-q", "-b", "main")
  mkdirSync(path.join(project, ".mendcode")); writeFileSync(path.join(project, ".mendcode/review.yaml"), "enabled: true\n")
  await git("add", ".mendcode/review.yaml"); await git("commit", "-qm", "fixture")
  await git("remote", "add", "origin", "https://github.com/acme/app.git")
  await git("update-ref", "refs/remotes/origin/main", "HEAD")
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  let login = "alice"
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }), prReview: {
    intervalMs: 3_600_000, noGraph: true,
    run: async ({ argv }) => {
      const key = argv.join(" ")
      if (argv[0] === "auth") return { code: 0, out: login, err: "" }
      if (key === "api user --jq .login") return { code: 0, out: login, err: "" }
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
      return { code: 1, out: "", err: "unexpected fixture call" }
    },
    call: async () => ({ code: 0, out: "[]" }),
  } })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "quick-setup-test" }); await client.connect(); cleanup.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "setup" })
  expect(created.ok).toBe(true)
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: false } } })
  const base = { type: "pr.review" as const, sessionId }
  const before = await client.send({ ...base, action: "setup-preview" })
  expect(before.ok).toBe(true)
  const setup = (before.ok ? before.result?.setup : undefined) as QuickSetupReport
  expect(setup.problems).toEqual([]); expect(setup.changes).toHaveLength(3)
  expect(daemon.store.settings.get().experimental?.pr_review).toBe(false)
  login = "bob"
  const stale = await client.send({ ...base, action: "setup-apply", reason: setup.digest })
  expect(stale).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(daemon.store.settings.get().experimental?.pr_review).toBe(false)
  login = "alice"
  const applied = await client.send({ ...base, action: "setup-apply", reason: setup.digest })
  expect(applied.ok).toBe(true)
  expect(daemon.store.settings.get().experimental?.pr_review).toBe(true)
  expect(applied.ok && applied.result?.text).toContain("Setup complete")
  const after = await client.send({ ...base, action: "setup-preview" })
  expect(after.ok && (after.result?.setup as QuickSetupReport).changes).toEqual([])
  expect(after.ok && (after.result?.setup as QuickSetupReport).skipped).toHaveLength(3)
}, 20_000)

test("a development daemon with no tier set applies the plan once confirmed: the reviewer is allowed, publishing is on, the watch is recorded and said not to run", async () => {
  const dir = temp(), project = temp()
  const git = async (...args: string[]) => {
    const done = await gitRun(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], project)
    if (done.code) throw new Error(`git ${args[0]} failed`)
  }
  await git("init", "-q", "-b", "main")
  mkdirSync(path.join(project, ".mendcode")); writeFileSync(path.join(project, ".mendcode/review.yaml"), "enabled: true\n")
  await git("add", ".mendcode/review.yaml"); await git("commit", "-qm", "fixture")
  await git("remote", "add", "origin", "https://github.com/acme/app.git")
  await git("update-ref", "refs/remotes/origin/main", "HEAD")
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  const daemon = await startDaemon({ dir, dev: true, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }), prReview: {
    intervalMs: 3_600_000, noGraph: true,
    run: async ({ argv }) => {
      if (argv[0] === "auth") return { code: 0, out: "alice", err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "alice", err: "" }
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
      return { code: 1, out: "", err: "unexpected fixture call" }
    },
    call: async () => ({ code: 0, out: "[]" }),
  } })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "quick-setup-dev-test" }); await client.connect(); cleanup.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, title: "setup" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  expect(daemon.store.settings.get().tier).toBeUndefined()
  const base = { type: "pr.review" as const, sessionId, role: "requested" as const }
  const before = await client.send({ ...base, action: "setup-preview" })
  const setup = (before.ok ? before.result?.setup : undefined) as QuickSetupReport
  expect(setup.problems).toEqual([]); expect(setup.changes).toHaveLength(4)
  expect(setup.text).toContain("this development daemon never runs it")
  const applied = await client.send({ ...base, action: "setup-apply", reason: setup.digest })
  expect(applied.ok).toBe(true)
  const settings = daemon.store.settings.get()
  expect(settings.experimental?.pr_review).toBe(true); expect(settings.features?.pr_review).toBe(true); expect(settings.tier).toBeUndefined()
  expect(applied.ok && applied.result?.text).toContain("Applied: Allow the PR reviewer")
  expect(applied.ok && applied.result?.text).toContain("Development daemon: the watch is recorded and does not run.")
  const after = await client.send({ ...base, action: "setup-preview" })
  expect(after.ok && (after.result?.setup as QuickSetupReport).changes).toEqual([])
}, 20_000)
