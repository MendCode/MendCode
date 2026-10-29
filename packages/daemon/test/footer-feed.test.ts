import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { GlobalEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { readGitBranch } from "../src/git-branch"
import { createUsageToday, type UsageTodayEvent } from "../src/usage-today"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-footer-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("readGitBranch", () => {
  test("reads the branch from HEAD of a normal repository and from a subdirectory", () => {
    const root = temp()
    mkdirSync(path.join(root, ".git"))
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/footer\n")
    mkdirSync(path.join(root, "packages", "app"), { recursive: true })
    expect(readGitBranch(root)).toEqual({ branch: "feature/footer" })
    expect(readGitBranch(path.join(root, "packages", "app"))).toEqual({ branch: "feature/footer" })
  })

  test("follows the gitdir pointer of a worktree (relative and absolute)", () => {
    const root = temp()
    const main = path.join(root, "main")
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true })
    writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(path.join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/topic\n")
    const relative = path.join(root, "wt-relative")
    mkdirSync(relative)
    writeFileSync(path.join(relative, ".git"), "gitdir: ../main/.git/worktrees/wt\n")
    const absolute = path.join(root, "wt-absolute")
    mkdirSync(absolute)
    writeFileSync(path.join(absolute, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`)
    expect(readGitBranch(relative)).toEqual({ branch: "topic" })
    expect(readGitBranch(absolute)).toEqual({ branch: "topic" })
    expect(readGitBranch(main)).toEqual({ branch: "main" })
  })

  test("a detached HEAD reports the short commit id", () => {
    const root = temp()
    mkdirSync(path.join(root, ".git"))
    writeFileSync(path.join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
    expect(readGitBranch(root)).toEqual({ branch: "0123456", detached: true })
  })

  test("not a repository, a broken pointer or a garbage HEAD give an empty answer", () => {
    const root = temp()
    expect(readGitBranch(path.join(root, "nowhere"))).toEqual({})
    writeFileSync(path.join(root, ".git"), "gitdir: ./does-not-exist\n")
    expect(readGitBranch(root)).toEqual({})
    const bad = temp()
    mkdirSync(path.join(bad, ".git"))
    writeFileSync(path.join(bad, ".git", "HEAD"), "nonsense")
    expect(readGitBranch(bad)).toEqual({})
    const broken = temp()
    writeFileSync(path.join(broken, ".git"), "not a pointer")
    expect(readGitBranch(broken)).toEqual({})
  })

  test("non-branch refs keep their full name", () => {
    const root = temp()
    mkdirSync(path.join(root, ".git"))
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/remotes/origin/x\n")
    expect(readGitBranch(root)).toEqual({ branch: "refs/remotes/origin/x" })
  })
})

describe("usage today counter", () => {
  const T0 = new Date(2026, 8, 26, 10).getTime()
  const rec = (at: number, patch: Record<string, number> = {}) => ({ at, input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 0, ...patch })
  function counter(seed = { tokens: 0, calls: 0, costMicros: 0 }) {
    const clock = createVirtualClock(T0)
    const events: UsageTodayEvent[] = []
    const today = createUsageToday({ clock, seed, emit: (event) => void events.push(event) })
    return { clock, events, today }
  }

  test("the first record goes out immediately with the seeded totals included", () => {
    const { events, today } = counter({ tokens: 1_000, calls: 4, costMicros: 0 })
    today.record(rec(T0))
    expect(events).toEqual([{ type: "usage.today", gseq: 0, at: T0, day: "2026-09-26", tokens: 1_175, calls: 5 }])
    expect(GlobalEvent.safeParse(events[0]).success).toBe(true)
  })

  test("a burst is limited to one push per second and ends with the newest totals", () => {
    const { clock, events, today } = counter()
    today.record(rec(T0))
    for (let i = 0; i < 10; i++) {
      clock.advance(50)
      today.record(rec(clock.now()))
    }
    expect(events.length).toBe(1)
    clock.advance(600)
    expect(events.length).toBe(2)
    expect(events[1]).toMatchObject({ calls: 11, tokens: 11 * 175 })
    expect(events[1]!.at - events[0]!.at).toBeGreaterThanOrEqual(1_000)
    clock.advance(5_000)
    expect(events.length).toBe(2)
  })

  test("a record after the window pushes immediately", () => {
    const { clock, events, today } = counter()
    today.record(rec(T0))
    clock.advance(1_000)
    today.record(rec(clock.now()))
    expect(events.map((e) => e.calls)).toEqual([1, 2])
  })

  test("cost appears only once something has a known price", () => {
    const { clock, events, today } = counter()
    today.record(rec(T0))
    clock.advance(1_000)
    today.record(rec(clock.now(), { costMicros: 250_000 }))
    expect(events[0]).not.toHaveProperty("costMicros")
    expect(events[1]).toMatchObject({ costMicros: 250_000 })
  })

  test("the totals reset when the local day changes", () => {
    const { clock, events, today } = counter({ tokens: 9_000, calls: 30, costMicros: 5 })
    today.record(rec(T0))
    clock.advance(24 * 3_600_000)
    today.record(rec(clock.now()))
    expect(events.at(-1)).toMatchObject({ day: "2026-09-27", tokens: 175, calls: 1 })
  })

  test("snapshot reports zero after midnight even without a new record, and stop cancels a pending push", () => {
    const { clock, events, today } = counter()
    today.record(rec(T0))
    expect(today.snapshot()).toMatchObject({ tokens: 175, calls: 1 })
    clock.advance(20 * 3_600_000)
    expect(today.snapshot()).toMatchObject({ day: "2026-09-27", tokens: 0, calls: 0 })
    const other = counter()
    other.today.record(rec(T0))
    other.clock.advance(10)
    other.today.record(rec(other.clock.now()))
    other.today.stop()
    other.clock.advance(2_000)
    expect(other.events.length).toBe(1)
    expect(events.length).toBe(1)
  })
})

describe("daemon feeds for the footer", () => {
  async function boot() {
    const dir = temp()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const seen: UsageTodayEvent[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "A", onEvent: () => {}, onGlobal: (event) => event.type === "usage.today" && seen.push(event) })
    await client.connect()
    cleanups.push(() => client.close())
    return { client, seen }
  }
  const until = async (check: () => boolean, ms = 3_000) => {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await Bun.sleep(5)
    if (!check()) throw new Error("timed out")
  }

  test("a new connection immediately receives today's totals", async () => {
    const { seen } = await boot()
    await until(() => seen.length > 0)
    expect(seen[0]).toMatchObject({ type: "usage.today", tokens: 0, calls: 0 })
  })

  test("recording usage pushes updated totals to connected clients", async () => {
    const { client, seen } = await boot()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/usage", attachments: [] })
    await until(() => seen.some((event) => event.calls >= 1))
    const last = seen.at(-1)!
    expect(last.tokens).toBeGreaterThan(0)
  })

  test("git.branch answers from HEAD and is empty outside a repository", async () => {
    const { client } = await boot()
    const repo = temp()
    mkdirSync(path.join(repo, ".git"))
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/dev\n")
    expect(await client.send({ type: "git.branch", directory: repo })).toEqual({ ok: true, result: { branch: "dev" } })
    expect(await client.send({ type: "git.branch", directory: path.join(temp(), "x") })).toEqual({ ok: true, result: {} })
  })
})
