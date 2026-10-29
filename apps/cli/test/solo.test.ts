import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { openStore } from "@mendcode/store"
import { ensureDaemon, liveDaemon, stopIfStale, terminateDaemon } from "../src/launcher"
import { parseGlobalOptions } from "../src/global-options"
import { resolveProcessMode, startsSolo } from "../src/process-modes"
import { claimHost, handOffWanted, HOST_CLAIM_FILE, leaveSolo, soloWork, type LeaveInput } from "../src/solo"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"

const fixture = path.join(import.meta.dir, "solo-fixture.ts")
const temps: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []
const clients: Array<ReturnType<typeof createClient>> = []

function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-solo-")))
  temps.push(dir)
  mkdirSync(path.join(dir, "home"), { recursive: true })
  return dir
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const dir of temps.splice(0)) {
    await terminateDaemon(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A terminal without a screen (solo-fixture.ts) in its own process: the daemon module can be hosted only once per process. */
function terminal(dir: string, mode: "solo" | "daemon" = "solo") {
  const child = Bun.spawn([process.execPath, fixture, "--dir", dir, "--process", mode], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: path.join(dir, "home"), MENDCODE_BUILD_ID: "solo-test" },
  })
  children.push(child)
  const seen: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  void (async () => {
    let pending = ""
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      pending += new TextDecoder().decode(chunk)
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim().startsWith("{")) seen.push(JSON.parse(line))
        for (const wake of waiters.splice(0)) wake()
      }
    }
    for (const wake of waiters.splice(0)) wake()
  })()
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text()
  async function next(op: string, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const at = seen.findIndex((entry) => entry.op === op)
      if (at >= 0) return seen.splice(at, 1)[0]!
      if (Date.now() > deadline) throw new Error(`terminal never said ${op}: ${JSON.stringify(seen)} ${await Promise.race([stderr, Bun.sleep(100).then(() => "")])}`)
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 100) })
    }
  }
  return {
    child,
    ready: () => next("ready") as Promise<{ pid: number; hosted: boolean; started: boolean }>,
    next,
    send(request: Record<string, unknown>) { (child.stdin as import("bun").FileSink).write(`${JSON.stringify(request)}\n`); (child.stdin as import("bun").FileSink).flush() },
  }
}

async function attach(dir: string, name = "second-terminal") {
  const client = createClient({ socketPath: path.join(dir, "mendd.sock"), name, reconnect: false })
  clients.push(client)
  await client.connect()
  return client
}

const lockOwner = (dir: string) => Number(readFileSync(path.join(dir, "mendd.lock"), "utf8"))
const status = async (client: ReturnType<typeof createClient>) => {
  const reply = await client.send({ type: "daemon.status" })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result as Record<string, unknown> & { clients: number; activeTurns: number; pid: number; keepAlive: { running: string[]; standing: string[] } }
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await Bun.sleep(25)
  }
}

describe("the process setting", () => {
  test("--process, MENDCODE_PROCESS and the saved profile choose in that order, and auto is the default", () => {
    expect(resolveProcessMode({})).toBe("auto")
    expect(resolveProcessMode({ profile: "auto" })).toBe("auto")
    expect(resolveProcessMode({ env: "solo", profile: "daemon" })).toBe("solo")
    expect(resolveProcessMode({ flag: "auto", env: "solo", profile: "daemon" })).toBe("auto")
    expect(resolveProcessMode({ flag: "nonsense", env: "daemon" })).toBe("daemon")
    expect(resolveProcessMode({ flag: "", env: "", profile: "nonsense" })).toBe("auto")
  })

  test("only an interactive local terminal on its own socket and quiet logs hosts a daemon", () => {
    const base = { mode: "auto" as const, interactive: true, remote: false, explicitSocket: false, printLogs: false }
    expect(startsSolo(base)).toBe(true)
    expect(startsSolo({ ...base, mode: "solo" })).toBe(true)
    expect(startsSolo({ ...base, mode: "daemon" })).toBe(false)
    expect(startsSolo({ ...base, interactive: false })).toBe(false)
    expect(startsSolo({ ...base, remote: true })).toBe(false)
    expect(startsSolo({ ...base, explicitSocket: true })).toBe(false)
    expect(startsSolo({ ...base, printLogs: true })).toBe(false)
  })

  test("the command-line flag takes auto|solo|daemon in both spellings and refuses anything else", () => {
    expect(parseGlobalOptions(["--process", "solo", "--dir", "x"])).toMatchObject({ processMode: "solo", args: ["--dir", "x"] })
    expect(parseGlobalOptions(["--process=daemon"]).processMode).toBe("daemon")
    expect(parseGlobalOptions(["--dir", "x"]).processMode).toBeUndefined()
    expect(() => parseGlobalOptions(["--process", "both"])).toThrow("--process needs auto|solo|daemon")
    expect(() => parseGlobalOptions(["--process"])).toThrow("--process needs auto|solo|daemon")
  })

  test("the saved profile keeps a valid value and falls back to auto for anything else", () => {
    expect(DEFAULT_TUI_PROFILE.processMode).toBe("auto")
    for (const mode of ["auto", "solo", "daemon"]) expect(normalizeTuiProfile({ processMode: mode }).processMode).toBe(mode)
    for (const bad of ["Solo", "", 1, null, ["solo"]]) expect(normalizeTuiProfile({ processMode: bad }).processMode).toBe("auto")
  })
})

