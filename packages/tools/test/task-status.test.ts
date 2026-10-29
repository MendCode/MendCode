import { afterEach, describe, expect, test } from "bun:test"
import { createBackgroundTasks, runTool, shellOutput, taskStatus, type BackgroundTasks, type WorkflowPort } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tempDir = useTempDir()
const registries: BackgroundTasks[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop()
})

function registry() {
  const tasks = createBackgroundTasks({})
  registries.push(tasks)
  return tasks
}

/** A workflow port that answers like the daemon's: a receipt per id, or the recent ones. */
const workflows: WorkflowPort = {
  preview: async () => ({ problems: [] }),
  start: async () => ({ ok: false, message: "not here" }),
  status: async (id) => (id ? `workflow ${id}: 2/3 tasks done` : "recent: alpha (running), beta (done)"),
}

async function until(check: () => boolean) {
  const end = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("task_status", () => {
  test("a background task: state, unread output and the end of the output, without consuming anything", async () => {
    const tasks = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "echo first; echo second; sleep 5", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const context = { ...makeContext({ cwd: tempDir() }), background: port }
    await until(() => (port.peek(started.task.id, 100)?.tail ?? "").includes("second"))

    const status = await runTool(taskStatus, { id: started.task.id }, context)
    expect(status.isError).toBe(false)
    expect(status.output).toContain(`${started.task.id} running`)
    expect(status.output).toContain("sleep 5")
    expect(status.output).toContain("13 characters of output not read yet")
    expect(status.output).toContain("first\nsecond")
    expect(status.meta).toMatchObject({ status: "running", unread: 13 })

    // Looking again (and with a short tail) still sees everything: nothing was consumed.
    const again = await runTool(taskStatus, { id: started.task.id, tailChars: 7 }, context)
    expect(again.output).toContain("13 characters of output not read yet")
    expect(again.output).toContain("--- end of output ---\nsecond\n")
    // shell_output still delivers it all, and only then does the unread count drop.
    const read = await runTool(shellOutput, { id: started.task.id }, context)
    expect(read.output).toContain("first\nsecond")
    expect((await runTool(taskStatus, { id: started.task.id, tailChars: 0 }, context)).output).toContain("0 characters of output not read yet")
  })

  test("a finished task shows its exit code and how it ended", async () => {
    const tasks = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "echo done; exit 4", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    await until(() => port.list()[0]?.status === "exited")
    const status = await runTool(taskStatus, { id: started.task.id }, { ...makeContext({ cwd: tempDir() }), background: port })
    expect(status.output).toContain("exited 4")
    expect(status.meta).toMatchObject({ status: "exited", exitCode: 4 })
  })

  test("another session's task, or an unknown id, is unknown", async () => {
    const tasks = registry()
    const mine = tasks.forSession("s1")
    const theirs = tasks.forSession("s2").start({ command: "sleep 5", cwd: tempDir() })
    if (!theirs.ok) throw new Error(theirs.error)
    const result = await runTool(taskStatus, { id: theirs.task.id }, { ...makeContext({ cwd: tempDir() }), background: mine })
    expect(result).toMatchObject({ isError: true, output: `unknown task ${theirs.task.id}` })
    expect((await runTool(taskStatus, { id: "bg_nope" }, { ...makeContext({ cwd: tempDir() }), background: mine })).isError).toBe(true)
  })

  test("a workflow id goes to the workflow status; without an id both kinds are listed", async () => {
    const tasks = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "sleep 5", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const context = { ...makeContext({ cwd: tempDir() }), background: port, workflows }
    expect(await runTool(taskStatus, { id: "workflow_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, context)).toMatchObject({ isError: false, output: "workflow workflow_01ARZ3NDEKTSV4RRFFQ69G5FAV: 2/3 tasks done" })
    const list = await runTool(taskStatus, {}, context)
    expect(list.output).toContain(`Background tasks:\n${started.task.id} running`)
    expect(list.output).toContain("Workflows:\nrecent: alpha (running), beta (done)")
    expect(list.meta).toMatchObject({ background: 1, running: 1 })
  })

  test("without the ports it says what is missing instead of failing oddly", async () => {
    const bare = makeContext({ cwd: tempDir() })
    expect(await runTool(taskStatus, {}, bare)).toMatchObject({ isError: false, output: "Background tasks:\nnone" })
    expect(await runTool(taskStatus, { id: "bg_1" }, bare)).toMatchObject({ isError: true, output: "background tasks are not available here" })
    expect(await runTool(taskStatus, { id: "workflow_x" }, bare)).toMatchObject({ isError: true, output: "workflows are not available here" })
    expect((await runTool(taskStatus, { tailChars: 99_999 }, bare)).isError).toBe(true)
  })
})
