import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type CommandInput, type CommandReply } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

const ids = createIdFactory()
const id = ids("session")
const parsed = (...argv: string[]): Automation => {
  const result = parseAutomation(argv)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { cleanTemps(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fake(send: (command: CommandInput) => CommandReply = () => ({ ok: true }), history: SessionEvent[] = []) {
  const commands: CommandInput[] = []
  const out: string[] = []
  const err: string[] = []
  const timers: Array<{ ms: number; callback(): void; cancelled: boolean }> = []
  let listener: ((event: SessionEvent) => void) | undefined
  let interrupt: () => void = () => {}
  const deps: AutomationDeps = {
    client: { send: async (command) => { commands.push(command); return send(command) }, subscribe: async () => { history.forEach((event) => listener?.(event)); return { ok: true, result: { lastSeq: history.at(-1)?.seq ?? 0 } } } },
    listen: (handler) => { listener = handler }, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) },
    cwd: "/project", now: () => 1_800_000_000_000, onInterrupt: (callback) => { interrupt = callback },
    setTimer: (ms, callback) => { const timer = { ms, callback, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true } } },
  }
  let seq = history.at(-1)?.seq ?? 0
  return { deps, out, err, commands, timers, push: (event: Record<string, unknown>) => listener?.({ sessionId: id, seq: ++seq, at: seq, ...event } as SessionEvent), interrupt: () => interrupt() }
}

describe("B15 session parsing", () => {
  test("directory namespaces, child and global scopes, filters and max-count alias", () => {
    expect(parsed("--dir", "/data", "session", "list", "--dir", "../repo", "--all", "--all-projects", "--project", "/repo", "-n", "8", "--state", "running", "--active", "--since", "42", "--search", "fix")).toMatchObject({ dir: "/data", projectDir: "../repo", all: true, allProjects: true, project: "/repo", limit: 8, state: "running", active: true, since: 42, search: "fix" })
    expect(parsed("session", "create", "--data-dir=/data", "--dir=/repo", "--parent", id, "--agent", "plan", "--model", "openai/gpt-6-luna", "--variant", "high")).toMatchObject({ dir: "/data", projectDir: "/repo", parent: id, agent: "plan", model: "openai/gpt-6-luna", variant: "high" })
    expect(parsed("--dir", "/data", "session", "send", id, "--", "--dir", "/literal")).toMatchObject({ dir: "/data", text: "--dir /literal" })
    expect(parsed("--dir", "/data", "session", "send", id, "--", "--dir", "/literal")).not.toHaveProperty("projectDir")
  })

  test("aliases and millisecond flags are parsed without changing units", () => {
    for (const name of ["get", "status", "delete", "export"]) expect(parsed("session", name, id).kind).toBe(`session.${name}`)
    expect(parsed("session", "inspect", id, "--limit", "0")).toMatchObject({ limit: 0 })
    expect(parsed("session", "rename", id, "Fix", "the", "client")).toMatchObject({ title: "Fix the client" })
    expect(parsed("session", "fork", id, "--message-id", "itm")).toMatchObject({ messageId: "itm" })
    expect(parsed("session", "send", id, "work")).toMatchObject({ wait: true })
    expect(parsed("session", "send", id, "work", "--async")).toMatchObject({ wait: false })
    expect(parsed("session", "send", id, "work", "--async", "--wait", "--timeout-ms", "1500", "--interval-ms", "25")).toMatchObject({ wait: true, timeoutMs: 1500, intervalMs: 25 })
    expect(parsed("session", "events", id, "--follow", "--keep-open", "--limit", "3")).toMatchObject({ keepOpen: true, limit: 3 })
  })

  test("invalid values fail before connection", () => {
    expect(parseAutomation(["--dir", "/data", "session", "list", "--unknown"])).toMatchObject({ ok: false, topic: "session" })
    expect(parseAutomation(["--dir", "/data", "session", "send", id, "--file", "--async"])).toMatchObject({ ok: false, topic: "session" })
    for (const args of [["wait", id, "--timeout-ms", "0"], ["wait", id, "--interval-ms", "-1"], ["list", "--since", "NaN"], ["list", "--max-count", "501"], ["rename", id, " "], ["get"], ["inspect", id, "--limit", "51"], ["list", "--project", "--json"]]) expect(parseAutomation(["session", ...args]).ok).toBe(false)
    for (const args of [["archive"], ["archive", id, "extra"], ["list", "--restore"], ["get", id, "--archived"]]) expect(parseAutomation(["session", ...args]).ok).toBe(false)
  })
})