describe("the host claim", () => {
  test("exactly one of several claimants wins, the others see its pid, and releasing lets the next one in", () => {
    const dir = temp()
    const first = claimHost(dir, process.pid)
    expect(first.claimed).toBe(true)
    const others = [claimHost(dir, process.pid + 1), claimHost(dir, process.pid + 2)]
    for (const other of others) expect(other).toEqual({ claimed: false, owner: process.pid })
    if (first.claimed) first.release()
    expect(existsSync(path.join(dir, HOST_CLAIM_FILE))).toBe(false)
    expect(claimHost(dir, process.pid + 1).claimed).toBe(true)
  })

  test("a claim whose owner is gone is replaced, and a release never removes someone else's claim", () => {
    const dir = temp()
    writeFileSync(path.join(dir, HOST_CLAIM_FILE), "2147483000")
    const mine = claimHost(dir, process.pid)
    expect(mine.claimed).toBe(true)
    writeFileSync(path.join(dir, HOST_CLAIM_FILE), String(process.pid + 7))
    if (mine.claimed) mine.release()
    expect(readFileSync(path.join(dir, HOST_CLAIM_FILE), "utf8")).toBe(String(process.pid + 7))
  })
})

describe("what a closing terminal has to keep", () => {
  test("a daemon's own account of running and standing work, and the clients besides this terminal", () => {
    expect(soloWork(undefined)).toEqual({ running: [], standing: [], others: 0 })
    expect(soloWork({ clients: 1, keepAlive: { running: [], standing: [] } })).toEqual({ running: [], standing: [], others: 0 })
    expect(soloWork({ clients: 3, keepAlive: { running: ["turns"], standing: ["loops", "dream"] } })).toEqual({ running: ["turns"], standing: ["loops", "dream"], others: 2 })
  })

  test("auto moves the daemon out only with another client attached and nothing running that would stop with the move", () => {
    expect(handOffWanted(undefined)).toBe(false)
    expect(handOffWanted({ clients: 1, keepAlive: { running: [], standing: [] } })).toBe(false)
    expect(handOffWanted({ clients: 2, keepAlive: { running: [], standing: ["loops"] } })).toBe(true)
    expect(handOffWanted({ clients: 2, keepAlive: { running: ["turns"], standing: [] } })).toBe(false)
    // A dev server the model left running is a child of this process: moving would stop it.
    expect(handOffWanted({ clients: 3, keepAlive: { running: ["background processes"], standing: [] } })).toBe(false)
  })

  test("a daemon that predates the account is judged by its counts", () => {
    expect(soloWork({ clients: 1, activeTurns: 1, backgroundJobs: 0, loops: { active: 0, running: 0 } })).toEqual({ running: ["turns"], standing: [], others: 0 })
    expect(soloWork({ clients: 2, activeTurns: 0, backgroundJobs: 2, loops: { active: 1, running: 0 } })).toEqual({ running: ["jobs"], standing: ["loops"], others: 1 })
  })
})

