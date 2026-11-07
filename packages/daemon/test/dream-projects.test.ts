import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { createClient } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { dreamEligibleDirectory, hasNewMaterial } from "../src/dream-projects"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A folder outside the OS temp dir (tests live in it), so the eligibility rules themselves are exercised. */
function realFolder() {
  const root = path.join(homedir(), ".cache", "mendcode-dream-projects-test")
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(path.join(root, "p-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("which folders Dream runs on by itself", () => {
  test("temporary folders, missing folders and relative paths are not projects", () => {
    expect(dreamEligibleDirectory(path.join(tmpdir(), "mend-replay-1"))).toBe(false)
    expect(dreamEligibleDirectory(path.join(realpathSync(tmpdir()), "x"))).toBe(false)
    expect(dreamEligibleDirectory("/private/tmp/mend-replay-9")).toBe(false)
    expect(dreamEligibleDirectory(path.join(homedir(), ".cache", "mendcode-no-such-folder-xyz"))).toBe(false)
    expect(dreamEligibleDirectory("relative/dir")).toBe(false)
  })
  test("a plain folder is a project; a linked worktree (its .git is a file) and the data directory are not", () => {
    const plain = realFolder()
    expect(dreamEligibleDirectory(plain)).toBe(true)
    mkdirSync(path.join(plain, ".git"))
    expect(dreamEligibleDirectory(plain)).toBe(true)
    const linked = realFolder()
    writeFileSync(path.join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n")
    expect(dreamEligibleDirectory(linked)).toBe(false)
    expect(dreamEligibleDirectory(plain, { dataDir: path.dirname(plain) })).toBe(false)
  })
})

describe("new material since the last run", () => {
  test("no earlier run means yes; a session after the run's start or a memory after its end means yes; the run's own proposals do not", () => {
    expect(hasNewMaterial({ sessionsUpdatedAt: [], memoriesUpdatedAt: [] })).toBe(true)
    const last = { lastStartedAt: 1_000, lastEndedAt: 2_000 }
    expect(hasNewMaterial({ ...last, sessionsUpdatedAt: [900], memoriesUpdatedAt: [1_500, 2_000] })).toBe(false)
    expect(hasNewMaterial({ ...last, sessionsUpdatedAt: [1_001], memoriesUpdatedAt: [] })).toBe(true)
    expect(hasNewMaterial({ ...last, sessionsUpdatedAt: [], memoriesUpdatedAt: [2_001] })).toBe(true)
  })
})

describe("the scheduled run in the daemon", () => {
  async function harness(project: string, eligible?: (directory: string) => boolean) {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-proj-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const clock = createVirtualClock(new Date(2026, 8, 27, 3, 30, 0).getTime())
    const prompts: string[] = []
    const daemon = await startDaemon({
      dir, socketPath: path.join(dir, "mendd.sock"), clock,
      engine: ({ clock: c }) => createFauxEngine({ clock: c, deltaMs: 1 }),
      dream: { complete: async (p) => (prompts.push(p), '{"proposals":[],"notes":""}') },
      ...(eligible ? { dreamEligible: eligible } : {}),
    })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "proj" })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: project, title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.send({ type: "user.submit", sessionId, text: "remember the deploy command", attachments: [] })
    for (let i = 0; i < 50 && !daemon.store.readAfter(sessionId, 0).some((e) => e.type === "turn.completed"); i++) { clock.advance(10); await new Promise((r) => setTimeout(r, 5)) }
    clock.advance(120_000)
    return { daemon, client, clock, prompts }
  }
  const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10)) }

  test("a project in a temporary folder is not dreamt on schedule", async () => {
    const h = await harness(path.join(tmpdir(), "mend-replay-7"))
    await h.client.send({ type: "settings.set", patch: { dreamAt: "03:10" } })
    h.clock.advance(10 * 60_000)
    await new Promise((r) => setTimeout(r, 150))
    expect(h.daemon.store.dreamRuns.list()).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("a scheduled window with nothing new since the last run is skipped without a model call and says why; a manual run still goes", async () => {
    const h = await harness("/active", () => true)
    await h.client.send({ type: "dream.run", directory: "/active" })
    await until(() => h.daemon.store.dreamRuns.list("/active").some((run) => run.status === "done"))
    expect(h.prompts).toHaveLength(1)
    await h.client.send({ type: "settings.set", patch: { dreamAt: "03:10" } })
    h.clock.advance(23 * 3_600_000 + 45 * 60_000)
    await until(() => h.daemon.store.dreamRuns.list("/active").length === 2 && h.daemon.store.dreamRuns.list("/active")[0]!.status !== "running")
    expect(h.prompts).toHaveLength(1)
    expect(h.daemon.store.dreamRuns.list("/active")[0]).toMatchObject({ status: "skipped", notes: "Nothing new since the last run" })
    await h.client.send({ type: "dream.run", directory: "/active" })
    await until(() => h.prompts.length === 2)
  })
})

describe("interrupted runs", () => {
  test("every interrupted project is listed once, however many other runs came after", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-int-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })
    cleanups.push(() => daemon.stop())
    const { dreamRuns } = daemon.store
    for (const name of ["/a", "/b", "/c"]) dreamRuns.finish(dreamRuns.start(name, "scheduled").runId, { status: "failed", error: "Interrupted: the daemon stopped" })
    for (let i = 0; i < 30; i++) dreamRuns.finish(dreamRuns.start("/busy", "manual").runId, { status: "done" })
    dreamRuns.finish(dreamRuns.start("/c", "recovered").runId, { status: "done" })
    expect(dreamRuns.list().some((run) => run.directory === "/a")).toBe(false)
    expect(dreamRuns.interrupted({ since: 0, errorPrefix: "Interrupted" }).sort()).toEqual(["/a", "/b"])
  })
})
