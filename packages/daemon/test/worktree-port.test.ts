import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const ids = createIdFactory()
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error)
  return out.trim()
}

async function boot(withGit = true) {
  const dir = realpathSync(tempDir("mendcode-wt-data-")), project = realpathSync(tempDir("mendcode-wt-project-"))
  if (withGit) {
    await git(project, "init", "-b", "main")
    writeFileSync(path.join(project, "tracked.txt"), "first\n")
    await git(project, "add", "tracked.txt")
    await git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed")
  }
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  /** A root session in the middle of a turn: the turn started and never ends, as while a tool call runs. */
  const session = (parentId?: SessionId) => {
    const sessionId = ids("session")
    daemon.store.createSession({ id: sessionId, directory: project, title: parentId ? "Child" : "Root", ...(parentId ? { parentId } : {}) })
    return sessionId
  }
  const running = (sessionId: SessionId) => daemon.store.sessionSink.append({ type: "turn.started", sessionId, turnId: ids("turn"), queueId: ids("queue") })
  return { dir, project, daemon, session, running }
}

test("enter creates a worktree and moves the running session into it; the checkout is untouched", async () => {
  const h = await boot()
  const sessionId = h.session()
  h.running(sessionId)
  const port = h.daemon.worktreePort(sessionId)
  expect(port.status()).toContain(`project checkout ${h.project}`)
  const moved = await port.enter({ name: "Side Work" })
  expect(moved.ok).toBe(true)
  if (!moved.ok) return
  expect(moved.directory.startsWith(path.join(h.dir, "worktrees"))).toBe(true)
  expect(moved.text).toContain("branch mend/side-work")
  expect(h.daemon.store.sessionDirectory(sessionId)).toBe(moved.directory)
  expect(h.daemon.store.lastTurnStatus(sessionId)).toBe("running")
  expect(h.daemon.store.readBefore(sessionId, undefined, 1)[0]).toMatchObject({ type: "session.workspace.changed", directory: moved.directory })
  expect(await git(h.project, "status", "--porcelain")).toBe("")
  expect(await git(moved.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("mend/side-work")
  expect(port.status()).toContain(`worktree`)
  expect(port.status()).toContain(moved.directory)
  expect(await port.enter({})).toEqual({ ok: false, message: "this session is already in a worktree; exit it first" })
}, 30_000)

test("exit keeps the worktree by default and remove deletes a clean, merged one", async () => {
  const h = await boot()
  const sessionId = h.session()
  h.running(sessionId)
  const port = h.daemon.worktreePort(sessionId)
  const entered = await port.enter({ name: "keep" })
  if (!entered.ok) throw new Error(entered.message)
  const left = await port.exit({})
  expect(left).toMatchObject({ ok: true, directory: h.project })
  expect(h.daemon.store.sessionDirectory(sessionId)).toBe(h.project)
  expect(existsSync(entered.directory)).toBe(true)
  expect(left.ok && left.text).toContain("it is kept")
  expect(await port.exit({})).toEqual({ ok: false, message: "this session is not in a worktree" })
  const again = await port.enter({ name: "drop" })
  if (!again.ok) throw new Error(again.message)
  const removed = await port.exit({ remove: true })
  expect(removed.ok && removed.text).toContain("Left and removed the worktree")
  expect(existsSync(again.directory)).toBe(false)
  expect(await git(h.project, "branch", "--list", "mend/drop")).toBe("")
  expect(h.daemon.store.sessionDirectory(sessionId)).toBe(h.project)
}, 30_000)

test("exit with remove keeps a worktree that has uncommitted work and says why", async () => {
  const h = await boot()
  const sessionId = h.session()
  const port = h.daemon.worktreePort(sessionId)
  const entered = await port.enter({ name: "dirty" })
  if (!entered.ok) throw new Error(entered.message)
  writeFileSync(path.join(entered.directory, "notes.txt"), "work in progress\n")
  const left = await port.exit({ remove: true })
  expect(left.ok).toBe(true)
  expect(left.ok && left.text).toContain("did not remove it")
  expect(existsSync(path.join(entered.directory, "notes.txt"))).toBe(true)
  expect(h.daemon.store.sessionDirectory(sessionId)).toBe(h.project)
}, 30_000)

test("a session whose child is running, or whose directory is not a repository, stays where it is and leaves nothing behind", async () => {
  const h = await boot()
  const root = h.session()
  const child = h.session(root)
  h.running(child)
  const blocked = await h.daemon.worktreePort(root).enter({ name: "blocked" })
  expect(blocked.ok).toBe(false)
  expect(!blocked.ok && blocked.message).toContain("busy")
  expect(h.daemon.store.sessionDirectory(root)).toBe(h.project)
  expect(existsSync(path.join(h.dir, "worktrees")) ? readdirSync(path.join(h.dir, "worktrees")).filter((entry) => entry.includes("blocked")) : []).toEqual([])
  expect(await git(h.project, "branch", "--list", "mend/blocked")).toBe("")
  const plain = await boot(false)
  const lone = plain.session()
  const refused = await plain.daemon.worktreePort(lone).enter({})
  expect(refused).toMatchObject({ ok: false })
  expect(!refused.ok && refused.message).toContain("Worktrees require Git")
  expect(plain.daemon.store.sessionDirectory(lone)).toBe(plain.project)
}, 30_000)

test("a sub-agent session cannot change worktree, and an idle child moves with its root", async () => {
  const h = await boot()
  const root = h.session()
  const child = h.session(root)
  expect(await h.daemon.worktreePort(child).enter({})).toEqual({ ok: false, message: "only the main session of a conversation can change worktree, not a sub-agent" })
  const entered = await h.daemon.worktreePort(root).enter({ name: "family" })
  if (!entered.ok) throw new Error(entered.message)
  expect(h.daemon.store.sessionDirectory(child)).toBe(entered.directory)
}, 30_000)

test("preview says what will happen and names the problem when the move cannot run", async () => {
  const h = await boot()
  const sessionId = h.session()
  const port = h.daemon.worktreePort(sessionId)
  const enter = await port.preview({ action: "enter", name: "idea" })
  expect(enter.problems).toEqual([])
  expect(enter.detail).toContain(path.join(h.dir, "worktrees"))
  expect(enter.detail).toContain("\"idea\"")
  expect(await port.preview({ action: "exit" })).toEqual({ problems: ["this session is not in a worktree"] })
  await port.enter({})
  expect((await port.preview({ action: "enter" })).problems).toEqual(["this session is already in a worktree; exit it first"])
  expect((await port.preview({ action: "exit", remove: true })).detail).toContain("deleted if it is clean")
}, 30_000)
