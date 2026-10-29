import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { AGENT_CAPPED_COMMANDS, AGENT_OPEN_COMMANDS, AGENT_SHELL_ENV, READ_ONLY_COMMANDS, agentCommandClass, type Command, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { agentProcesses, shell } from "@mendcode/tools"
import { startDaemon } from "../src"
import { createAgentGate, createPeerOrigin, type AgentOrigin } from "../src/agent-origin"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  agentProcesses.clear()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("what an agent-origin client may ask", () => {
  test("the classes: reads are open, session work is capped, everything else is the owner's", () => {
    expect(agentCommandClass("settings.get")).toBe("open")
    expect(agentCommandClass("session.events")).toBe("open")
    expect(agentCommandClass("user.submit")).toBe("capped")
    // The project backlog is the user's list: a session reads it and never writes it.
    expect(agentCommandClass("backlog.get")).toBe("open")
    // `pet.manage` carries `/pet import` (it reads a file the caller names and writes the pet store) and the paid generator: the user's.
    for (const type of ["pet.manage", "backlog.change", "settings.set", "permissions.set-default", "permissions.set-reviewer-role", "permissions.revoke", "permissions.retry", "models.default.set", "recipes.apply", "providers.set", "providers.auth.authorize", "mcp.add", "mcp.decide", "tools.trust", "extensions.disable", "packages.install", "plugins.install", "memory.add", "memory.policy", "loop.create", "loop.fire", "workflow.start", "workflow.permissions", "daemon.shutdown", "server.config.update", "server.upgrade", "secrets.reveal", "env.set", "privacy.set", "user.shell", "tui.change", "tui.control.send", "pty.create", "cache.set", "console.configure", "setup.preset", "budget.set", "session.share", "session.agent-command.update", "an.unknown.command"]) {
      expect(`${type}:${agentCommandClass(type)}`).toBe(`${type}:owner`)
    }
    // Nothing is in both lists, and what a read-only remote token may ask is never the owner's alone.
    expect(AGENT_OPEN_COMMANDS.filter((type) => (AGENT_CAPPED_COMMANDS as readonly string[]).includes(type))).toEqual([])
    expect(READ_ONLY_COMMANDS.filter((type) => agentCommandClass(type) === "owner")).toEqual([])
  })

  const modes = new Map<string, PermissionMode>([["ses_ask", "ask"], ["ses_full", "full"], ["ses_other_full", "full"], ["ses_other_ask", "ask"]])
  const gate = () => createAgentGate({ modeOf: (id) => modes.get(id) })
  const command = (body: Record<string, unknown>) => ({ id: "cmd_1", clientId: "cli_1", ...body }) as unknown as Command
  const ask: AgentOrigin = { via: "process", sessionId: "ses_ask" }
  const full: AgentOrigin = { via: "process", sessionId: "ses_full" }
  const unknown: AgentOrigin = { via: "declared" }

  test("owner commands are refused whatever the calling session's mode, with a message the model can act on", () => {
    const refusal = gate().check(full, command({ type: "permissions.set-default", mode: "full" }))!
    expect(refusal).toContain("[DAEMON]: refused: permissions.set-default")
    expect(refusal).toContain("only the user can")
    expect(refusal).toContain("Ask the user")
    expect(gate().check(full, command({ type: "settings.set", patch: { defaultPermission: "full" } }))).toContain("refused")
    expect(gate().check(full, command({ type: "settings.get" }))).toBeUndefined()
  })

  test("a session cannot drive, configure or raise a session above its own mode", () => {
    const g = gate()
    expect(g.check(ask, command({ type: "user.submit", sessionId: "ses_other_full", text: "go" }))).toContain("more authority")
    expect(g.check(ask, command({ type: "user.submit", sessionId: "ses_other_ask", text: "go" }))).toBeUndefined()
    expect(g.check(ask, command({ type: "user.submit", sessionId: "ses_ask", text: "go" }))).toBeUndefined()
    expect(g.check(full, command({ type: "user.submit", sessionId: "ses_other_full", text: "go" }))).toBeUndefined()
    expect(g.check(ask, command({ type: "session.permission.set", sessionId: "ses_ask", mode: "full" }))).toContain("above the calling session's own mode (ask)")
    expect(g.check(ask, command({ type: "session.permission.set", sessionId: "ses_other_ask", mode: "plan" }))).toBeUndefined()
    expect(g.check(full, command({ type: "session.permission.set", sessionId: "ses_other_ask", mode: "full" }))).toBeUndefined()
    // A caller whose session is not known counts as `ask`.
    expect(g.check(unknown, command({ type: "user.submit", sessionId: "ses_other_full", text: "go" }))).toContain("(ask)")
    expect(g.cap(unknown, "full")).toBe("ask")
    expect(g.cap(ask, "full")).toBe("ask")
    expect(g.cap(full, "full")).toBe("full")
    expect(g.cap(full, "plan")).toBe("plan")
  })

  test("a session never answers an approval, and removes only sessions it started", () => {
    const g = gate()
    expect(g.check(full, command({ type: "request.resolve", sessionId: "ses_full", requestId: "req_1", decision: { kind: "approve", scope: "once" } }))).toContain("cannot answer an approval")
    expect(g.check(full, command({ type: "request.resolve", sessionId: "ses_full", requestId: "req_1", decision: { kind: "answer", text: "yes" } }))).toContain("cannot answer")
    expect(g.check(full, command({ type: "request.resolve", sessionId: "ses_full", requestId: "req_1", decision: { kind: "deny" } }))).toBeUndefined()
    expect(g.check(full, command({ type: "session.delete", sessionId: "ses_other_ask" }))).toContain("did not start")
    expect(g.check(full, command({ type: "session.archive", sessionId: "ses_other_ask" }))).toContain("did not start")
    modes.set("ses_child", "full")
    g.started(full, "ses_child")
    expect(g.check(full, command({ type: "session.delete", sessionId: "ses_child" }))).toBeUndefined()
    expect(g.check(ask, command({ type: "session.delete", sessionId: "ses_child" }))).toContain("did not start")
  })
})

describe("who is on the other end", () => {
  const native = (tree: Record<number, number>, sessions: Record<number, number> = {}) => ({ peerPid: (fd: number) => fd, parentOf: (pid: number) => tree[pid], sessionOf: (pid: number) => sessions[pid] })

  test("a client under a process a session started is that session's; the daemon's own process and strangers are the user", () => {
    agentProcesses.agent(500, "ses_a")
    const origin = createPeerOrigin({ pid: 100, platform: "darwin", native: native({ 502: 501, 501: 500, 500: 100, 900: 1 }) })
    expect(origin.resolve(502)).toMatchObject({ via: "process", sessionId: "ses_a" })
    expect(origin.resolve(500)).toMatchObject({ via: "process", sessionId: "ses_a" })
    expect(origin.resolve(100)).toBeUndefined()
    expect(origin.resolve(900)).toBeUndefined()
    expect(origin.resolve(undefined)).toBeUndefined()
  })

  test("a terminal the user opened through the daemon is the user's, also inside a session's tree; other descendants are not, when asked", () => {
    agentProcesses.agent(500, "ses_a")
    agentProcesses.user(600)
    const tree = { 601: 600, 600: 100, 700: 100, 500: 100 }
    expect(createPeerOrigin({ pid: 100, platform: "darwin", descendants: true, native: native(tree) }).resolve(601)).toBeUndefined()
    expect(createPeerOrigin({ pid: 100, platform: "darwin", descendants: true, native: native(tree) }).resolve(700)).toMatchObject({ via: "descendant" })
    expect(createPeerOrigin({ pid: 100, platform: "darwin", native: native(tree) }).resolve(700)).toBeUndefined()
  })

  test("a client that left its parent is still found by the terminal session its starter led", () => {
    // 4_000_001 is no live process: the shell ended, what it left running keeps its session.
    const leader = 4_000_001
    agentProcesses.agent(leader, "ses_a").exited()
    const origin = createPeerOrigin({ pid: 100, platform: "darwin", native: native({ 800: 1 }, { 800: leader }) })
    expect(origin.resolve(800)).toMatchObject({ via: "terminal-session", sessionId: "ses_a" })
  })

  test("what the client declares can only add the restriction", () => {
    const origin = createPeerOrigin({ pid: 100, platform: "darwin", native: undefined })
    expect(origin.available()).toBe(false)
    expect(origin.declared([])).toBeUndefined()
    expect(origin.declared(["origin:agent"])).toEqual({ via: "declared" })
    expect(origin.declared(["limit:not-a-number"])).toBeUndefined()
  })

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")("the real socket peer is readable on this system", async () => {
    const dir = temp("mcev-p-peer-")
    const socketPath = path.join(dir, "s.sock")
    const origin = createPeerOrigin()
    expect(origin.available()).toBe(true)
    let seen: AgentOrigin | undefined | "none" = "none"
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore" })
    cleanups.push(() => child.kill())
    const server = Bun.listen({ unix: socketPath, socket: { open(socket) { seen = origin.resolve((socket as { fd?: number }).fd); socket.end() }, data() {} } })
    cleanups.push(() => server.stop(true))
    // A client that is a child of a tracked process: `nc`-free, a second bun started by a tracked shell.
    const script = `const s = await Bun.connect({ unix: ${JSON.stringify(socketPath)}, socket: { data() {}, close() { process.exit(0) } } }); await Bun.sleep(3000)`
    const shellChild = Bun.spawn(["/bin/sh", "-c", `${JSON.stringify(process.execPath)} -e '${script}'; true`], { stdout: "ignore", stderr: "ignore" })
    agentProcesses.agent(shellChild.pid, "ses_real")
    await shellChild.exited
    expect(seen).toMatchObject({ via: "process", sessionId: "ses_real" })
  })
})