describe("leaving", () => {
  function leaving(overrides: Partial<LeaveInput> & { statuses: Array<Record<string, unknown> | undefined> }) {
    const events: string[] = []
    const { statuses, ...rest } = overrides
    const queue = [...statuses]
    const input: LeaveInput = {
      host: { stopped: false, stop: async () => void events.push("stop") },
      status: async () => (queue.length > 1 ? queue.shift() : queue[0]),
      closeClient: () => void events.push("close client"),
      handOff: async () => void events.push("hand off"),
      interrupted: new Promise(() => {}),
      notify: (message) => void events.push(`notify: ${message}`),
      sleep: async () => {},
      ...rest,
    }
    return { input, events }
  }
  const idle = { clients: 1, keepAlive: { running: [], standing: [] } }

  test("nothing to keep: the daemon stops with the terminal and nothing replaces it", async () => {
    const { input, events } = leaving({ statuses: [idle] })
    expect(await leaveSolo(input)).toBe("exited")
    expect(events).toEqual(["close client", "stop"])
  })

  test("standing work or another attached client: the daemon is handed to a separate process, after it released the directory", async () => {
    for (const status of [{ clients: 1, keepAlive: { running: [], standing: ["loops"] } }, { clients: 2, keepAlive: { running: [], standing: [] } }]) {
      const { input, events } = leaving({ statuses: [status] })
      expect(await leaveSolo(input)).toBe("handed-off")
      expect(events[0]).toBe("close client")
      expect(events[1]).toBe("stop")
      expect(events[2]).toStartWith("notify: daemon keeps running in the background for: ")
      expect(events[3]).toBe("hand off")
    }
  })

  test("a running turn finishes in this process first, and only then is the rest decided", async () => {
    const running = { clients: 1, keepAlive: { running: ["turns"], standing: [] } }
    const { input, events } = leaving({ statuses: [running, running, idle] })
    expect(await leaveSolo(input)).toBe("exited")
    expect(events[0]).toBe("notify: still running: turns · this process stays until it finishes (ctrl+c stops it)")
    expect(events.slice(1)).toEqual(["close client", "stop"])
  })

  test("a dev server or a shell tab the model left running does not hold the exit: it stops with the terminal", async () => {
    const programs = { clients: 1, keepAlive: { running: ["background processes", "terminals"], standing: [] } }
    const { input, events } = leaving({ statuses: [programs] })
    expect(await leaveSolo(input)).toBe("exited")
    expect(events).toEqual(["close client", "stop", "notify: stopped background processes and terminals"])
  })

  test("ctrl+c while waiting stops the daemon (the turn ends as interrupted) and hands nothing over", async () => {
    const running = { clients: 2, keepAlive: { running: ["turns"], standing: ["loops"] } }
    let interrupt!: () => void
    const { input, events } = leaving({ statuses: [running], interrupted: new Promise<void>((resolve) => { interrupt = resolve }), sleep: () => Bun.sleep(5) })
    const outcome = leaveSolo(input)
    await Bun.sleep(30)
    interrupt()
    expect(await outcome).toBe("interrupted")
    expect(events.filter((event) => !event.startsWith("notify"))).toEqual(["close client", "stop"])
  })

  test("a daemon too busy to answer is not idle: the turn it then reports is waited for before it stops", async () => {
    const turns = { clients: 2, keepAlive: { running: ["turns"], standing: [] } }
    const { input, events } = leaving({ statuses: [undefined, turns, turns, { ...turns, keepAlive: { running: [], standing: [] } }] })
    expect(await leaveSolo(input)).toBe("handed-off")
    expect(events[0]).toBe("notify: still running: work the daemon has not reported yet · this process stays until it finishes (ctrl+c stops it)")
    expect(events.slice(1)).toEqual(["close client", "stop", "notify: daemon keeps running in the background for: 1 other client", "hand off"])
  })

  test("a daemon that never answers holds the exit only until the unanswered deadline", async () => {
    const { input, events } = leaving({ statuses: [idle], status: () => new Promise(() => {}), statusTimeoutMs: 5, unansweredMs: 30, sleep: (ms) => Bun.sleep(Math.min(ms, 5)) })
    const started = Date.now()
    expect(await leaveSolo(input)).toBe("exited")
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(events.slice(-2)).toEqual(["close client", "stop"])
  })

  test("a daemon that already stopped (a restart request) is not asked anything", async () => {
    const asked: string[] = []
    const { input, events } = leaving({ statuses: [idle], host: { stopped: true, stop: async () => void asked.push("stop") }, status: async () => (asked.push("status"), idle) })
    expect(await leaveSolo(input)).toBe("exited")
    expect(asked).toEqual([])
    expect(events).toEqual(["close client"])
  })
})

