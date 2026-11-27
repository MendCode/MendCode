import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, WorkflowPlan } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createRun } from "@mendcode/workflows"
import { moveStoredDirectories } from "../src/move-session-dirs"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-move-")); dirs.push(dir); return dir }

// The writer exits before the move, as the daemon does: the move is offline maintenance.
function seed(dir: string, directories: string[]) {
  const store = path.resolve(import.meta.dir, "../../store/src/index.ts")
  const make = createIdFactory()
  const ids = directories.map(() => make("session"))
  const script = `import {openStore} from ${JSON.stringify(store)}
const store = openStore({dir: ${JSON.stringify(dir)}})
${directories.map((directory, i) => `store.createSession({id: ${JSON.stringify(ids[i])}, directory: ${JSON.stringify(directory)}, title: "t${i}"})`).join("\n")}
store.close()`
  const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  return ids
}
const stored = (dir: string) => {
  const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
  try { return db.query<{ id: string; directory: string }, []>("SELECT id, directory FROM sessions ORDER BY title").all().map((row) => row.directory) } finally { db.close() }
}

test("moving a folder prefix rewrites whole path segments only, keeps a backup, and a preview changes nothing", () => {
  const dir = temp()
  seed(dir, ["/home/dev/Code", "/home/dev/Code/app/pkg", "/home/dev/Codex/app", "/home/dev/Code2", "/srv/other"])
  expect(moveStoredDirectories({ dir, from: "/home/dev/Code/", to: "/home/dev/projects", dryRun: true })).toMatchObject({ dryRun: true, total: 2, moved: { sessions: 2 } })
  expect(stored(dir)[0]).toBe("/home/dev/Code")

  const done = moveStoredDirectories({ dir, from: "/home/dev/Code", to: "/home/dev/projects", now: () => 1 })
  expect(done).toMatchObject({ dryRun: false, total: 2, moved: { sessions: 2 } })
  expect(stored(dir)).toEqual(["/home/dev/projects", "/home/dev/projects/app/pkg", "/home/dev/Codex/app", "/home/dev/Code2", "/srv/other"])
  expect(readdirSync(dir)).toContain("mendd.db.before-move-1")
  const backup = new Database(path.join(dir, "mendd.db.before-move-1"), { readonly: true })
  try { expect(backup.query<{ directory: string }, []>("SELECT directory FROM sessions ORDER BY title").all()[0]!.directory).toBe("/home/dev/Code") } finally { backup.close() }

  // Nothing left to move: no second backup is written.
  expect(moveStoredDirectories({ dir, from: "/home/dev/Code", to: "/home/dev/projects" })).toMatchObject({ total: 0 })
  expect(readdirSync(dir).filter((name) => name.includes("before-move"))).toHaveLength(1)
})

test("a workflow moves with its stored folder and its tasks' folders, not only the indexed column", () => {
  const dir = temp()
  const ids = createIdFactory()
  const store = openStore({ dir })
  const rootSessionId = ids("session")
  store.createSession({ id: rootSessionId, directory: "/home/dev/Code/app", title: "t" })
  const plan = WorkflowPlan.parse({ name: "ship", objective: "Say hi.", tasks: [{ kind: "agent", id: "hello", title: "Say hello", prompt: "say hi", mode: "read" }] })
  const run = createRun({ workflowId: ids("workflow"), plan, planHash: "0".repeat(64), directory: "/home/dev/Code/app", permission: "ask", rootSessionId, at: 1_000 })
  store.workflows.save(run)
  store.close()
  expect(moveStoredDirectories({ dir, from: "/home/dev/Code", to: "/home/dev/projects" })).toMatchObject({ moved: { workflows: 1 } })
  const after = openStore({ dir })
  try {
    expect(after.workflows.all().map((item) => item.directory)).toEqual(["/home/dev/projects/app"])
    expect(JSON.stringify(after.workflows.all())).not.toContain("/home/dev/Code")
  } finally { after.close() }
})

test("a relative folder, the root and an identical pair are refused", () => {
  const dir = temp()
  seed(dir, ["/a"])
  expect(() => moveStoredDirectories({ dir, from: "a", to: "/b" })).toThrow("absolute")
  expect(() => moveStoredDirectories({ dir, from: "/", to: "/b" })).toThrow("absolute")
  expect(() => moveStoredDirectories({ dir, from: "/a", to: "/a/" })).toThrow("same")
})