test("create carries parent, agent and catalog-normalized model; list keeps project scope", async () => {
  const catalog = { defaults: { model: "gpt-6-luna" }, roles: {}, models: [{ id: "gpt-6-luna", efforts: [] }] }
  const h = fake((command) => command.type === "models.list" ? { ok: true, result: catalog } : { ok: true, result: { sessionId: id, sessions: [] } })
  expect(await runAutomation(parsed("session", "create", "--dir", "/repo", "--parent", id, "--agent", "plan", "--model", "openai/gpt-6-luna", "--variant", "high"), h.deps)).toBe(0)
  expect(h.commands.at(-1)).toEqual({ type: "session.create", directory: "/repo", title: "", parentId: id, agent: "plan", choice: { model: "gpt-6-luna", variant: "high" } })
  await runAutomation(parsed("session", "list", "--all", "--project", "../other", "--search", "fix", "--state", "completed", "--since", "1", "--active"), h.deps)
  expect(h.commands.at(-1)).toMatchObject({ type: "session.list", roots: false, directory: "/project", project: "/other", search: "fix", state: "completed", since: 1, active: true })
  await runAutomation(parsed("session", "list", "--model", "openai/gpt-6"), h.deps)
  expect(h.commands.at(-1)).toMatchObject({ type: "session.list", model: "gpt-6" })
  await runAutomation(parsed("session", "list", "--model", "removed/custom"), h.deps)
  expect(h.commands.at(-1)).toMatchObject({ type: "session.list", model: "removed:custom" })
})

test("attachments and a custom command are submitted with per-turn selection", async () => {
  const attachment = { sha256: "a".repeat(64), bytes: 4, mime: "image/png" }
  const h = fake((command) => {
    if (command.type === "models.list") return { ok: true, result: { defaults: { model: "gpt-6-luna" }, roles: {}, models: [{ id: "gpt-6-luna" }] } }
    if (command.type === "attachment.paste") return { ok: true, result: command.path.endsWith(".png") ? { kind: "image", attachment } : { kind: "text", name: "notes.txt", content: "real notes" } }
    if (command.type === "session.get") return { ok: true, result: { session: { directory: "/saved-project" } } }
    if (command.type === "commands.expand") return { ok: true, result: { prompt: "expanded task" } }
    return { ok: true, result: { queueId: ids("queue") } }
  })
  expect(await runAutomation(parsed("session", "send", id, "task", "--async", "--model", "openai/gpt-6-luna", "--variant", "high", "--agent", "plan", "--file", "a.png", "--file", "notes.txt", "--command", "review"), h.deps)).toBe(0)
  expect(h.commands.at(-1)).toMatchObject({ type: "commands.execute", name: "review", args: "task", contextText: "\n\n[notes.txt]\nreal notes", attachments: [attachment], selection: { agent: "plan", model: { model: "gpt-6-luna", variant: "high" } } })
  expect(h.commands.some((command) => command.type === "commands.expand")).toBe(false)
})

test("session send --mode and --request-id choose the delivery and make a retry idempotent", async () => {
  expect(parseAutomation(["session", "send", id, "later", "--mode", "now"])).toMatchObject({ ok: false, topic: "session" })
  expect(parseAutomation(["session", "send", id, "later", "--mode", "steer", "--wait"])).toMatchObject({ ok: false, topic: "session" })
  expect(parseAutomation(["session", "send", id, "later", "--mode", "queue", "--command", "review"])).toMatchObject({ ok: false, topic: "session" })
  expect(parsed("session", "send", id, "later", "--mode", "queue")).toMatchObject({ mode: "queue", wait: true })
  expect(parsed("session", "send", id, "later", "--mode", "steer", "--request-id", "r-1")).toMatchObject({ mode: "steer", requestId: "r-1", wait: false })
  const h = fake(() => ({ ok: true, result: { queueId: ids("queue"), steered: true } }))
  expect(await runAutomation(parsed("session", "send", id, "use the other file", "--mode", "auto", "--request-id", "r-1"), h.deps)).toBe(0)
  expect(h.commands.at(-1)).toMatchObject({ type: "user.submit", text: "use the other file", delivery: "steer", clientRequestId: "r-1" })
  expect(h.out.join("")).toContain("steered")
  const restart = fake(() => ({ ok: true, result: { queueId: ids("queue") } }))
  expect(await runAutomation(parsed("session", "send", id, "stop and do this", "--mode", "restart", "--async"), restart.deps)).toBe(0)
  expect(restart.commands.at(-1)).toMatchObject({ delivery: "restart" })
})

test("default send waits for its own turn and clears the listener", async () => {
  const queueId = ids("queue")
  const turnId = ids("turn")
  const h = fake(() => ({ ok: true, result: { queueId } }))
  let settled = false
  const running = runAutomation(parsed("session", "send", id, "task", "--json"), h.deps).then((code) => { settled = true; return code })
  await Bun.sleep(1)
  expect(settled).toBe(false)
  h.push({ type: "turn.started", turnId, queueId })
  h.push({ type: "turn.completed", turnId })
  expect(await running).toBe(0)
  const count = h.out.length
  h.push({ type: "turn.completed", turnId: ids("turn") })
  expect(h.out.length).toBe(count)
})