describe("a terminal that hosts its daemon", () => {
  test("hosts it when none runs, serves a second terminal on the normal socket and lock, and hands over when it leaves", async () => {
    const dir = temp()
    const host = terminal(dir)
    const ready = await host.ready()
    expect(ready).toMatchObject({ hosted: true, started: true })
    expect(lockOwner(dir)).toBe(ready.pid)
    expect(existsSync(path.join(dir, "mendd.sock"))).toBe(true)

    const second = await attach(dir)
    expect(second.daemonBuildId).toBe("solo-test")
    const seen = await status(second)
    expect(seen).toMatchObject({ pid: ready.pid, clients: 2 })

    host.send({ op: "leave" })
    const left = await host.next("leave")
    expect(left.outcome).toBe("handed-off")
    expect(await host.child.exited).toBe(0)
    // The directory now belongs to a separate, detached daemon: other terminals attach to it as they always did.
    await until(async () => (await liveDaemon(dir)) !== undefined, "a daemon after the hand-off")
    const next = lockOwner(dir)
    expect(next).not.toBe(ready.pid)
    const again = await attach(dir, "after-handoff")
    expect((await status(again)).pid).toBe(next)
  }, 60_000)

  test("closing with nothing to keep ends the process and leaves no daemon, lock or socket behind", async () => {
    const dir = temp()
    const host = terminal(dir)
    await host.ready()
    host.send({ op: "leave" })
    expect((await host.next("leave")).outcome).toBe("exited")
    expect(await host.child.exited).toBe(0)
    expect(existsSync(path.join(dir, "mendd.lock"))).toBe(false)
    expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
    expect(await liveDaemon(dir)).toBeUndefined()
  }, 60_000)

  test("closing during a turn lets the turn finish headless, a later terminal can attach meanwhile, then the process ends", async () => {
    const dir = temp()
    const host = terminal(dir)
    const { pid } = await host.ready()
    host.send({ op: "submit", text: "/tool 2500" })
    const submitted = await host.next("submit")
    expect(submitted.ok).toBe(true)
    host.send({ op: "leave" })
    const notice = await host.next("notice")
    expect(String(notice.message)).toContain("still running: turns")

    const later = await attach(dir, "later-terminal")
    const during = await status(later)
    expect(during).toMatchObject({ pid, activeTurns: 1 })
    expect(during.keepAlive.running).toEqual(["turns"])
    later.close()

    expect((await host.next("leave", 40_000)).outcome).toBe("exited")
    expect(await host.child.exited).toBe(0)
    const store = openStore({ dir })
    try {
      const events = store.readBefore(submitted.sessionId as never, undefined, 100)
      expect(events.map((event) => event.type)).toContain("turn.completed")
      expect(events.map((event) => event.type)).not.toContain("turn.interrupted")
    } finally { store.close() }
  }, 90_000)

  test("two terminals starting at once: exactly one hosts the daemon and the other attaches to it", async () => {
    const dir = temp()
    const a = terminal(dir)
    const b = terminal(dir)
    const [first, second] = await Promise.all([a.ready(), b.ready()])
    expect([first.hosted, second.hosted].sort()).toEqual([false, true])
    const host = first.hosted ? first : second
    expect(lockOwner(dir)).toBe(host.pid)
    const guest = first.hosted ? b : a
    const hostTerminal = first.hosted ? a : b
    guest.send({ op: "status" })
    expect(((await guest.next("status")).result as { pid: number; clients: number })).toMatchObject({ pid: host.pid, clients: 2 })

    guest.send({ op: "leave" })
    expect((await guest.next("leave")).outcome).toBe("daemon")
    await guest.child.exited
    await until(async () => {
      const count = await attach(dir, "count")
      const connected = (await status(count)).clients
      count.close()
      return connected === 2
    }, "the guest's connection to go")
    await Bun.sleep(100)
    hostTerminal.send({ op: "leave" })
    expect((await hostTerminal.next("leave")).outcome).toBe("exited")
    expect(await hostTerminal.child.exited).toBe(0)
  }, 90_000)

  test("a terminal on a running daemon attaches and does not host a second one", async () => {
    const dir = temp()
    await ensureDaemon({ dir, engine: "faux", cwd: dir, timeoutMs: 20_000 })
    const pid = lockOwner(dir)
    const terminalOnDaemon = terminal(dir)
    expect(await terminalOnDaemon.ready()).toMatchObject({ hosted: false, started: false })
    terminalOnDaemon.send({ op: "status" })
    expect(((await terminalOnDaemon.next("status")).result as { pid: number }).pid).toBe(pid)
    terminalOnDaemon.send({ op: "leave" })
    expect((await terminalOnDaemon.next("leave")).outcome).toBe("daemon")
    expect(lockOwner(dir)).toBe(pid)
  }, 60_000)

  test("a second terminal of another build does not restart the host: the host's own terminal counts as a client", async () => {
    const dir = temp()
    const host = terminal(dir)
    await host.ready()
    const second = await attach(dir)
    expect(await stopIfStale(second, "release-9")).toBe("busy")
    expect((await status(second)).clients).toBe(2)
    expect(await stopIfStale(second, "solo-test")).toBe("fresh")
  }, 60_000)

  test("a restart request stops the hosted daemon without ending the terminal's process", async () => {
    const dir = temp()
    const host = terminal(dir)
    const { pid } = await host.ready()
    const control = await attach(dir, "control")
    expect((await control.send({ type: "daemon.shutdown", force: true })).ok).toBe(true)
    await until(async () => (await liveDaemon(dir)) === undefined, "the socket to go")
    // The daemon closes its listener first and the store, which owns the writer lock, last (after the trace and hook flushes), so the
    // lock outlives the socket by those flushes: how long they take depends on the machine.
    await until(async () => !existsSync(path.join(dir, "mendd.lock")), "the writer lock to be released")
    expect(host.child.exitCode).toBeNull()
    expect(host.child.pid).toBe(pid)
    host.send({ op: "leave" })
    expect((await host.next("leave")).outcome).toBe("exited")
    expect(await host.child.exited).toBe(0)
  }, 60_000)
})

