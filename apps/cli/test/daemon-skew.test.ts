import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type CommandInput } from "@mendcode/client"
import { computeBuildId } from "@mendcode/build-id"
import { daemonInUse, ensureDaemon, stopIfStale, terminateDaemon, waitForSocketGone } from "../src/launcher"
import type { DaemonSkew } from "../src/ui/app/context"
import { appHarness, cleanTemps } from "./session-ui-harness"

afterAll(cleanTemps)

type Status = Record<string, unknown>
const IDLE: Status = { activeTurns: 0, backgroundJobs: 0, loops: { total: 0, active: 0, running: 0 }, clients: 1 }

/** A connected peer that reports `status` and answers a shutdown the way the daemon does. */
function fakeDaemon({ buildId, status = IDLE, shutdown = { ok: true } as { ok: boolean; error?: { code: string } } }: { buildId: string | undefined; status?: Status; shutdown?: { ok: boolean; error?: { code: string } } }) {
  const sent: string[] = []
  return {
    sent,
    daemonBuildId: buildId,
    async send(command: { type: "daemon.status" } | { type: "daemon.shutdown"; force?: boolean }) {
      sent.push(command.type)
      return command.type === "daemon.status" ? { ok: true, result: status } : shutdown
    },
  }
}

describe("a daemon older than this client", () => {
  test("the same build is left alone without asking anything", async () => {
    const daemon = fakeDaemon({ buildId: "dev-same" })
    expect(await stopIfStale(daemon, "dev-same")).toBe("fresh")
    expect(daemon.sent).toEqual([])
  })

  test("an idle older daemon is stopped", async () => {
    const daemon = fakeDaemon({ buildId: "dev-old" })
    expect(await stopIfStale(daemon, "dev-new")).toBe("stopped")
    expect(daemon.sent).toEqual(["daemon.status", "daemon.shutdown"])
  })

  test("a daemon that predates the client count is judged by its work alone", async () => {
    const { clients: _, ...withoutClients } = IDLE
    expect(await stopIfStale(fakeDaemon({ buildId: "dev-old", status: withoutClients }), "dev-new")).toBe("stopped")
  })

  test("active turns, background jobs, running loops or another client keep it running and are never interrupted", async () => {
    const busy: Status[] = [
      { ...IDLE, activeTurns: 1 },
      { ...IDLE, backgroundJobs: 2 },
      { ...IDLE, loops: { total: 1, active: 1, running: 1 } },
      { ...IDLE, clients: 2 },
    ]
    for (const status of busy) {
      const daemon = fakeDaemon({ buildId: "dev-old", status })
      expect(await stopIfStale(daemon, "dev-new")).toBe("busy")
      expect(daemon.sent).toEqual(["daemon.status"])
    }
  })

  test("a shutdown the daemon refuses as busy is reported busy, not retried with force", async () => {
    const daemon = fakeDaemon({ buildId: "dev-old", shutdown: { ok: false, error: { code: "busy" } } })
    expect(await stopIfStale(daemon, "dev-new")).toBe("busy")
    expect(daemon.sent).toEqual(["daemon.status", "daemon.shutdown"])
  })

  test("a daemon that predates build ids cannot be judged", async () => {
    for (const buildId of [undefined, "unknown"]) {
      const daemon = fakeDaemon({ buildId })
      expect(await stopIfStale(daemon, "dev-new")).toBe("legacy")
      expect(daemon.sent).toEqual([])
    }
  })

  test("daemonInUse reads only counts the status carries", () => {
    expect(daemonInUse(undefined)).toBe(false)
    expect(daemonInUse({})).toBe(false)
    expect(daemonInUse({ clients: 1 })).toBe(false)
    expect(daemonInUse({ clients: 3 })).toBe(true)
  })
})

describe("development build ids", () => {
  test("hash the daemon sources, not the empty set, and follow the release scope's wider input", () => {
    const daemon = computeBuildId({})
    expect(daemon).toMatch(/^dev-[a-f0-9]{12}$/)
    expect(daemon).not.toBe("dev-e3b0c44298fc")
    expect(computeBuildId({}, "release")).not.toBe(daemon)
    expect(computeBuildId({})).toBe(daemon)
  })

  test("MENDCODE_BUILD_ID overrides the hash", () => {
    expect(computeBuildId({ MENDCODE_BUILD_ID: "release-7" })).toBe("release-7")
  })
})