test("send reconciles missed events once and cancels the interval; handled extension commands finish immediately", async () => {
  const queueId = ids("queue")
  const turnId = ids("turn")
  const events = [{ sessionId: id, seq: 1, at: 1, type: "turn.started", turnId, queueId }, { sessionId: id, seq: 2, at: 2, type: "turn.completed", turnId }] as SessionEvent[]
  const h = fake((command) => ({ ok: true, result: command.type === "session.events" ? { events } : { queueId } }))
  const running = runAutomation(parsed("session", "send", id, "task", "--interval-ms", "10"), h.deps)
  await Bun.sleep(1)
  h.timers[0]!.callback()
  expect(await running).toBe(0)
  expect(h.commands.filter((command) => command.type === "session.events")).toHaveLength(1)
  expect(h.timers.at(-1)!.cancelled).toBe(true)
  for (const flags of [[], ["--async"]]) {
    const handled = fake(() => ({ ok: true, result: { handled: true, notice: "Saved" } }))
    expect(await runAutomation(parsed("session", "send", id, "/save", ...flags), handled.deps)).toBe(0)
    expect(handled.out.join("")).toBe("Saved\n")
  }
})

test("remote paths are refused before attachment access; cancelled waits report cancellation", async () => {
  const remote = fake()
  expect(await runAutomation(parsed("session", "send", id, "--file", "notes.txt"), { ...remote.deps, allowFiles: false })).toBe(1)
  expect(remote.commands).toHaveLength(0)
  expect(remote.err.join("")).toContain("disabled while remote")
  const cancelled = fake(undefined, [{ sessionId: id, seq: 1, at: 1, type: "turn.cancelled", turnId: ids("turn") }, { sessionId: id, seq: 2, at: 2, type: "foreground.state", state: "idle" }])
  expect(await runAutomation(parsed("session", "wait", id), cancelled.deps)).toBe(2)
  expect(cancelled.err.join("")).toBe("error: session cancelled\n")
})

test("a wait on a turn the daemon interrupted says interrupted, from pushes and from the reconciling snapshot", async () => {
  const pushed = fake(undefined, [{ sessionId: id, seq: 1, at: 1, type: "turn.interrupted", turnId: ids("turn"), reason: "restart" }, { sessionId: id, seq: 2, at: 2, type: "foreground.state", state: "idle" }])
  expect(await runAutomation(parsed("session", "wait", id), pushed.deps)).toBe(2)
  expect(pushed.err.join("")).toBe("error: session interrupted\n")
  const json = fake(undefined, [{ sessionId: id, seq: 1, at: 1, type: "turn.interrupted", turnId: ids("turn"), reason: "restart" }, { sessionId: id, seq: 2, at: 2, type: "foreground.state", state: "idle" }])
  expect(await runAutomation(parsed("session", "wait", id, "--json"), json.deps)).toBe(2)
  expect(JSON.parse(json.out.at(-1)!).data).toMatchObject({ status: "interrupted" })
  const polled = fake(() => ({ ok: true, result: { state: "interrupted", session: { state: "idle", queued: 0 } } }))
  const running = runAutomation(parsed("session", "wait", id, "--interval-ms", "10", "--json"), polled.deps)
  await Bun.sleep(1)
  polled.timers[0]!.callback()
  expect(await running).toBe(2)
  expect(JSON.parse(polled.out.at(-1)!).data).toMatchObject({ status: "interrupted" })
})

test("send --wait exits 5 when its approval is denied for lack of --approve; --json says so, --approve keeps 0", async () => {
  const turn = async (...flags: string[]) => {
    const queueId = ids("queue"), turnId = ids("turn")
    const h = fake(() => ({ ok: true, result: { queueId } }))
    const running = runAutomation(parsed("session", "send", id, "task", ...flags), h.deps)
    await Bun.sleep(1)
    h.push({ type: "turn.started", turnId, queueId })
    h.push({ type: "server.request", turnId, requestId: ids("request"), kind: "approval", title: "Run", detail: "rm x" })
    h.push({ type: "turn.completed", turnId })
    return { code: await running, h }
  }
  const denied = await turn("--json")
  expect(denied.code).toBe(5)
  expect(JSON.parse(denied.h.out.at(-1)!).data).toMatchObject({ exitCode: 5, status: "denied", approvalDenied: true })
  expect(denied.h.commands).toContainEqual(expect.objectContaining({ type: "request.resolve", decision: expect.objectContaining({ kind: "deny" }) }))
  const human = await turn()
  expect(human.code).toBe(5)
  expect(human.h.err.join("")).toContain("pass --approve to allow it")
  const approved = await turn("--approve", "--json")
  expect(approved.code).toBe(0)
  expect(JSON.parse(approved.h.out.at(-1)!).data).toEqual({ sessionId: id, exitCode: 0, status: "completed" })
})

