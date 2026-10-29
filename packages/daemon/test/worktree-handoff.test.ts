import { afterEach, expect, test } from "bun:test"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { worktreeNames } from "../src/worktree-port"
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
const commit = (directory: string, message: string) => git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", message)

async function boot() {
  const dir = realpathSync(tempDir("mendcode-wt-data-")), project = realpathSync(tempDir("mendcode-wt-project-"))
  await git(project, "init", "-b", "main")
  writeFileSync(path.join(project, "tracked.txt"), "first\n")
  await git(project, "add", "tracked.txt")
  await commit(project, "seed")
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const session = (parentId?: SessionId) => {
    const sessionId = ids("session")
    daemon.store.createSession({ id: sessionId, directory: project, title: parentId ? "Child" : "Root", ...(parentId ? { parentId } : {}) })
    return sessionId
  }
  return { dir, project, daemon, session }
}

test("list shows the project's worktrees with the session's own marked, and handoff moves into an existing one by name, branch or directory", async () => {
  const h = await boot()
  const owner = h.session()
  const port = h.daemon.worktreePort(owner)
  const first = await port.enter({ name: "alpha" })
  if (!first.ok) throw new Error(first.message)
  await port.exit({})
  const second = await port.enter({ name: "beta" })
  if (!second.ok) throw new Error(second.message)
  const listed = await port.list!()
  expect(listed).toContain("2 worktrees of this project")
  expect(listed).toContain(`* beta · branch mend/beta · ${second.directory} · this session`)
  expect(listed).toContain(`- alpha · branch mend/alpha · ${first.directory}`)
  expect(await port.handoff!({ target: "mend/alpha" })).toMatchObject({ ok: true, directory: first.directory })
  expect(h.daemon.store.sessionDirectory(owner)).toBe(first.directory)
  expect(await port.handoff!({ target: "alpha" })).toEqual({ ok: false, message: "this session already works in that worktree" })
  expect(await port.handoff!({ target: second.directory })).toMatchObject({ ok: true, directory: second.directory })
  expect(await port.handoff!({ target: "nope" })).toMatchObject({ ok: false, message: expect.stringContaining("no worktree of this project matches") })
  expect((await port.preview({ action: "handoff", target: "alpha" })).detail).toContain("existing worktree alpha")
  expect(await port.preview({ action: "handoff" })).toEqual({ problems: ["handoff needs target"] })
  expect(await h.daemon.worktreePort(h.session()).handoff!({ target: "alpha" })).toMatchObject({ ok: true, directory: first.directory })
  expect(await h.daemon.worktreePort(h.session(owner)).handoff!({ target: "alpha" })).toEqual({ ok: false, message: "only the main session of a conversation can change worktree, not a sub-agent" })
}, 60_000)

test("close removes a clean merged worktree nobody works in, refuses an occupied one, and leaves the session's own first", async () => {
  const h = await boot()
  const owner = h.session()
  const port = h.daemon.worktreePort(owner)
  const a = await port.enter({ name: "gone" })
  if (!a.ok) throw new Error(a.message)
  await port.exit({})
  const b = await port.enter({ name: "busy" })
  if (!b.ok) throw new Error(b.message)
  expect((await port.preview({ action: "close", target: "gone" })).detail).toContain("Delete the worktree gone")
  expect(await port.close!({ target: "gone" })).toMatchObject({ ok: true, text: expect.stringContaining("Closed the worktree gone") })
  expect(existsSync(a.directory)).toBe(false)
  expect(await git(h.project, "branch", "--list", "mend/gone")).toBe("")
  expect(await h.daemon.worktreePort(h.session()).close!({ target: "busy" })).toMatchObject({ ok: false, message: expect.stringContaining("was kept") })
  expect(existsSync(b.directory)).toBe(true)
  expect(await port.close!({})).toMatchObject({ ok: true, directory: h.project, text: expect.stringContaining("Left and removed the worktree") })
  expect(h.daemon.store.sessionDirectory(owner)).toBe(h.project)
  expect(await port.close!({})).toEqual({ ok: false, message: "this session is not in a worktree; give a target" })
}, 60_000)

