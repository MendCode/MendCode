import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionId, TaskRecord } from "@mendcode/protocol"
import { boot, callTool, openSession, say, stop, type NativeHarness } from "./native-harness"

/** `task` with `isolation: "worktree"` on the daemon: a real git checkout in a temp folder, real worktrees, a scripted model. */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}

async function start(steps: NonNullable<Parameters<typeof boot>[0]>["steps"], options: { commit?: boolean } = {}) {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-task-wt-")))
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  git(project, "init", "-q", "-b", "main")
  writeFileSync(path.join(project, "shared.txt"), "one\n")
  if (options.commit !== false) {
    git(project, "add", "-A")
    git(project, "commit", "-q", "-m", "base")
  }
  // The daemon's git calls read the commit identity from the environment: restore it afterwards.
  const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]))
  Object.assign(process.env, ENV)
  cleanups.push(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value })
  const h = await boot({ project, ...(steps ? { steps } : {}) })
  cleanups.push(() => h.cleanup())
  return { h, project }
}
const children = (h: NativeHarness, parent: SessionId) => h.store.tasks.list().filter((task) => task.parentId === parent)

test("an isolated child works in its own worktree; its changes end on a branch, never in the checkout", async () => {
  const { h, project } = await start([
    callTool("task", { description: "Add notes", prompt: "Write notes.txt", isolation: "worktree" }),
    callTool("write", { path: "notes.txt", content: "from the child\n" }),
    stop("wrote notes.txt"),
    stop("parent done"),
  ])
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  await say(h, parent, "delegate in isolation")
  expect(h.requests[0]!.tools.find((tool) => tool.name === "task")!.parameters).toMatchObject({ properties: { isolation: expect.anything() } })
  const task = children(h, parent)[0]! as TaskRecord & { worktree: NonNullable<TaskRecord["worktree"]> }
  expect(task.state).toBe("completed")
  const { branch, files, insertions, base } = task.worktree
  expect([branch?.startsWith("mend/task-"), files, insertions, base]).toEqual([true, 1, 1, git(project, "rev-parse", "HEAD")])
  expect(h.store.sessionDirectory(task.taskId)).toBe(task.worktree.path)
  expect(readFileSync(path.join(task.worktree.path, "notes.txt"), "utf8")).toBe("from the child\n")
  expect(existsSync(path.join(project, "notes.txt"))).toBe(false)
  // The checkout keeps its branch; the child's commit lives on a branch of its own.
  expect(git(project, "symbolic-ref", "--short", "HEAD")).toBe("main")
  expect(git(project, "log", "--format=%s", task.worktree.branch!)).toContain("task general: Add notes")
  const told = JSON.stringify(h.requests[3]!.messages.at(-1))
  expect(told).toContain(`[worktree] ${task.worktree.path} · branch ${task.worktree.branch}`)
  expect(told).toContain("not merged; review: git diff")
  rmSync(task.worktree.path, { recursive: true, force: true })
})

test("isolation is refused outside the full tier and without a commit, and balanced does not offer the argument", async () => {
  const { h } = await start([stop("plain"), stop("spare")], { commit: false })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  await say(h, parent, "hello")
  expect(JSON.stringify(h.requests[0]!.tools.find((tool) => tool.name === "task")!.parameters)).not.toContain("isolation")
  const balanced = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", isolation: "worktree" } })
  expect(balanced).toMatchObject({ ok: false, error: { message: expect.stringContaining("needs the full tier") } })
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  const empty = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "x", prompt: "x", isolation: "worktree" } })
  expect(empty).toMatchObject({ ok: false, error: { message: expect.stringContaining("needs a commit") } })
  // Nothing was started: no child counts against the budget.
  expect(children(h, parent)).toHaveLength(0)
})