describe("an abrupt end (kill -9)", () => {
  test("solo: everything appended before the kill is there, the half-finished turn is closed as interrupted, and the next daemon works", async () => {
    const dir = temp()
    const host = terminal(dir)
    await host.ready()
    host.send({ op: "submit", text: "/tool 60000" })
    const submitted = await host.next("submit")
    const sessionId = submitted.sessionId as string
    const watcher = await attach(dir, "watcher")
    await until(async () => (await status(watcher)).activeTurns === 1, "the turn to start")
    watcher.close()
    host.child.kill("SIGKILL")
    await host.child.exited

    // The lock and the socket of the dead process are stale; the next start replaces them.
    const next = await ensureDaemon({ dir, engine: "faux", cwd: dir, timeoutMs: 20_000 })
    expect(next.started).toBe(true)
    const client = await attach(dir, "after-kill")
    const window = await client.loadWindow(sessionId as never)
    expect(window.ok).toBe(true)
    if (!window.ok) return
    const types = window.window.events.map((event) => event.type)
    expect(types).toContain("turn.started")
    expect(types).toContain("turn.interrupted")
    const prompt = window.window.events.find((event) => event.type === "item.completed" && "text" in event && event.text === "/tool 60000")
    expect(prompt).toBeDefined()
    expect((await status(client)).activeTurns).toBe(0)
    // And the session is usable.
    expect((await client.send({ type: "user.submit", sessionId: sessionId as never, text: "after the kill", attachments: [] })).ok).toBe(true)
    await until(async () => {
      const after = await client.loadWindow(sessionId as never)
      return after.ok && after.window.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "echo: after the kill")
    }, "the answer after the kill")
  }, 90_000)

  test("two processes: killing the terminal leaves the daemon and its turn running, which solo cannot do (its turn ends interrupted, its state intact)", async () => {
    const dir = temp()
    const host = terminal(dir, "daemon")
    expect(await host.ready()).toMatchObject({ hosted: false })
    host.send({ op: "submit", text: "/tool 1500" })
    const submitted = await host.next("submit")
    host.child.kill("SIGKILL")
    await host.child.exited
    const client = await attach(dir, "survivor")
    await until(async () => {
      const window = await client.loadWindow(submitted.sessionId as never)
      return window.ok && window.window.events.some((event) => event.type === "turn.completed")
    }, "the turn to finish without its terminal")
  }, 60_000)
})
