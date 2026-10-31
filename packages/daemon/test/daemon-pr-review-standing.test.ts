import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import { createJobLedger } from "../src/pr-review/jobs"

/**
 * A detached daemon stops itself after `idleExitMs` with no client and nothing standing (D4 of the live e2e): the PR reviewer's
 * standing work (a watch that has not ended, a held notice, a job that runs later) keeps it up and is named in the keep-alive report.
 * gh is faked; nothing reaches the network.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const sha = (n: number) => n.toString(16).padStart(40, "0")

async function until(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

async function project() {
  const dir = temp("mendd-standing-repo-")
  const git = async (...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir); if (done.code) throw new Error(args.join(" ")) }
  await git("init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "README.md"), "x\n")
  await git("add", "-A")
  await git("commit", "-q", "-m", "init")
  return dir
}

const run: GhRun = async ({ argv }) => {
  if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
  if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
  if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
  return { code: 1, out: "", err: "unexpected" }
}

async function boot(data: string) {
  const stopped: string[] = []
  const daemon = await startDaemon({ dir: data, socketPath: path.join(data, "mendd.sock"), idleExitMs: 40, prReview: { run, call: async () => ({ code: 0, out: "[]" }), intervalMs: 3_600_000, noGraph: true }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), onShutdown: () => void stopped.push("down") })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "standing" })
  await client.connect()
  cleanups.push(() => client.close())
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } })
  const standing = async () => { const status = await client.send({ type: "daemon.status" }); return ((status.ok ? status.result : undefined) as { keepAlive: { standing: string[] } } | undefined)?.keepAlive.standing ?? [] }
  return { daemon, client, stopped, standing }
}

test("an active repo watch keeps a detached daemon up with no client, and is named; once the watch is stopped the daemon stops itself", async () => {
  const data = temp("mendd-standing-")
  const repo = await project()
  const { client, stopped, standing } = await boot(data)
  const created = await client.send({ type: "session.create", directory: repo, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  const watched = await client.send({ type: "pr.review", sessionId, action: "watch-repo", directory: repo })
  expect(watched.ok).toBe(true)
  expect(await standing()).toContain("PR review watch")
  // A second client stops the watch later; the first leaves, so no client is attached for many idle periods.
  const other = createClient({ socketPath: path.join(data, "mendd.sock"), name: "other" })
  client.close()
  await Bun.sleep(400)
  expect(stopped).toEqual([])
  await other.connect()
  cleanups.push(() => other.close())
  expect((await other.send({ type: "pr.review", sessionId, action: "unwatch-repo", directory: repo })).ok).toBe(true)
  const status = await other.send({ type: "daemon.status" })
  expect(((status.ok ? status.result : undefined) as { keepAlive: { standing: string[] } } | undefined)?.keepAlive.standing).not.toContain("PR review watch")
  other.close()
  await until(() => stopped.length === 1)
})

test("a job that waits for a time keeps the daemon up and is named; a job checkpointed until someone retries it does not", async () => {
  const data = temp("mendd-standing-")
  const file = path.join(data, "pr-review", "jobs.json")
  const input = (number: number) => ({ provider: "github" as const, repo: "acme/app", directory: "/nowhere", number, sessionId: "ses_a", reviewer: "global", scope: "global" as const, trigger: "opened" as const, coverage: "full" as const, base: sha(1000), head: sha(number), configKey: "cfg1" })
  const ledger = createJobLedger({ file })
  const held = ledger.upsert(input(7))
  ledger.transition(held.id, "running")
  ledger.transition(held.id, "checkpointed")
  {
    const { client, stopped, standing } = await boot(data)
    // Checkpointed with no time to resume at: it waits for a person, so nothing is standing.
    expect(await standing()).toEqual([])
    client.close()
    await until(() => stopped.length === 1)
  }
  const later = ledger.upsert(input(6))
  ledger.transition(later.id, "waiting", { notBefore: Date.now() + 3_600_000 })
  {
    const { client, stopped, standing } = await boot(data)
    expect(await standing()).toEqual(["PR review jobs"])
    client.close()
    await Bun.sleep(400)
    expect(stopped).toEqual([])
  }
})

test("a notice held for a session keeps the daemon up and is named", async () => {
  const data = temp("mendd-standing-")
  const repo = await project()
  let sessionId: SessionId
  {
    const { daemon, client } = await boot(data)
    const created = await client.send({ type: "session.create", directory: repo, title: "t" })
    sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    client.close()
    await daemon.stop()
  }
  mkdirSync(path.join(data, "pr-review"), { recursive: true })
  writeFileSync(path.join(data, "pr-review", "outbox.json"), JSON.stringify({ version: 1, sessions: { [sessionId]: ["PR review of acme/app#6: published"] } }))
  const { client, stopped, standing } = await boot(data)
  expect(await standing()).toEqual(["PR review notices"])
  client.close()
  await Bun.sleep(400)
  expect(stopped).toEqual([])
})
