import { afterEach, describe, expect, test } from "bun:test"
import { createBackgroundTasks, shell, shellKill, shellOutput, taskStatus, type BackgroundTaskInfo, type BackgroundTasks } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tempDir = useTempDir()
const registries: BackgroundTasks[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop()
})

type Exit = { sessionId: string; task: BackgroundTaskInfo; tail: string }
function registry(limits: Parameters<typeof createBackgroundTasks>[0]["limits"] = {}) {
  const exits: Exit[] = []
  let notify: (() => void) | undefined
  const tasks = createBackgroundTasks({ limits, onExit: (sessionId, task, tail) => (exits.push({ sessionId, task, tail }), notify?.()) })
  registries.push(tasks)
  const nextExit = () => new Promise<void>((resolve) => (notify = resolve))
  return { tasks, exits, nextExit }
}
const never = new AbortController().signal

describe("background tasks", () => {
  test("a task runs detached, its output is read incrementally, and its natural exit is reported once", async () => {
    const { tasks, exits, nextExit } = registry()
    const port = tasks.forSession("s1")
    const exited = nextExit()
    const started = port.start({ command: "echo one; sleep 0.2; echo two; exit 3", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const first = await port.read(started.task.id, { waitMs: 2_000, signal: never })
    expect(first?.output).toBe("one\n")
    expect(first?.task.status).toBe("running")
    await exited
    const rest = await port.read(started.task.id, { waitMs: 0, signal: never })
    expect(rest).toMatchObject({ output: "two\n", dropped: 0, task: { status: "exited", exitCode: 3 } })
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ sessionId: "s1", task: { id: started.task.id, status: "exited", exitCode: 3 }, tail: "one\ntwo\n" })
  })

  test("waiting returns as soon as output arrives, and returns empty when the wait runs out", async () => {
    const { tasks } = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "sleep 0.1; echo late; sleep 5", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const t0 = Date.now()
    expect((await port.read(started.task.id, { waitMs: 3_000, signal: never }))?.output).toBe("late\n")
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect((await port.read(started.task.id, { waitMs: 50, signal: never }))?.output).toBe("")
  })

  test("killing by the agent, a deleted session or shutdown sends no exit notice; the lifetime cap does", async () => {
    const { tasks, exits, nextExit } = registry({ maxLifetimeMs: 150 })
    const port = tasks.forSession("s1")
    const agent = port.start({ command: "sleep 30", cwd: tempDir() })
    const other = tasks.forSession("s2").start({ command: "sleep 30", cwd: tempDir() })
    if (!agent.ok || !other.ok) throw new Error("start failed")
    port.kill(agent.task.id)
    tasks.killSession("s2")
    const capped = nextExit()
    const long = port.start({ command: "sleep 30", cwd: tempDir() })
    await capped
    expect(exits.map((e) => e.task.killedBy)).toEqual(["lifetime"])
    expect(exits[0]!.task.id).toBe(long.ok ? long.task.id : "")
    expect(port.list().find((t) => t.id === agent.task.id)).toMatchObject({ status: "killed", killedBy: "agent" })
  })

  test("the user stops a task: it ends killed by the user, no exit notice wakes the model, and its read says so", async () => {
    const { tasks, exits } = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "sleep 30", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    expect(tasks.stopByUser("s2", started.task.id)).toBeUndefined()
    expect(tasks.stopByUser("s1", started.task.id)?.killedBy).toBe("user")
    const read = await port.read(started.task.id, { waitMs: 3_000, signal: never })
    expect(read?.task).toMatchObject({ status: "killed", killedBy: "user" })
    expect(exits).toEqual([])
  })

  test("a session cannot see, read or kill another session's tasks", async () => {
    const { tasks } = registry()
    const mine = tasks.forSession("s1").start({ command: "sleep 30", cwd: tempDir() })
    if (!mine.ok) throw new Error(mine.error)
    const theirs = tasks.forSession("s2")
    expect(theirs.list()).toEqual([])
    expect(await theirs.read(mine.task.id, { waitMs: 0, signal: never })).toBeUndefined()
    expect(theirs.kill(mine.task.id)).toBeUndefined()
    expect(tasks.forSession("s1").list()[0]!.status).toBe("running")
  })

  test("running tasks are capped; output beyond the buffer scrolls out and is reported as dropped", async () => {
    const { tasks, nextExit } = registry({ maxRunning: 1, maxBufferChars: 100 })
    const port = tasks.forSession("s1")
    const exited = nextExit()
    const loud = port.start({ command: "for i in $(seq 1 50); do echo line$i; done", cwd: tempDir() })
    if (!loud.ok) throw new Error(loud.error)
    expect(port.start({ command: "true", cwd: tempDir() })).toMatchObject({ ok: false })
    await exited
    const read = await port.read(loud.task.id, { waitMs: 0, signal: never })
    expect(read!.output.length).toBeLessThanOrEqual(100)
    expect(read!.output.endsWith("line50\n")).toBe(true)
    expect(read!.dropped).toBeGreaterThan(0)
    expect(port.start({ command: "true", cwd: tempDir() }).ok).toBe(true)
  })

  test("only the newest finished tasks stay readable", async () => {
    const { tasks, nextExit } = registry({ maxFinished: 2 })
    const port = tasks.forSession("s1")
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const exited = nextExit()
      const started = port.start({ command: "true", cwd: tempDir() })
      if (started.ok) ids.push(started.task.id)
      await exited
    }
    expect(port.list().map((t) => t.id)).toEqual(ids.slice(1))
  })
})