test("enter starts from a base ref, so a change can be stacked on another branch", async () => {
  const h = await boot()
  await git(h.project, "checkout", "-b", "parent")
  writeFileSync(path.join(h.project, "parent.txt"), "parent work\n")
  await git(h.project, "add", "parent.txt")
  await commit(h.project, "parent")
  await git(h.project, "checkout", "main")
  const port = h.daemon.worktreePort(h.session())
  const entered = await port.enter({ name: "child", base: "parent" })
  if (!entered.ok) throw new Error(entered.message)
  expect(entered.text).toContain("started from parent")
  expect(existsSync(path.join(entered.directory, "parent.txt"))).toBe(true)
  await port.exit({})
  expect(await port.enter({ name: "lost", base: "no-such-ref" })).toMatchObject({ ok: false, message: expect.stringContaining("does not resolve to a commit") })
  expect(await git(h.project, "branch", "--list", "mend/lost")).toBe("")
}, 60_000)

test("worktreeNames: static ignores the model's branch, semantic uses its type, custom takes the whole name, bad names are refused", () => {
  expect(worktreeNames({ naming: undefined, name: "Login Fix", branch: "x" })).toEqual({ ok: true, name: "login-fix" })
  expect(worktreeNames({ naming: { mode: "static", prefix: "team/" }, name: "Login Fix" })).toEqual({ ok: true, name: "login-fix", branch: "team/login-fix" })
  expect(worktreeNames({ naming: { mode: "semantic" }, name: "login", branch: "Fix/" })).toEqual({ ok: true, name: "login", branch: "fix/login" })
  expect(worktreeNames({ naming: { mode: "semantic" }, name: "login" })).toMatchObject({ ok: true, name: "login", note: expect.stringContaining("static prefix") })
  expect(worktreeNames({ naming: { mode: "semantic" }, name: "login", branch: "a/b" }).ok).toBe(false)
  expect(worktreeNames({ naming: { mode: "custom" }, name: "x", branch: "ABC-1/retry" })).toEqual({ ok: true, name: "x", branch: "ABC-1/retry" })
  for (const bad of ["-rf", "a..b", "a//b", "a/", "x.lock", "a b"]) expect(worktreeNames({ naming: { mode: "custom" }, name: "x", branch: bad }).ok).toBe(false)
  expect(worktreeNames({ naming: undefined, name: ".." }).ok).toBe(false)
})

test("branch naming follows the worktreeBranch setting end to end", async () => {
  const h = await boot()
  const port = h.daemon.worktreePort(h.session())
  expect(port.status()).toContain("Branch naming: mend/<name>")
  h.daemon.store.settings.set({ worktreeBranch: { mode: "static", prefix: "team/" } })
  const staticTree = await port.enter({ name: "Login Fix", branch: "ignored" })
  if (!staticTree.ok) throw new Error(staticTree.message)
  expect(await git(staticTree.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("team/login-fix")
  await port.exit({})
  h.daemon.store.settings.set({ worktreeBranch: { mode: "semantic" } })
  expect(port.status()).toContain("choose a short type")
  const semantic = await port.enter({ name: "login redirect", branch: "Fix" })
  if (!semantic.ok) throw new Error(semantic.message)
  expect(await git(semantic.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fix/login-redirect")
  await port.exit({})
  h.daemon.store.settings.set({ worktreeBranch: { mode: "custom", instruction: "ticket id first" } })
  expect(port.status()).toContain("ticket id first")
  const custom = await port.enter({ name: "x", branch: "ABC-123/payment-retry" })
  if (!custom.ok) throw new Error(custom.message)
  expect(await git(custom.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ABC-123/payment-retry")
  await port.exit({})
  expect(await port.enter({ name: "clash", branch: "ABC-123/payment-retry" })).toMatchObject({ ok: false, message: expect.stringContaining("already exists") })
}, 90_000)
