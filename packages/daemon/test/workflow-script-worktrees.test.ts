import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"

/** worktree agents + merge() on a real daemon, real git worktrees (made by the workflow router) and the faux engine writing files. */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function until(check: () => boolean, label: string, ms = 30_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-wt-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}

async function boot() {
  const dir = tempDir(), project = tempDir()
  git(project, "init", "-q", "-b", "main")
  writeFileSync(path.join(project, "shared.txt"), "one\ntwo\nthree\n")
  git(project, "add", "-A")
  git(project, "commit", "-q", "-m", "base")
  // The daemon's own git calls (the workflow router, the merge) read the identity from the environment: restore it afterwards.
  const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]))
  Object.assign(process.env, ENV)
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock, store }) => {
      const faux = createFauxEngine({ clock, deltaMs: 1 })
      return {
        ...faux,
        runTurn(input) {
          // The "model" edits its own directory: a file per task, and a conflicting line in shared.txt for the "clash" tasks.
          const title = /Your task: (.*)/.exec(input.text)?.[1]?.trim() ?? "?"
          const cwd = store.sessionDirectory(input.sessionId)!
          if (title.startsWith("edit-")) writeFileSync(path.join(cwd, `${title}.txt`), `by ${title}\n`)
          if (title.startsWith("clash-")) writeFileSync(path.join(cwd, "shared.txt"), `one\n${title} wrote this\nthree\n`)
          return faux.runTurn({ ...input, text: `/say done:${title}` })
        },
      }
    },
  })
  const client = createClient({ socketPath: daemon.socketPath, name: "wt" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const run = (id: string) => daemon.store.workflows.all().find((entry) => entry.workflowId === id)!
  const start = async (script: string) => {
    const started = await client.send({ type: "workflow.start", directory: project, plan: { script } } as never)
    expect(started.ok).toBe(true)
    return (started.ok ? (started.result?.workflow as { workflowId: string }) : undefined)!.workflowId
  }
  return { daemon, client, project, dir, run, start }
}

const SCRIPT = (strategy: string, prefix: string) => `export const meta = { name: "wt", budget: { agents: 6 } }
const results = await parallel([
  () => agent("first", { label: "${prefix}-1", mode: "work", worktree: true, detail: true }),
  () => agent("second", { label: "${prefix}-2", mode: "work", worktree: true, detail: true }),
])
const merged = await merge(results, { strategy: "${strategy}", message: "combine" })
return { branches: results.map((entry) => entry.branch), stats: results.map((entry) => entry.diff.files), merged }`

describe("worktree agents and merge() (real daemon, real git)", () => {
  test("results carry the branch and diff of their worktree; merge builds the integration branch, asks, then merges into the checkout", async () => {
    const h = await boot()
    const id = await h.start(SCRIPT("apply", "edit"))
    await until(() => h.run(id)?.state === "needs_input", "the merge approval")
    const waiting = h.run(id)
    const question = waiting.tasks.find((task) => task.kind === "human")!
    expect(question.title).toContain("into your checkout?")
    expect(question.title).toContain("2 worktree(s), 2 file(s), +2 -0")
    // Before the user says yes, the checkout has nothing: the work sits on branches and in the scratch integration worktree.
    expect(existsSync(path.join(h.project, "edit-1.txt"))).toBe(false)
    expect(git(h.project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(git(h.project, "branch", "--list", "mend/*").split("\n").map((line) => line.replace(/^[*+ ]+/, "")).filter(Boolean).length).toBe(3)
    expect((await h.client.send({ type: "workflow.control", workflowId: id, action: "approve", taskId: question.id, reason: "merge" } as never)).ok).toBe(true)
    await until(() => h.run(id)?.state === "completed", "the run to complete")
    const full = await h.client.send({ type: "workflow.get", workflowId: id } as never)
    const result = JSON.parse((full.ok ? (full.result?.workflow as { script: { result: string } }) : undefined)!.script.result)
    expect(result.stats).toEqual([1, 1])
    expect(result.branches.every((branch: string) => branch.startsWith("mend/wf-"))).toBe(true)
    expect(result.merged).toMatchObject({ applied: true, files: 2, insertions: 2, into: "main", merged: result.branches })
    expect(readFileSync(path.join(h.project, "edit-1.txt"), "utf8")).toBe("by edit-1\n")
    expect(readFileSync(path.join(h.project, "edit-2.txt"), "utf8")).toBe("by edit-2\n")
    expect(git(h.project, "status", "--porcelain")).toBe("")
  }, 90_000)

  test("conflicting worktrees pause the run; resolving in the integration worktree and resuming finishes the merge", async () => {
    const h = await boot()
    const id = await h.start(SCRIPT("branch", "clash"))
    await until(() => h.run(id)?.state === "paused", "the conflict pause")
    const paused = h.run(id)
    expect(paused.reason).toContain("merge conflict in 1 file(s): shared.txt")
    const worktree = /integration worktree (\S+), branch/.exec(paused.reason ?? "")![1]!
    expect(worktree.startsWith(path.join(h.dir, "workflows", "merge"))).toBe(true)
    expect(readFileSync(path.join(worktree, "shared.txt"), "utf8")).toContain("<<<<<<<")
    expect(readFileSync(path.join(h.project, "shared.txt"), "utf8")).toBe("one\ntwo\nthree\n")
    writeFileSync(path.join(worktree, "shared.txt"), "one\nboth wrote this\nthree\n")
    git(worktree, "add", "shared.txt")
    expect((await h.client.send({ type: "workflow.control", workflowId: id, action: "resume" } as never)).ok).toBe(true)
    await until(() => h.run(id)?.state === "completed", "the resumed run to complete")
    const full = await h.client.send({ type: "workflow.get", workflowId: id } as never)
    const result = JSON.parse((full.ok ? (full.result?.workflow as { script: { result: string } }) : undefined)!.script.result)
    expect(result.merged).toMatchObject({ applied: false, files: 1 })
    expect(git(worktree, "show", "HEAD:shared.txt")).toBe("one\nboth wrote this\nthree")
    // strategy "branch" never touches the checkout.
    expect(readFileSync(path.join(h.project, "shared.txt"), "utf8")).toBe("one\ntwo\nthree\n")
  }, 90_000)
})
