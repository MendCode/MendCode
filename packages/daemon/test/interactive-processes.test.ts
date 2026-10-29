import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { budgetMs } from "../../../scripts/test-budget"
import { defaultShell, runTool, sandboxBackend, sandboxPolicy, shellSession, type InteractivePort } from "@mendcode/tools"
import { createInteractiveProcesses, createTerminalCleaner, type InteractiveProcesses } from "../src/interactive-processes"

/** A tiny line-oriented program on a real pseudo-terminal: no network, nothing outside the temp directory. */
const SCRIPT = `
import { createInterface } from "node:readline"
console.log("ready")
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  if (line === "quit") process.exit(3)
  else if (line === "size") console.log("size=" + process.stdout.columns + "x" + process.stdout.rows)
  else if (line === "flood") console.log("x".repeat(5000))
  else if (line === "color") console.log("\\u001b[31mred\\u001b[0m")
  else console.log("echo:" + line)
})
setInterval(() => {}, 1000)
`

const dirs: string[] = []
const registries: InteractiveProcesses[] = []
const never = new AbortController().signal
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(options: Parameters<typeof createInteractiveProcesses>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-interactive-"))
  dirs.push(dir)
  writeFileSync(join(dir, "repl.ts"), SCRIPT)
  const registry = createInteractiveProcesses(options)
  registries.push(registry)
  const port = (sessionId = "s1") => registry.forSession(sessionId)
  const start = (sessionId = "s1", extra: Partial<Parameters<InteractivePort["start"]>[0]> = {}) => {
    const started = port(sessionId).start({ command: `${process.execPath} repl.ts`, cwd: dir, ...extra })
    if (!started.ok) throw new Error(started.error)
    return started.session
  }
  return { dir, registry, port, start }
}

const read = (port: InteractivePort, id: string, waitMs = 3_000, maxChars = 10_000) => port.read(id, { waitMs, maxChars, signal: never })
async function until(check: () => boolean | Promise<boolean>, ms = 5_000, describe?: () => string | Promise<string>) {
  const end = Date.now() + budgetMs(ms)
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`condition not reached${describe ? `: ${await describe()}` : ""}`)
}

/** The processes running one of this file's fixture scripts: pid ppid pgid session tty state command. */
function fixtureProcesses(script = "repl.ts") {
  const session = process.platform === "darwin" ? "sess=" : "sid="
  const table = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", session, "-o", "tty=", "-o", "stat=", "-o", "args="], { stdout: "pipe", stderr: "ignore" }).stdout.toString()
  return table.split("\n").filter((line) => line.includes(script))
}
/** What the system says about the fixtures, for a failure message. */
const processes = (script = "repl.ts") => `processes running ${script} (pid ppid pgid session tty stat command):\n${fixtureProcesses(script).join("\n") || "none"}`
/** What the program has written to its terminal so far, for a failure message. */
const terminalText = async (port: InteractivePort, id: string) => JSON.stringify((await read(port, id, 0))?.output ?? "")