describe("shell background, shell_output and shell_kill", () => {
  test("shell with background returns a task id at once; shell_output waits for and returns its output; shell_kill stops it", async () => {
    const { tasks } = registry()
    const cwd = tempDir()
    const context = { ...makeContext({ cwd }), background: tasks.forSession("s1") }
    const started = await shell.execute({ command: "echo ready; sleep 30", background: true }, context)
    expect(started.isError).toBe(false)
    const id = String(started.meta?.taskId)
    expect(started.output).toContain(`started ${id}`)
    const output = await shellOutput.execute({ id, waitMs: 3_000 }, context)
    expect(output.output).toContain(`${id} running`)
    expect(output.output).toContain("ready")
    expect((await shellOutput.execute({}, context)).output).toContain("sleep 30")
    expect((await shellKill.execute({ id }, context)).output).toBe(`stopping ${id}`)
    expect((await shellKill.execute({ id: "bg_nope" }, context)).isError).toBe(true)
  })

  test("binary output of a background task is one line in shell_output, task_status and the exit notice; later text is shown", async () => {
    const { tasks, exits, nextExit } = registry()
    const context = { ...makeContext({ cwd: tempDir() }), background: tasks.forSession("s1") }
    const exited = nextExit()
    const started = await shell.execute({ command: "head -c 5000 /dev/urandom; sleep 0.4; echo plain text after", background: true }, context)
    const id = String(started.meta?.taskId)
    await Bun.sleep(200)
    const peek = await taskStatus.execute({ id }, context)
    expect(peek.output).toMatch(/--- end of output ---\n\[binary output: [\d,]+ characters; not shown\. Use file, xxd \| head, or strings to inspect it\]$/)
    const first = await shellOutput.execute({ id }, context)
    expect(first.output).toMatch(/running \d+s\n\[binary output: [\d,]+ characters; not shown\. Use file, xxd \| head, or strings to inspect it\]$/)
    expect(first.output).not.toContain("�")
    await exited
    expect((await shellOutput.execute({ id }, context)).output).toMatch(/exited 0 after \d+s\nplain text after\n$/)
    expect(exits[0]?.tail.startsWith("[binary output: 2,000 characters; not shown.")).toBe(true)
  })

  test("shell_output until exit returns when the task ends, not when it prints, with the unread output and the exit status", async () => {
    const { tasks } = registry()
    const context = { ...makeContext({ cwd: tempDir() }), background: tasks.forSession("s1") }
    const started = await shell.execute({ command: "echo one; sleep 0.25; echo two; sleep 0.25; echo three; exit 4", background: true }, context)
    const id = String(started.meta?.taskId)
    const t0 = Date.now()
    const result = await shellOutput.execute({ id, until: "exit", waitMs: 10_000 }, context)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(result.output).toMatch(new RegExp(`^${id} exited 4 after \\d+s\none\ntwo\nthree\n$`))
    expect(result.meta).toMatchObject({ taskId: id, status: "exited", exitCode: 4 })
    // The model has the exit and the last output: the exit notice would repeat them.
    expect(tasks.exitShown("s1", id)).toBe(true)
    expect(tasks.exitShown("s2", id)).toBe(false)
  })

  test("the wait for an exit is capped, ends at its time limit with the task still running, and a partial read leaves the exit unshown", async () => {
    const { tasks, nextExit } = registry()
    const context = { ...makeContext({ cwd: tempDir() }), background: tasks.forSession("s1") }
    expect(shellOutput.args.safeParse({ id: "bg_1", until: "exit", waitMs: 600_000 }).success).toBe(true)
    expect(shellOutput.args.safeParse({ id: "bg_1", until: "exit", waitMs: 600_001 }).success).toBe(false)
    const exited = nextExit()
    const started = await shell.execute({ command: "echo early; sleep 0.6; echo late; sleep 0.3", background: true }, context)
    const id = String(started.meta?.taskId)
    const t0 = Date.now()
    const waited = await shellOutput.execute({ id, until: "exit", waitMs: 150 }, context)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(waited.output).toMatch(new RegExp(`^${id} running \\d+s\nearly\n$`))
    expect(tasks.exitShown("s1", id)).toBe(false)
    // Without until, a longer waitMs is the 30 s output wait: it returns on the next line, still before the exit.
    expect((await shellOutput.execute({ id, waitMs: 600_000 }, context)).output).toContain("running")
    await exited
    expect(tasks.exitShown("s1", id)).toBe(false)
    expect((await shellOutput.execute({ id }, context)).output).toContain("exited 0")
    expect(tasks.exitShown("s1", id)).toBe(true)
  })

  test("a wait for an exit ends when the turn is cancelled or the task is killed", async () => {
    const { tasks } = registry()
    const abort = new AbortController()
    const context = { ...makeContext({ cwd: tempDir(), signal: abort.signal }), background: tasks.forSession("s1") }
    const started = await shell.execute({ command: "echo up; sleep 30", background: true }, context)
    const id = String(started.meta?.taskId)
    const t0 = Date.now()
    setTimeout(() => abort.abort(), 100)
    const cancelled = await shellOutput.execute({ id, until: "exit", waitMs: 60_000 }, context)
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(cancelled.output).toContain(`${id} running`)
    const again = { ...makeContext({ cwd: tempDir() }), background: tasks.forSession("s1") }
    setTimeout(() => void shellKill.execute({ id }, again), 100)
    const killed = await shellOutput.execute({ id, until: "exit", waitMs: 60_000 }, again)
    expect(Date.now() - t0).toBeLessThan(6_000)
    expect(killed.output).toContain(`${id} killed`)
  })

  test("a cancelled read of an ended task does not count its exit as shown", async () => {
    const { tasks, nextExit } = registry()
    const abort = new AbortController()
    const context = { ...makeContext({ cwd: tempDir(), signal: abort.signal }), background: tasks.forSession("s1") }
    const exited = nextExit()
    const started = await shell.execute({ command: "echo done", background: true }, context)
    const id = String(started.meta?.taskId)
    await exited
    abort.abort()
    await shellOutput.execute({ id }, context)
    expect(tasks.exitShown("s1", id)).toBe(false)
  })

  test("binary output of a task waited to its exit is one line with the exit status", async () => {
    const { tasks } = registry()
    const context = { ...makeContext({ cwd: tempDir() }), background: tasks.forSession("s1") }
    const started = await shell.execute({ command: "head -c 5000 /dev/urandom; sleep 0.2", background: true }, context)
    const id = String(started.meta?.taskId)
    const result = await shellOutput.execute({ id, until: "exit", waitMs: 10_000 }, context)
    expect(result.output).toMatch(new RegExp(`^${id} exited 0 after \\d+s\n\\[binary output: [\\d,]+ characters; not shown\\. Use file, xxd \\| head, or strings to inspect it\\]$`))
    expect(result.output).not.toContain("�")
  })

  test("without a background port the tools explain themselves instead of blocking", async () => {
    const context = makeContext({ cwd: tempDir() })
    expect((await shell.execute({ command: "sleep 30", background: true }, context)).output).toContain("not available")
    expect((await shellOutput.execute({ id: "bg_1" }, context)).isError).toBe(true)
  })
})

