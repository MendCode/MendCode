import { afterEach, describe, expect, test } from "bun:test"
import { createBackgroundTasks, runTool, shellMonitor, type BackgroundTasks } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tempDir = useTempDir()
const registries: BackgroundTasks[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop()
})

type Notice = { sessionId: string; id: string; lines: string[]; final: boolean }
function registry(limits: Parameters<typeof createBackgroundTasks>[0]["limits"] = {}) {
  const notices: Notice[] = []
  let notify: (() => void) | undefined
  const tasks = createBackgroundTasks({
    limits: { watchBatchMs: 40, ...limits },
    onWatch: (sessionId, task, lines, final) => (notices.push({ sessionId, id: task.id, lines, final }), notify?.()),
  })
  registries.push(tasks)
  const nextNotice = () => new Promise<void>((resolve) => (notify = resolve))
  return { tasks, notices, nextNotice }
}

describe("shell_monitor", () => {
  test("matching lines are pushed in a batch while the task runs, and other lines are not", async () => {
    const { tasks, notices, nextNotice } = registry()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "sleep 0.1; echo booting; echo READY on 3000; echo noise; echo Error: boom; sleep 5", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    const first = nextNotice()
    expect(port.watch(started.task.id, { match: ["ready", "error"] })).toMatchObject({ ok: true, watching: true })
    await first
    expect(notices).toEqual([{ sessionId: "s1", id: started.task.id, lines: ["READY on 3000", "Error: boom"], final: false }])
  })

  test("with no match every new line is pushed, stop ends the monitor, and an exit flushes what is waiting", async () => {
    const { tasks, notices, nextNotice } = registry({ watchBatchMs: 5_000 })
    const port = tasks.forSession("s1")
    const quick = port.start({ command: "sleep 0.1; echo one; echo two", cwd: tempDir() })
    if (!quick.ok) throw new Error(quick.error)
    port.watch(quick.task.id, { match: [] })
    const flushed = nextNotice()
    await flushed
    expect(notices.map((notice) => notice.lines)).toEqual([["one", "two"]])

    const stopped = port.start({ command: "sleep 0.1; echo ignored; sleep 0.2", cwd: tempDir() })
    if (!stopped.ok) throw new Error(stopped.error)
    port.watch(stopped.task.id, { match: [] })
    expect(port.watch(stopped.task.id, { match: [], stop: true })).toMatchObject({ ok: true, watching: false })
    await Bun.sleep(500)
    expect(notices).toHaveLength(1)
  })

  test("a task stopped by the agent sends no more monitor notices, and the monitor ends itself after its cap", async () => {
    const { tasks, notices, nextNotice } = registry({ watchBatchMs: 20, watchMaxNotices: 2 })
    const port = tasks.forSession("s1")
    const chatty = port.start({ command: "for i in 1 2 3 4 5 6; do echo line$i; sleep 0.15; done", cwd: tempDir() })
    if (!chatty.ok) throw new Error(chatty.error)
    port.watch(chatty.task.id, { match: [] })
    await nextNotice()
    await Bun.sleep(400)
    expect(notices).toHaveLength(2)
    expect(notices.at(-1)?.final).toBe(true)

    const killed = port.start({ command: "sleep 0.1; echo late; sleep 5", cwd: tempDir() })
    if (!killed.ok) throw new Error(killed.error)
    port.watch(killed.task.id, { match: [] })
    port.kill(killed.task.id)
    await Bun.sleep(300)
    expect(notices).toHaveLength(2)
  })

  test("only the owning session can watch a task, and a finished task cannot be watched", async () => {
    const { tasks } = registry()
    const started = tasks.forSession("s1").start({ command: "exit 0", cwd: tempDir() })
    if (!started.ok) throw new Error(started.error)
    expect(tasks.forSession("s2").watch(started.task.id, { match: [] })).toBeUndefined()
    await Bun.sleep(300)
    expect(tasks.forSession("s1").watch(started.task.id, { match: [] })).toMatchObject({ ok: false })
  })

  test("the tool reports what it set up and refuses an unknown task or a missing registry", async () => {
    const { tasks } = registry()
    const dir = tempDir()
    const port = tasks.forSession("s1")
    const started = port.start({ command: "sleep 5", cwd: dir })
    if (!started.ok) throw new Error(started.error)
    const context = { ...makeContext({ cwd: dir }), background: port }
    expect(await runTool(shellMonitor, { id: started.task.id, match: ["ready"] }, context)).toMatchObject({ isError: false, output: expect.stringContaining('for "ready"'), meta: { watching: true } })
    expect(await runTool(shellMonitor, { id: started.task.id, stop: true }, context)).toMatchObject({ isError: false, output: expect.stringContaining("stopped monitoring") })
    expect(await runTool(shellMonitor, { id: "bg_nope" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("unknown task") })
    expect(await runTool(shellMonitor, { id: "x" }, makeContext({ cwd: dir }))).toMatchObject({ isError: true })
    expect(shellMonitor.permission).toBe("read")
  })
})