describe("interactive processes", () => {
  test("a process on a TTY is driven with write and read, and read only returns what is new", async () => {
    const { port, start } = setup()
    const session = start()
    const first = await read(port(), session.id)
    expect(first?.output).toContain("ready")
    expect(first?.session.status).toBe("running")
    expect(port().write(session.id, "hello\n")).toMatchObject({ ok: true })
    const reply = await read(port(), session.id)
    expect(reply?.output).toContain("echo:hello")
    expect(reply?.output).not.toContain("ready")
    expect((await read(port(), session.id, 0))?.output).toBe("")
  })

  test("a read waits for the reply to a write instead of returning old output", async () => {
    const { port, start } = setup()
    const session = start()
    await read(port(), session.id)
    port().write(session.id, "one\n")
    // Nothing from the first read is left, so this has to wait for the program's answer.
    expect((await read(port(), session.id, 3_000))?.output).toContain("echo:one")
  })

  test("output is capped per read and the rest arrives in order on the next read", async () => {
    const { port, start } = setup()
    const session = start()
    await read(port(), session.id)
    port().write(session.id, "flood\n")
    const first = await read(port(), session.id, 3_000, 1_000)
    expect(first!.output.length).toBe(1_000)
    expect(first!.remaining).toBeGreaterThan(0)
    const all = [first!.output]
    let remaining = first!.remaining
    let guard = 0
    while (remaining > 0 && guard++ < 50) {
      const page = await read(port(), session.id, 200, 1_000)
      expect(page!.output.length).toBeLessThanOrEqual(1_000)
      all.push(page!.output)
      remaining = page!.remaining
    }
    expect(all.join("").split("x").length - 1).toBe(5_000)
  })

  test("escape codes are removed from what the model reads", async () => {
    const { port, start } = setup()
    const session = start()
    await read(port(), session.id)
    port().write(session.id, "color\n")
    const output = (await read(port(), session.id))?.output ?? ""
    expect(output).toContain("red")
    expect(output).not.toContain("\u001b")
  })

  test("resize reaches the program's terminal", async () => {
    const { port, start } = setup()
    const session = start("s1", { cols: 90, rows: 20, command: "stty size; read go; stty size; sleep 5" })
    expect((await read(port(), session.id))?.output).toContain("20 90")
    expect(port().resize(session.id, 120, 40)).toMatchObject({ ok: true, session: { cols: 120, rows: 40 } })
    port().write(session.id, "go\n")
    expect((await read(port(), session.id))?.output).toContain("40 120")
    expect(port().resize(session.id, 0, 10)).toMatchObject({ ok: false })
  })

  test("the exit code is kept, what is left stays readable, and a write to a finished session is refused", async () => {
    const { port, start } = setup()
    const session = start()
    await read(port(), session.id)
    port().write(session.id, "quit\n")
    await until(async () => (await read(port(), session.id, 0))?.session.status === "exited")
    const done = await read(port(), session.id, 0)
    expect(done?.session).toMatchObject({ status: "exited", exitCode: 3 })
    expect(port().write(session.id, "more\n")).toMatchObject({ ok: false, error: expect.stringContaining("not running") })
    expect(port().list().map((entry) => entry.id)).toContain(session.id)
  })

  // The waits are shorter than the test's own timeout, so a failure reports what it saw instead of being cut off by the runner.
  test("ctrl-c and kill stop the process; kill is attributed to the agent", async () => {
    const { port, start } = setup()
    const interrupted = start("s1", { command: `exec ${process.execPath} repl.ts` })
    await read(port(), interrupted.id)
    expect(port().signal(interrupted.id, "INT")).toMatchObject({ ok: true })
    await until(async () => (await read(port(), interrupted.id, 0))?.session.status !== "running", 5_000, () => `SIGINT sent, session still running (shell ${defaultShell()}, ${process.platform}); ${processes()}`)

    const killed = start("s1", { command: `exec ${process.execPath} repl.ts` })
    await read(port(), killed.id)
    expect(port().kill(killed.id)?.id).toBe(killed.id)
    await until(async () => (await read(port(), killed.id, 0))?.session.status === "killed", 5_000, () => `kill sent, session still running; ${processes()}`)
    expect((await read(port(), killed.id, 0))?.session.killedBy).toBe("agent")
    expect(port().kill("pty_missing")).toBeUndefined()
  }, budgetMs(30_000))

  test("when the shell stays as the parent of the program (dash, a compound command), ctrl-c and kill reach the program too and leave nothing running", async () => {
    const { dir, port, start } = setup()
    writeFileSync(join(dir, "nested-repl.ts"), SCRIPT)
    const command = `${process.execPath} nested-repl.ts; echo shell-finished`
    for (const stop of ["ctrl-c", "kill"] as const) {
      const session = start("s1", { command })
      await read(port(), session.id)
      await until(() => fixtureProcesses("nested-repl.ts").length >= 1, 5_000, () => `the program did not start; ${processes("nested-repl.ts")}`)
      if (stop === "ctrl-c") expect(port().signal(session.id, "INT")).toMatchObject({ ok: true })
      else expect(port().kill(session.id)?.id).toBe(session.id)
      await until(async () => (await read(port(), session.id, 0))?.session.status !== "running", 5_000, async () => `${stop} sent, session still running (shell ${defaultShell()}); ${processes("nested-repl.ts")}; terminal text ${await terminalText(port(), session.id)}`)
      await until(() => fixtureProcesses("nested-repl.ts").length === 0, 5_000, () => `${stop}: the program is still running after its session ended; ${processes("nested-repl.ts")}`)
    }
  }, budgetMs(40_000))

  test("a session only sees and controls its own processes", async () => {
    const { port, start } = setup()
    const mine = start("s1")
    await read(port("s1"), mine.id)
    expect(await read(port("s2"), mine.id, 0)).toBeUndefined()
    expect(port("s2").write(mine.id, "x\n")).toMatchObject({ ok: false })
    expect(port("s2").resize(mine.id, 80, 24)).toMatchObject({ ok: false })
    expect(port("s2").signal(mine.id, "INT")).toMatchObject({ ok: false })
    expect(port("s2").kill(mine.id)).toBeUndefined()
    expect(port("s2").list()).toEqual([])
    expect(port("s1").list()).toHaveLength(1)
    expect((await read(port("s1"), mine.id, 0))?.session.status).toBe("running")
  })

  test("ending a chat session and stopping the daemon kill its processes", async () => {
    const { port, registry, start } = setup()
    const a = start("s1")
    const b = start("s2")
    await read(port("s1"), a.id)
    expect(registry.running("s1")).toBe(1)
    registry.killSession("s1")
    await until(async () => (await read(port("s1"), a.id, 0))?.session.status === "killed")
    expect((await read(port("s1"), a.id, 0))?.session.killedBy).toBe("cleanup")
    expect((await read(port("s2"), b.id, 0))?.session.status).toBe("running")
    registry.stop()
    await until(async () => (await read(port("s2"), b.id, 0))?.session.status === "killed")
  })

  test("a session nobody touched for the idle timeout is stopped, and one in use is not", async () => {
    let clock = 1_000
    const { port, registry, start } = setup({ now: () => clock, limits: { idleMs: 10_000, maxLifetimeMs: 100_000 } })
    const idle = start()
    const busy = start()
    await read(port(), idle.id)
    clock += 6_000
    await read(port(), busy.id, 0)
    clock += 6_000
    registry.sweep()
    await until(async () => (await read(port(), idle.id, 0))?.session.status === "killed")
    expect((await read(port(), idle.id, 0))?.session.killedBy).toBe("idle")
    expect((await read(port(), busy.id, 0))?.session.status).toBe("running")
    clock += 95_000
    registry.sweep()
    await until(async () => (await read(port(), busy.id, 0))?.session.status === "killed")
    expect((await read(port(), busy.id, 0))?.session.killedBy).toBe("lifetime")
  })

  test("sessions per chat and in total are limited", () => {
    const { port, start } = setup({ limits: { maxPerSession: 1, maxRunning: 2 } })
    start("s1")
    expect(port("s1").start({ command: "sleep 5", cwd: tmpdir() })).toMatchObject({ ok: false, error: expect.stringContaining("too many") })
    start("s2")
    expect(port("s3").start({ command: "sleep 5", cwd: tmpdir() })).toMatchObject({ ok: false, error: expect.stringContaining("too many") })
  })

  test("a command that cannot start reports it instead of throwing", () => {
    const { port } = setup({ driver: { shells: () => [], spawn: () => { throw new Error("PTY runtime unavailable") } } })
    expect(port().start({ command: "echo hi", cwd: tmpdir() })).toMatchObject({ ok: false, error: expect.stringContaining("unavailable") })
  })
})

