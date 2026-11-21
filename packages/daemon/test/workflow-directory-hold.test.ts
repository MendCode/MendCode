import { expect, test } from "bun:test"
import type { WorkflowRun } from "@mendcode/protocol"
import { holdsDirectory } from "../src/workflows"

type Task = WorkflowRun["tasks"][number]
const run = (state: WorkflowRun["state"], tasks: Array<Partial<Task>>) => ({ state, tasks: tasks as Task[] })

test("a live run whose work tasks each have their own worktree leaves the directory to another working run", () => {
  // Several mend runs at once: every work agent is in its own checkout.
  expect(holdsDirectory(run("running", [{ mode: "read" }, { mode: "work", isolated: true }, { mode: "work", isolated: true }]))).toBe(false)
})

test("a live run with a work task in the directory itself still holds it, and an ended run never does", () => {
  expect(holdsDirectory(run("running", [{ mode: "work", isolated: true }, { mode: "work" }]))).toBe(true)
  expect(holdsDirectory(run("paused", [{ mode: "work" }]))).toBe(true)
  for (const ended of ["completed", "failed", "stopped"] as const) expect(holdsDirectory(run(ended, [{ mode: "work" }]))).toBe(false)
  expect(holdsDirectory(run("running", [{ mode: "read" }]))).toBe(false)
})