describe.skipIf(process.platform === "win32")("end to end: a real daemon, a real shell tool call, the real CLI", () => {
  const main = path.resolve(import.meta.dir, "../../../apps/cli/src/main.ts")

  async function boot(defaultPermission: PermissionMode = "ask") {
    const dir = temp("mcev-p-origin-")
    const project = temp("mcev-p-origin-project-")
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: "owner" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    if (defaultPermission !== "ask") expect((await client.send({ type: "settings.set", patch: { defaultPermission } })).ok).toBe(true)
    const created = await client.send({ type: "session.create", directory: project })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result!.sessionId as SessionId
    // `evade` is a model's own wrapper: another name for the program, with the session's variables dropped.
    const evade = path.join(project, "evade")
    writeFileSync(evade, `#!/bin/sh\nexec env -u ${AGENT_SHELL_ENV} -u MENDCODE_SESSION_ID ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`)
    chmodSync(evade, 0o755)
    const honest = path.join(project, "honest")
    writeFileSync(honest, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`)
    chmodSync(honest, 0o755)
    const environment = { ...process.env, MENDCODE_V2_DIR: dir, MENDCODE_SESSION_ID: sessionId }
    const run = (command: string) => shell.execute({ command, timeoutMs: 60_000 }, { cwd: project, signal: new AbortController().signal, environment })
    const stored = async () => {
      const reply = await client.send({ type: "settings.get" })
      if (!reply.ok) throw new Error(reply.error.message)
      return (reply.result!.settings as { defaultPermission?: string }).defaultPermission ?? "ask"
    }
    return { dir, project, client, sessionId, run, stored, main }
  }

  test("a tool-launched shell cannot raise the default permission: refused by the tool, by the CLI and by the daemon; the setting is unchanged", async () => {
    const { run, stored, main, dir } = await boot()
    expect(await stored()).toBe("ask")

    // 1. The shell tool recognises the command and never starts it.
    const first = await run(`${JSON.stringify(process.execPath)} ${JSON.stringify(main)} control-plane permissions set-default full`)
    expect(first.output).toContain("refused:")
    expect(first.meta?.exitCode).toBeUndefined()

    // 2. Under a name the tool does not know, the CLI itself refuses before asking the daemon.
    const second = await run("./honest control-plane permissions set-default full")
    expect(second.isError).toBe(true)
    expect(second.output).toContain("refused:")
    expect(second.output).toContain("permissions set-default full")
    expect(second.output).toContain("their own terminal")

    // 3. With the session's variables dropped, the daemon still knows which process is asking.
    const third = await run("./evade control-plane permissions set-default full")
    expect(third.isError).toBe(true)
    expect(third.output).toContain("[DAEMON]: refused: permissions.set-default")

    // 4. Backgrounded and detached from the shell that started it: found by the terminal session it still belongs to.
    const fourth = await run(`(./evade control-plane permissions set-default full > ${JSON.stringify(path.join(dir, "bg.out"))} 2>&1 &) ; sleep 0.1; while pgrep -f "evade|permissions set-default" > /dev/null 2>&1 && [ ! -s ${JSON.stringify(path.join(dir, "bg.out"))} ]; do sleep 0.2; done; sleep 0.5; cat ${JSON.stringify(path.join(dir, "bg.out"))}`)
    expect(fourth.output).toContain("refused")

    expect(await stored()).toBe("ask")

    // Reading stays allowed from the same shell.
    const read = await run("./honest control-plane permissions status --json")
    expect(read.isError).toBe(false)
    expect(read.output).toContain("default")
  }, 120_000)

  test("the user's own terminal is unchanged: the same command sets the default", async () => {
    const { stored, main, dir, project } = await boot()
    const env = { ...process.env, MENDCODE_V2_DIR: dir }
    delete (env as Record<string, string | undefined>)[AGENT_SHELL_ENV]
    const child = Bun.spawn([process.execPath, main, "control-plane", "permissions", "set-default", "full"], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(`${code}:${err}`).toBe("0:")
    expect(out.length).toBeGreaterThan(0)
    expect(await stored()).toBe("full")
  }, 60_000)

  test("a session starts another session with no more authority than its own, and cannot approve for it", async () => {
    const { run, client, sessionId, project } = await boot("full")
    // The calling session is in `ask`; the default for new sessions is `full`.
    expect((await client.send({ type: "session.permission.set", sessionId, mode: "ask" })).ok).toBe(true)
    const made = await run("./evade session create --title child --json")
    expect(made.isError).toBe(false)
    const child = (JSON.parse(made.output.trim().split("\n").at(-1)!) as { data: { sessionId: SessionId } }).data.sessionId
    /** The mode a session is in: its last `session.permission` event, `ask` when there is none. */
    const modeOf = async (id: SessionId) => {
      const reply = await client.send({ type: "session.events", sessionId: id, after: 0 })
      if (!reply.ok) throw new Error(reply.error.message)
      return (reply.result!.events as Array<{ type: string; mode?: string }>).filter((event) => event.type === "session.permission").at(-1)?.mode ?? "ask"
    }
    expect(await modeOf(child)).toBe("ask")

    // Approvals off is refused by every layer.
    expect((await run(`./honest session send ${child} hello --approve`)).output).toContain("approvals off")
    expect((await run(`./honest run --dangerously-skip-permissions hello`)).output).toContain("approvals off")
    // A session the user started in `full` is out of reach of the `ask` session.
    const own = await client.send({ type: "session.create", directory: project })
    if (!own.ok) throw new Error(own.error.message)
    const privileged = own.result!.sessionId as SessionId
    expect(await modeOf(privileged)).toBe("full")
    const sent = await run(`./evade session send ${privileged} hello --async`)
    expect(sent.isError).toBe(true)
    expect(sent.output).toContain("more authority")
  }, 120_000)
})