describe("listAll", () => {
  test("lists every session's tasks, running first, and can be limited to one session", async () => {
    const { tasks, nextExit } = registry()
    const dir = tempDir()
    const done = nextExit()
    const quick = tasks.forSession("s1").start({ command: "exit 0", cwd: dir })
    const slow = tasks.forSession("s2").start({ command: "sleep 5", cwd: dir })
    const other = tasks.forSession("s1").start({ command: "sleep 5", cwd: dir })
    if (!quick.ok || !slow.ok || !other.ok) throw new Error("start failed")
    await done
    const all = tasks.listAll()
    expect(all.map((t) => t.id)).toEqual([slow.task.id, other.task.id, quick.task.id])
    expect(all.map((t) => t.status)).toEqual(["running", "running", "exited"])
    expect(all[0]).toMatchObject({ sessionId: "s2", command: "sleep 5" })
    expect(tasks.listAll("s1").map((t) => t.id)).toEqual([other.task.id, quick.task.id])
    expect(tasks.listAll("nobody")).toEqual([])
  })
})

describe("background task ends", () => {
  test("a command that exits while a descendant holds its pipes ends soon after the exit, and the descendant goes with it", async () => {
    const { tasks, exits, nextExit } = registry()
    const port = tasks.forSession("s1")
    const exited = nextExit()
    const started = port.start({ command: "sleep 30 & echo started", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const begun = performance.now()
    await exited
    expect(performance.now() - begun).toBeLessThan(5_000)
    expect(exits[0]?.task).toMatchObject({ status: "exited", exitCode: 0 })
    expect(exits[0]?.tail).toContain("started")
  })
})

describe("shell cancel", () => {
  test("a cancel that comes while the workdir is checked starts nothing", async () => {
    const root = tempDir()
    const controller = new AbortController()
    const context = { ...makeContext({ cwd: root }), signal: controller.signal }
    const pending = shell.execute({ command: `touch ${root}/ran` }, context)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    await Bun.sleep(100)
    expect(await Bun.file(`${root}/ran`).exists()).toBe(false)
  })
})