describe("a real older daemon", () => {
  async function olderDaemon(dir: string) {
    const previous = process.env.MENDCODE_BUILD_ID
    process.env.MENDCODE_BUILD_ID = "dev-older"
    try { return await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 }) } finally {
      if (previous === undefined) delete process.env.MENDCODE_BUILD_ID
      else process.env.MENDCODE_BUILD_ID = previous
    }
  }
  const connect = async (dir: string, name: string) => {
    const client = createClient({ socketPath: path.join(dir, "mendd.sock"), name, reconnect: false })
    await client.connect()
    return client
  }

  test("an idle one is restarted into the client's build; another attached client keeps it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-skew-"))
    const expected = computeBuildId({})
    try {
      const first = await olderDaemon(dir)
      expect(first.started).toBe(true)
      const mine = await connect(dir, "skew-a")
      expect(mine.daemonBuildId).toBe("dev-older")
      const status = await mine.send({ type: "daemon.status" })
      expect(status.ok ? status.result?.clients : undefined).toBe(1)

      const other = await connect(dir, "skew-b")
      expect(await stopIfStale(mine, expected)).toBe("busy")
      expect((await mine.send({ type: "daemon.status" })).ok).toBe(true)
      other.close()
      await Bun.sleep(100)

      expect(await stopIfStale(mine, expected)).toBe("stopped")
      mine.close()
      await waitForSocketGone(first.socketPath)
      const next = await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 })
      expect(next.started).toBe(true)
      const renewed = await connect(dir, "skew-c")
      expect(renewed.daemonBuildId).toBe(expected)
      expect(await stopIfStale(renewed, expected)).toBe("fresh")
      renewed.close()
    } finally {
      await terminateDaemon(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("the CLI replaces an idle older daemon on launch and leaves one with another client attached", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-launch-skew-"))
    const cli = async () => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), "--dir", dir, "session", "list"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MENDCODE_V2_ENGINE: "faux" } })
      await child.exited
      return child.exitCode
    }
    const pidOf = async () => {
      const client = await connect(dir, "pid")
      const status = await client.send({ type: "daemon.status" })
      client.close()
      return status.ok ? { pid: status.result?.pid, build: status.result?.buildId } : undefined
    }
    try {
      await olderDaemon(dir)
      const before = await pidOf()
      expect(before?.build).toBe("dev-older")
      const watcher = await connect(dir, "watcher")
      expect(await cli()).toBe(0)
      expect(await pidOf()).toEqual(before)
      watcher.close()
      await Bun.sleep(100)
      expect(await cli()).toBe(0)
      const after = await pidOf()
      expect(after?.pid).not.toBe(before?.pid)
      expect(after?.build).toBe(computeBuildId({}))
    } finally {
      await terminateDaemon(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("a command it cannot parse comes back as one friendly line; the schema detail goes to the debug hook", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-reject-"))
    try {
      await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 })
      const rejected: Array<{ command: string; detail: string }> = []
      const client = createClient({ socketPath: path.join(dir, "mendd.sock"), name: "reject", reconnect: false, onRejected: (rejection) => rejected.push(rejection) })
      await client.connect()
      // What an older daemon says to a widget type its schema does not know: the user's real failure.
      const reply = await client.send({ type: "sidebar.update", directory: dir, change: { action: "set", widgets: [{ type: "not-a-widget" }] } } as unknown as CommandInput)
      expect(reply.ok).toBe(false)
      const message = reply.ok ? "" : reply.error.message
      expect(message).toBe("daemon rejected sidebar.update · it may be an older build · /daemon restart")
      expect(message).not.toMatch(/Invalid|zod|PROTOCOL|body\./)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.command).toBe("sidebar.update")
      expect(rejected[0]!.detail).toContain("[PROTOCOL]")
      expect(rejected[0]!.detail).toContain("widgets")
      // A client of the daemon's own build is told which value is wrong, not that the daemon is old.
      const same = createClient({ socketPath: path.join(dir, "mendd.sock"), name: "same", reconnect: false, buildId: client.daemonBuildId! })
      await same.connect()
      const typo = await same.send({ type: "session.get", sessionId: "ses_01M5ZE5MTCXWJFJ6RJ1Y2VDPB5t" } as unknown as CommandInput)
      expect(typo.ok ? "" : typo.error.message).toBe("daemon rejected session.get · invalid sessionId")
      same.close()
      // A valid answer, including a daemon's own refusal, is passed through untouched.
      expect((await client.send({ type: "daemon.status" })).ok).toBe(true)
      expect(rejected).toHaveLength(1)
      client.close()
    } finally {
      await terminateDaemon(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("the terminal while it runs", () => {
  const flush = () => Bun.sleep(10)
  function app(check: () => Promise<DaemonSkew>, extra: { older?: boolean; restart?: () => Promise<{ ok: true } | { ok: false; message: string }> } = {}) {
    let restarts = 0
    const h = appHarness({ daemon: { ...(extra.older ? { older: true } : {}), check, restart: async () => { restarts++; return extra.restart ? extra.restart() : { ok: true } } } })
    return { h, restarts: () => restarts }
  }
  const reconnect = async (h: ReturnType<typeof appHarness>) => {
    h.app.onConnection("reconnecting")
    h.app.onConnection("connected")
    await flush()
    h.app.render()
  }
  const screen = (h: ReturnType<typeof appHarness>) => h.text().join("\n")

  test("an older daemon in use says nothing at startup: it works, and it is replaced when idle", () => {
    const { h } = app(async () => "busy", { older: true })
    h.app.render()
    expect(screen(h)).not.toContain("older")
  })

  test("/daemon tells that the daemon is older than this terminal", async () => {
    const { h } = app(async () => "busy", { older: true })
    await h.type("/daemon\r")
    expect(screen(h)).toContain("(older than this terminal)")
  })

  test("a current daemon shows no line", () => {
    const { h } = app(async () => "fresh")
    h.app.render()
    expect(screen(h)).not.toContain("older build")
  })

  test("a reconnect that finds the daemon busy and older shows no line; a legacy one, which cannot be replaced, does", async () => {
    let skew: DaemonSkew = "busy"
    const { h } = app(async () => skew)
    await reconnect(h)
    expect(screen(h)).not.toContain("older build")
    skew = "legacy"
    await reconnect(h)
    expect(screen(h)).toContain("daemon is an older build · restart it with --restart-daemon")
    skew = "fresh"
    await reconnect(h)
    expect(screen(h)).not.toContain("older build")
  })

  test("an idle older daemon restarted on reconnect is not announced: nothing for the user to do", async () => {
    let skew: DaemonSkew = "restarting"
    const { h } = app(async () => skew)
    await reconnect(h)
    expect(screen(h)).not.toContain("daemon restarted")
    skew = "fresh"
    await reconnect(h)
    expect(screen(h)).not.toContain("daemon restarted")
    expect(screen(h)).not.toContain("older build")
  })

  test("/daemon restart asks the daemon to restart, and says so after it is back", async () => {
    let skew: DaemonSkew = "busy"
    const { h, restarts } = app(async () => skew, { older: true })
    await h.type("/daemon restart\r")
    expect(restarts()).toBe(1)
    skew = "fresh"
    await reconnect(h)
    expect(screen(h)).toContain("daemon restarted")
    expect(screen(h)).not.toContain("older build")
  })

  test("/daemon restart from a terminal that is itself the older build ends with what to do, not a restart that never finishes", async () => {
    const { h, restarts } = app(async () => "busy", { older: true })
    await h.type("/daemon restart\r")
    expect(restarts()).toBe(1)
    await reconnect(h)
    expect(screen(h)).toContain("daemon restarted · this terminal is an older build, reopen it to update")
    expect(screen(h)).not.toContain("restarting daemon…")
  })

  test("/daemon restart on a busy daemon changes nothing and says why", async () => {
    const { h, restarts } = app(async () => "busy", { older: true, restart: async () => ({ ok: false, message: "daemon is busy · try /daemon restart when idle" }) })
    await h.type("/daemon restart\r")
    expect(restarts()).toBe(1)
    expect(screen(h)).toContain("daemon is busy · try /daemon restart when idle")
    await reconnect(h)
    expect(screen(h)).not.toContain("daemon restarted")
  })

  test("/daemon restart on a busy daemon is not refused: it waits for the running work, and the terminal says so until then", async () => {
    const { h, restarts } = app(async () => "busy", { older: true, restart: async () => ({ ok: true, pending: true }) })
    await h.type("/daemon restart\r")
    expect(restarts()).toBe(1)
    expect(screen(h)).toContain("the daemon restarts when its running work ends")
    expect(screen(h)).toContain("daemon restarts on the new build when its running work ends")
  })

  test("/daemon with a bad word prints its usage and restarts nothing", async () => {
    const { h, restarts } = app(async () => "fresh")
    await h.type("/daemon reboot\r")
    expect(restarts()).toBe(0)
    expect(screen(h)).toContain("usage: /daemon [status | restart]")
  })

  test("/daemon status reports the build and the work", async () => {
    const h = appHarness({
      daemon: { check: async () => "fresh", restart: async () => ({ ok: true }) },
      reply: (command: CommandInput) => command.type === "daemon.status" ? { ok: true, result: { buildId: "dev-abc", activeTurns: 1, backgroundJobs: 0, clients: 2 } } : undefined,
    })
    await h.type("/daemon\r")
    expect(screen(h)).toContain("daemon dev-abc · 1 turns · 0 jobs · 2 clients")
  })

  test("a remote attach has no daemon to restart", async () => {
    const h = appHarness({ remote: { host: "test.invalid", readOnly: false } })
    await h.type("/daemon restart\r")
    expect(screen(h)).toContain("daemon restart is for a local daemon")
    expect(h.sentOf("daemon.shutdown")).toHaveLength(0)
  })
})