test("wait requires a terminal result, refreshes at the requested interval and cleans timers", async () => {
  const h = fake(() => ({ ok: true, result: { state: "completed", session: { state: "idle", queued: 0 } } }))
  let settled = false
  const running = runAutomation(parsed("session", "wait", id, "--timeout-ms", "900", "--interval-ms", "10", "--json"), h.deps).then((code) => { settled = true; return code })
  await Bun.sleep(1)
  expect(settled).toBe(false)
  expect(h.timers.map((timer) => timer.ms)).toEqual([10, 900])
  h.timers[0]!.callback()
  expect(await running).toBe(0)
  expect(JSON.parse(h.out[0]!).data.status).toBe("completed")
  expect(h.timers.slice(1).every((timer) => timer.cancelled)).toBe(true)
})

test("events keep-open survives idle, limit terminates and default follow exits at idle", async () => {
  const open = fake()
  let finished = false
  const running = runAutomation(parsed("session", "events", id, "--follow", "--keep-open", "--limit", "2"), open.deps).then((code) => { finished = true; return code })
  await Bun.sleep(1)
  open.push({ type: "foreground.state", state: "idle" })
  expect(finished).toBe(false)
  open.push({ type: "foreground.state", state: "generating" })
  expect(await running).toBe(0)
  const closed = fake()
  const following = runAutomation(parsed("session", "events", id, "--follow"), closed.deps)
  await Bun.sleep(1)
  closed.push({ type: "foreground.state", state: "idle" })
  expect(await following).toBe(0)
})

test("the app consumes enriched session summaries without showing child sessions by default", async () => {
  const h = appHarness({ dataDir: tempDir(), directory: "/project", reply: (command) => command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: id, title: "Review client", directory: "/project", createdAt: 1, updatedAt: 2, lastSeq: 3, state: "idle", queued: 0, status: "completed", permission: "ask" }] } } : undefined })
  h.app.applySettings({ onboarded: true })
  await h.type("/sessions\r")
  await Bun.sleep(5)
  h.app.render()
  expect(h.text().join("\n")).toContain("Review client")
  expect(h.text().join("\n")).toContain("Sessions")
  expect(h.sentOf("session.list").every((command) => !("roots" in command) || command.roots !== false)).toBe(true)
  await h.app.onKey("\x03")
})

test("CLI aliases reach a local daemon: metadata, custom command, send, wait, export, rename, fork and delete", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "b15-cli-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "commands"))
  writeFileSync(path.join(dir, "commands", "review.md"), "Review $ARGUMENTS")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  let listener: ((event: SessionEvent) => void) | undefined
  const client = createClient({ socketPath: daemon.socketPath, name: "b15-cli", onEvent: (event) => listener?.(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const run = async (...args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runAutomation(parsed("--dir", dir, "session", ...args, "--json"), { client, listen: (handler) => { listener = handler }, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) }, cwd: dir, now: Date.now, onInterrupt: () => {} })
    return { code, data: out.length ? JSON.parse(out.at(-1)!).data : undefined, error: err.join("") }
  }
  const created = await run("create", "--title", "Parity")
  const sessionId = created.data.sessionId as SessionId
  expect((await run("get", sessionId)).data.session.title).toBe("Parity")
  expect((await run("status", sessionId)).data.state).toBe("idle")
  expect((await run("send", sessionId, "client", "--command", "review", "--timeout-ms", "500")).code).toBe(0)
  expect((await run("wait", sessionId, "--timeout-ms", "500")).data.status).toBe("completed")
  expect((await run("inspect", sessionId)).data.messages.turns[0].items[0].text).toBe("/review client")
  expect(JSON.parse((await run("export", sessionId)).data.text)).toMatchObject({ format: "mendcode-session@1", sessionId, turns: [{ items: [{ kind: "user_message", text: "/review client" }, { kind: "agent_message" }] }] })
  const events = await client.send({ type: "session.events", sessionId })
  expect(events.ok).toBe(true)
  if (events.ok) expect((events.result?.events as SessionEvent[]).length).toBeGreaterThan(0)
  expect((await run("rename", sessionId, "Renamed", "session")).code).toBe(0)
  const forked = await run("fork", sessionId)
  expect((await run("get", forked.data.sessionId)).data.session.title).toBe("fork: Renamed session")
  expect((await run("delete", sessionId)).code).toBe(0)
  expect((await run("get", sessionId)).code).toBe(1)
})
