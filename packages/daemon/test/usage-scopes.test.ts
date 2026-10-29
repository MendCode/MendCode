import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, UsageReport } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { usageProject } from "../src/usage"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ids = createIdFactory()

function projectFixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-usage-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, "repo"), other = path.join(dir, "other"), worktree = path.join(dir, "linked"), child = path.join(repo, "src")
  for (const folder of [path.join(child, "deep"), path.join(child, "nested", ".git"), path.join(repo, "src-other"), path.join(repo, "tests"), path.join(repo, ".git", "worktrees", "linked"), path.join(other, ".git"), worktree]) mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${repo}/.git/worktrees/linked\n`)
  writeFileSync(path.join(repo, ".git", "worktrees", "linked", "commondir"), "../..\n")
  return { dir, repo, other, worktree, child }
}

test("project identity groups subdirectories and linked worktrees; non-Git folders remain separate", () => {
  const f = projectFixture()
  expect(usageProject(f.child)).toEqual({ id: f.repo, directory: f.repo })
  expect(usageProject(f.worktree)).toEqual(usageProject(f.repo))
  expect(usageProject(f.other).id).not.toBe(f.repo)
  expect(usageProject(path.join(f.dir, "plain")).id).toBe(path.join(f.dir, "plain"))
})

test("daemon/client scope transport filters project, directory and explicit project without changing global quotas", async () => {
  const f = projectFixture()
  const now = Date.UTC(2026, 8, 30, 12)
  const daemon = await startDaemon({ dir: path.join(f.dir, "data"), socketPath: path.join(f.dir, "u.sock"), defaultDirectory: f.child, clock: { now: () => now, setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) } } },
    engine: ({ store, clock }) => {
      for (const [directory, tokens] of [[f.child, 100], [path.join(f.child, "deep"), 50], [path.join(f.repo, "src-other"), 400],
        [path.join(f.child, "nested"), 5000], [path.join(f.repo, "tests"), 200], [f.worktree, 300], [f.other, 1000]] as const) {
        const sessionId = ids("session")
        store.createSession({ id: sessionId, directory, title: directory })
        store.sessionSink.append({ type: "usage.recorded", sessionId, turnId: ids("turn"), provider: "local", model: "fake", input: tokens, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
      }
      return createFauxEngine({ clock, deltaMs: 1 })
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "usage-scopes", reconnect: false })
  cleanups.push(() => client.close())
  await client.connect()
  const query = async (scope: "global" | "project" | "directory", project?: string) => {
    const reply = await client.usage({ from: "2026-01-01", to: "2026-12-31", scope, ...(project ? { project } : {}) })
    expect(reply.ok).toBe(true)
    if (!reply.ok) throw new Error(reply.error.message)
    return UsageReport.parse(reply.report)
  }
  const global = await query("global"), project = await query("project"), directory = await query("directory"), other = await query("project", f.other)
  expect(global.days[0]!.input).toBe(7050)
  expect(project.days[0]!.input).toBe(1050)
  expect(project.sessions).toBe(5)
  expect(project.scope).toEqual({ kind: "project", directory: f.repo, project: f.repo })
  expect(project.projects).toEqual([{ id: f.other, directory: f.other }, { id: f.repo, directory: f.repo }, { id: path.join(f.child, "nested"), directory: path.join(f.child, "nested") }])
  expect(directory.days[0]!.input).toBe(150)
  expect(directory.sessions).toBe(2)
  expect(other.days[0]!.input).toBe(1000)
  expect(project.quotas).toEqual(global.quotas)
  expect(await client.usage({ from: "2026-10-01", to: "2026-09-01" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})