describe("terminal cleaning", () => {
  test("escape sequences, carriage returns and control characters are removed; a sequence cut by a chunk is held back", () => {
    const cleaner = createTerminalCleaner()
    expect(cleaner.push("\u001b[1;32mok\u001b[0m\r\nnext\u0007\r")).toBe("ok\nnext\n")
    expect(cleaner.push("a\u001b[3")).toBe("a")
    expect(cleaner.push("1mb\u001b]0;title\u0007c")).toBe("bc")
    expect(createTerminalCleaner().push("plain\ttext")).toBe("plain\ttext")
  })
})

describe("shell_session tool over the registry", () => {
  test("start returns the first output, write returns the reply, and kill ends it", async () => {
    const { dir, registry } = setup()
    const context = { cwd: dir, signal: never, interactive: registry.forSession("s1") }
    const started = await runTool(shellSession, { action: "start", command: `${process.execPath} repl.ts` }, context)
    expect(started).toMatchObject({ isError: false, output: expect.stringContaining("ready") })
    const id = String(started.meta?.sessionId)
    const reply = await runTool(shellSession, { action: "write", id, input: "ping\n" }, context)
    expect(reply.output).toContain("echo:ping")
    expect((await runTool(shellSession, { action: "list" }, context)).output).toContain(id)
    expect((await runTool(shellSession, { action: "kill", id }, context)).output).toContain("stopping")
  })

  test("it refuses a bare shell, an unknown id and a missing registry", async () => {
    const { dir, registry } = setup()
    const context = { cwd: dir, signal: never, interactive: registry.forSession("s1") }
    expect(await runTool(shellSession, { action: "start", command: "bash" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("bare interactive shell") })
    expect(await runTool(shellSession, { action: "start", command: "sudo -E zsh -l" }, context)).toMatchObject({ isError: true })
    expect(await runTool(shellSession, { action: "start", command: "bash -c 'echo hi'" }, context)).toMatchObject({ isError: false })
    expect(await runTool(shellSession, { action: "read", id: "pty_nope" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("unknown session") })
    expect(await runTool(shellSession, { action: "write", id: "pty_nope", input: "x" }, context)).toMatchObject({ isError: true })
    expect(await runTool(shellSession, { action: "write" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("needs an id") })
    expect(await runTool(shellSession, { action: "start", command: "echo hi" }, { cwd: dir, signal: never })).toMatchObject({ isError: true, output: expect.stringContaining("not available") })
    expect(await runTool(shellSession, { action: "start", command: "echo hi", workdir: "missing" }, context)).toMatchObject({ isError: true })
  })

  test("the tool's permission is execute only for a start", () => {
    expect(shellSession.permission).toBe("execute")
    expect(shellSession.permissionFor?.({ action: "start" })).toBe("execute")
    for (const action of ["write", "read", "resize", "signal", "kill", "list"] as const) expect(shellSession.permissionFor?.({ action })).toBe("read")
  })
})

describe("interactive processes under the OS sandbox", () => {
  test("a policy with no usable backend is refused, never run unconfined", () => {
    const { port, dir } = setup()
    const policy = sandboxPolicy({ config: { mode: "workspace-write" }, cwd: dir })!
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      expect(port().start({ command: "echo ran > ran.txt", cwd: dir, sandbox: policy })).toMatchObject({ ok: false, error: expect.stringContaining("/sandbox off") })
    } finally {
      Object.defineProperty(process, "platform", { value: original })
    }
    expect(existsSync(join(dir, "ran.txt"))).toBe(false)
  })

  const enforced = sandboxBackend()?.name === "seatbelt" ? test : test.skip
  enforced("a PTY command writes inside the project and not outside it", async () => {
    const { port, dir } = setup()
    const outside = mkdtempSync(join(tmpdir(), "mendcode-interactive-out-"))
    dirs.push(outside)
    const sandbox = sandboxPolicy({ config: { mode: "workspace-write" }, cwd: dir, temp: [] })!
    const started = port().start({ command: `echo a > ${dir}/in.txt; echo b > ${outside}/out.txt; echo finished`, cwd: dir, sandbox })
    if (!started.ok) throw new Error(started.error)
    await until(async () => (await read(port(), started.session.id, 200))?.session.status !== "running")
    expect(existsSync(join(dir, "in.txt"))).toBe(true)
    expect(existsSync(join(outside, "out.txt"))).toBe(false)
  })
})
