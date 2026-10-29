import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createNativeEngine, type ModelEvent, type ModelMessage, type ModelProvider } from "@mendcode/engine-native"
import { createIdFactory, type Loop, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { loopTool, read, write } from "@mendcode/tools"
import { startDaemon } from "../src"
import { createGitWorktrees, isGitCheckout } from "../src/loop-worktree"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, args } }, { type: "finish", reason: "tool_calls" }]
const checkpoint = (status = "continue") => stop(`Report.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: looked around\n\`\`\``)

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function gitRepo() {
  const repo = tempDir("loop-repo-")
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "user.name", "Test")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(path.join(repo, "README.md"), "hello\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  return repo
}

type Boot = { steps: ModelEvent[][] }

/** A daemon over the native engine with a scripted model and the real write, read and loop tools. */
async function boot(options: Boot) {
  const dir = tempDir("mendd-loopp-")
  const project = tempDir("mendd-loopp-proj-")
  const steps = [...options.steps]
  const requests: Array<{ messages: ModelMessage[] }> = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  const tools = [write, read, loopTool]
  const events: SessionEvent[] = []
  const loopChanges: Loop[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    engine: ({ store, loops, grants }) =>
      createNativeEngine({
        provider,
        tools,
        grants,
        loops,
        history: {
          load: async (sessionId) => {
            const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]
            return messages.length ? messages : undefined
          },
          save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
          replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
        },
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: () => "BASE",
        compactionPrompt: "SUMMARIZE",
      }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "loopp", onEvent: (event) => void events.push(event), onGlobal: (event) => void (event.type === "loop.changed" && loopChanges.push(event.loop)) })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, project, daemon, client, events, loopChanges, steps, requests }
}
type Harness = Awaited<ReturnType<typeof boot>>

const listLoops = async (client: Client, directory?: string) => {
  const reply = await client.send({ type: "loop.list", ...(directory ? { directory } : {}) })
  return (reply.ok ? reply.result?.loops : []) as Loop[]
}
const loopState = (h: Harness, loopId: string) => h.loopChanges.filter((loop) => loop.loopId === loopId).at(-1)

describe("report-only loops through the real engine", () => {
  test("a report-only loop cannot write even when the default permission is full", async () => {
    const h = await boot({ steps: [callTool("write", { path: "hack.txt", content: "nope" }), checkpoint("continue")] })
    await h.client.send({ type: "settings.set", patch: { defaultPermission: "full" } })
    const created = await h.client.send({ type: "loop.create", name: "report", directory: h.project, objective: "look around", trigger: { kind: "manual" }, budget: { mode: "monitor" }, reportOnly: true, runNow: true })
    expect(created.ok).toBe(true)
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    expect(loop.reportOnly).toBe(true)
    await until(() => loopState(h, loop.loopId)?.history[0]?.outcome === "completed")
    const events = h.daemon.store.readAfter(loop.sessionId, 0)
    expect(events.find((e) => e.type === "session.permission")).toMatchObject({ mode: "plan" })
    const toolDone = events.find((e) => e.type === "item.completed" && e.status === "error")
    expect(toolDone).toMatchObject({ text: expect.stringContaining("plan mode is read-only") })
    expect(existsSync(path.join(h.project, "hack.txt"))).toBe(false)
    expect(loopState(h, loop.loopId)!.history[0]!.checkpoint).toMatchObject({ status: "continue" })
    expect(h.requests[0]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Report-only loop") })
  })

  test("a loop made from a template, an unknown template, report-only with a worktree, and a non-git worktree are handled at the command", async () => {
    const h = await boot({ steps: [] })
    const templates = await h.client.send({ type: "loop.templates" })
    expect(templates.ok && (templates.result?.templates as Array<{ id: string }>).map((template) => template.id)).toEqual(["pr-watch", "ci-repair", "research-digest", "repo-maintenance"])
    const created = await h.client.send({ type: "loop.create", name: "digest", directory: h.project, template: "research-digest" })
    expect(created).toMatchObject({ ok: true, result: { loop: { template: "research-digest", reportOnly: true, trigger: { kind: "adaptive" } } } })
    expect(await h.client.send({ type: "loop.create", name: "x", directory: h.project, template: "nope" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "loop.create", name: "x", directory: h.project, template: "research-digest", workspace: "worktree" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "loop.create", name: "x", directory: h.project, template: "repo-maintenance", workspace: "worktree" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("not a git checkout") } })
    const invalid = await h.client.send({ type: "loop.create", name: "x", directory: h.project })
    expect(invalid.ok).toBe(false)
  })

  test("an external loop is fired by loop.fire; other loops refuse it", async () => {
    const h = await boot({ steps: [checkpoint("continue")] })
    const created = await h.client.send({ type: "loop.create", name: "ci", directory: h.project, objective: "react to CI", trigger: { kind: "external" }, budget: { mode: "monitor" } })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    expect(loop.nextWakeAt).toBeUndefined()
    const fired = await h.client.send({ type: "loop.fire", loopId: loop.loopId, note: "CI run 7 failed" })
    expect(fired).toMatchObject({ ok: true, result: { queued: false } })
    await until(() => loopState(h, loop.loopId)?.history[0]?.outcome === "completed")
    expect(h.requests[0]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("fired from outside: CI run 7 failed") })
    expect(loopState(h, loop.loopId)!.history[0]).toMatchObject({ trigger: "external" })
    const interval = await h.client.send({ type: "loop.create", name: "i", directory: h.project, objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    const intervalId = (interval.ok ? (interval.result?.loop as Loop).loopId : undefined)!
    expect(await h.client.send({ type: "loop.fire", loopId: intervalId })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "loop.fire", loopId: createIdFactory()("loop") })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    await h.client.send({ type: "loop.control", loopId: loop.loopId, action: "pause" })
    expect(await h.client.send({ type: "loop.fire", loopId: loop.loopId })).toMatchObject({ ok: false, error: { code: "busy" } })
  })
})

describe("worktree leases on a real git repository", () => {
  test("the git worktree port creates, detects changes, commits them to the branch and cleans up", async () => {
    const repo = gitRepo()
    const root = tempDir("lease-root-")
    const port = createGitWorktrees({ root })
    expect(await isGitCheckout(repo)).toBe(true)
    expect(await isGitCheckout(tempDir("not-git-"))).toBe(false)

    const made = await port.create({ directory: repo, key: "lop_A-r1", label: "Fix the Build!", })
    expect(made).toMatchObject({ ok: true, branch: "loop/fix-the-build-lop_A-r1" })
    if (!made.ok) return
    expect(made.path).toBe(path.join(root, "lop_A-r1"))
    expect(readFileSync(path.join(made.path, "README.md"), "utf8")).toBe("hello\n")
    expect(made.base).toBe(git(repo, "rev-parse", "HEAD"))
    expect(git(repo, "worktree", "list")).toContain(made.path)

    // A run that changed nothing leaves no trace.
    expect(await port.release({ directory: repo, path: made.path, branch: made.branch, base: made.base })).toEqual({ state: "removed" })
    expect(existsSync(made.path)).toBe(false)
    expect(git(repo, "branch", "--list", "loop/*")).toBe("")
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1)

    // A run that left files behind: they are committed on the branch, the directory goes, the branch stays.
    const second = await port.create({ directory: repo, key: "lop_A-r2", label: "fix" })
    if (!second.ok) throw new Error(second.message)
    writeFileSync(path.join(second.path, "new.txt"), "work\n")
    writeFileSync(path.join(second.path, "README.md"), "hello, changed\n")
    const released = await port.release({ directory: repo, path: second.path, branch: second.branch, base: second.base })
    expect(released).toMatchObject({ state: "retained", detail: expect.stringContaining("1 commit on branch") })
    expect(existsSync(second.path)).toBe(false)
    expect(git(repo, "show", `${second.branch}:new.txt`)).toBe("work")
    expect(git(repo, "show", `${second.branch}:README.md`)).toBe("hello, changed")
    // The user's own checkout never changed.
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hello\n")
    expect(existsSync(path.join(repo, "new.txt"))).toBe(false)
    expect(git(repo, "status", "--porcelain")).toBe("")

    // The next run can continue from the kept branch.
    const third = await port.create({ directory: repo, key: "lop_A-r3", label: "fix", from: second.branch })
    if (!third.ok) throw new Error(third.message)
    expect(readFileSync(path.join(third.path, "new.txt"), "utf8")).toBe("work\n")
    expect(await port.release({ directory: repo, path: third.path, branch: third.branch, base: third.base })).toEqual({ state: "removed" })
    expect(git(repo, "branch", "--list", second.branch)).toContain(second.branch)
  })

  test("refusals: not a git checkout, a path outside the lease root, a missing previous branch", async () => {
    const repo = gitRepo()
    const root = tempDir("lease-root-")
    const port = createGitWorktrees({ root })
    expect(await port.create({ directory: tempDir("plain-"), key: "k", label: "x" })).toMatchObject({ ok: false, message: expect.stringContaining("not a git checkout") })
    expect(await port.create({ directory: repo, key: "../escape", label: "x" })).toMatchObject({ ok: false })
    expect(await port.create({ directory: repo, key: "k", label: "x", from: "loop/gone" })).toMatchObject({ ok: false, message: expect.stringContaining("is gone") })
    expect(await port.release({ directory: repo, path: repo, branch: "main" })).toMatchObject({ state: "retained", detail: expect.stringContaining("outside") })
    expect(existsSync(path.join(repo, "README.md"))).toBe(true)
  })

  test("a loop run works in its own worktree and session; its edits never reach the user's checkout; the lease is cleaned up", async () => {
    const repo = gitRepo()
    const h = await boot({ steps: [callTool("write", { path: "note.txt", content: "from the loop\n" }), checkpoint("continue"), checkpoint("continue")] })
    await h.client.send({ type: "settings.set", patch: { defaultPermission: "full" } })
    const created = await h.client.send({ type: "loop.create", name: "Night fixer", directory: repo, objective: "write a note", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    expect(created.ok).toBe(true)
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    expect(loop.workspace).toBe("worktree")
    await h.client.send({ type: "loop.control", loopId: loop.loopId, action: "run" })
    await until(() => ["retained", "removed"].includes(loopState(h, loop.loopId)?.history[0]?.worktree?.state ?? ""))
    const done = loopState(h, loop.loopId)!
    const run = done.history[0]!
    expect(run).toMatchObject({ outcome: "completed", worktree: { state: "retained", detail: expect.stringContaining("1 commit") } })
    expect(run.sessionId).toBeDefined()
    expect(run.sessionId).not.toBe(loop.sessionId)
    // The run's session lived in the worktree directory under the data dir, not in the user's repo.
    expect(run.worktree!.path.startsWith(path.join(h.dir, "loop-worktrees"))).toBe(true)
    expect(h.daemon.store.sessionDirectory(run.sessionId as SessionId)).toBe(run.worktree!.path)
    expect(existsSync(run.worktree!.path)).toBe(false)
    expect(readdirSync(path.join(h.dir, "loop-worktrees"))).toEqual([])
    expect(git(repo, "show", `${run.worktree!.branch}:note.txt`)).toBe("from the loop")
    expect(existsSync(path.join(repo, "note.txt"))).toBe(false)
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "branch", "--show-current")).toBe("main")

    // A second run that changes nothing leaves no branch behind (monitors start from HEAD every time).
    await h.client.send({ type: "loop.control", loopId: loop.loopId, action: "run" })
    await until(() => loopState(h, loop.loopId)?.history[1]?.worktree?.state === "removed")
    expect(git(repo, "branch", "--list", "loop/*").split("\n").filter(Boolean)).toHaveLength(1)
  })
})

describe("the loop tool", () => {
  const createCall = { action: "create", name: "deps", objective: "check for outdated dependencies and report", trigger: "daily 09:00 Europe/Madrid", mode: "monitor" }

  async function ask(h: Harness, text: string) {
    const created = await h.client.send({ type: "session.create", directory: h.project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(sessionId, 0)
    await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
    await until(() => h.events.some((e) => e.type === "server.request" && e.sessionId === sessionId))
    const request = h.events.find((e) => e.type === "server.request" && e.sessionId === sessionId) as Extract<SessionEvent, { type: "server.request" }>
    return { sessionId, request }
  }
  const finish = async (h: Harness, sessionId: SessionId, decision: { kind: "approve"; scope: "once" | "session" } | { kind: "deny"; reason?: string }, request: Extract<SessionEvent, { type: "server.request" }>) => {
    const done = () => h.events.filter((e) => e.sessionId === sessionId && (e.type === "turn.completed" || e.type === "turn.failed")).length
    const before = done()
    await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision })
    await until(() => done() > before)
  }

  test("creating a loop asks first, shows what it will do, and creates a report-only loop only after approval", async () => {
    const h = await boot({ steps: [callTool("loop", createCall), stop("created"), callTool("loop", createCall), stop("denied")] })
    const { sessionId, request } = await ask(h, "set up a weekly dependency check")
    expect(request.title).toBe("Manage loops")
    expect(request.detail).toContain('Loop "deps"')
    expect(request.detail).toContain("daily 09:00 Europe/Madrid")
    expect(request.detail).toContain("may only read and report")
    expect(await listLoops(h.client)).toEqual([])
    await finish(h, sessionId, { kind: "approve", scope: "once" }, request)
    const loops = await listLoops(h.client)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toMatchObject({ name: "deps", directory: h.project, reportOnly: true, trigger: { kind: "daily", at: "09:00", timezone: "Europe/Madrid" }, budget: { mode: "monitor" }, state: "active" })
    expect(loops[0]!.nextWakeAt).toBeGreaterThan(Date.now())
    expect(h.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: "tool", isError: false, output: expect.stringContaining("created") })

    // A denied request creates nothing; the persisted result is available on the next turn.
    h.events.length = 0
    const second = await ask(h, "do it again")
    await finish(h, second.sessionId, { kind: "deny", reason: "not now" }, second.request)
    expect(await listLoops(h.client)).toHaveLength(1)
    expect(h.daemon.store.engineMessages.load(second.sessionId, "native").at(-1)).toMatchObject({ role: "tool", isError: true, output: "denied by user: not now" })
  })

  test("smart mode still asks for the loop tool; list and pause work on this project's loops only", async () => {
    const h = await boot({ steps: [callTool("loop", { action: "list" }), stop("listed"), callTool("loop", { action: "pause", loopId: "PLACEHOLDER" }), stop("paused")] })
    const own = await h.client.send({ type: "loop.create", name: "mine", directory: h.project, objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    const ownId = (own.ok ? (own.result?.loop as Loop).loopId : undefined)!
    const foreign = await h.client.send({ type: "loop.create", name: "theirs", directory: tempDir("other-project-"), objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    const foreignId = (foreign.ok ? (foreign.result?.loop as Loop).loopId : undefined)!
    h.steps[2] = callTool("loop", { action: "pause", loopId: foreignId })
    h.steps.push(callTool("loop", { action: "pause", loopId: ownId }), stop("done"))

    const created = await h.client.send({ type: "session.create", directory: h.project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(sessionId, 0)
    await h.client.send({ type: "session.permission.set", sessionId, mode: "smart" })
    const turns = () => h.events.filter((e) => e.type === "turn.completed").length
    const requests = () => h.events.filter((e): e is Extract<SessionEvent, { type: "server.request" }> => e.type === "server.request")
    const step = async (text: string) => {
      const before = turns()
      const asked = requests().length
      await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
      await until(() => requests().length > asked)
      await h.client.send({ type: "request.resolve", sessionId, requestId: requests().at(-1)!.requestId, decision: { kind: "approve", scope: "once" } })
      await until(() => turns() > before)
    }
    await step("list loops")
    expect(h.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: "tool", output: expect.stringContaining("name=\"mine\"") })
    expect(String((h.requests.at(-1)!.messages.at(-1) as { output: string }).output)).not.toContain("theirs")
    await step("pause the other project's loop")
    expect(h.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: "tool", isError: true, output: "no such loop in this project" })
    expect((await listLoops(h.client)).find((loop) => loop.loopId === foreignId)!.state).toBe("active")
    await step("pause mine")
    expect((await listLoops(h.client)).find((loop) => loop.loopId === ownId)!.state).toBe("paused")
  })

  test("problems are reported to the model without asking to create anything", async () => {
    const h = await boot({ steps: [callTool("loop", { action: "create", name: "bad", objective: "o", trigger: "sometimes", mode: "goal" }), stop("ok")] })
    const { sessionId, request } = await ask(h, "make a loop")
    expect(request.detail).toContain("Problems:")
    expect(request.detail).toContain('unknown trigger "sometimes"')
    await finish(h, sessionId, { kind: "approve", scope: "once" }, request)
    expect(h.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: "tool", isError: true, output: expect.stringContaining("unknown trigger") })
    expect(await listLoops(h.client)).toEqual([])
  })
})

describe("permissions.list and permissions.revoke", () => {
  test("a session grant from an approval is listed and can be revoked one by one or all at once", async () => {
    const steps = [callTool("write", { path: "a.txt", content: "a" }), stop("one"), callTool("write", { path: "b.txt", content: "b" }), stop("two"), callTool("write", { path: "c.txt", content: "c" }), stop("three")]
    const h = await boot({ steps })
    const created = await h.client.send({ type: "session.create", directory: h.project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(sessionId, 0)
    const turns = () => h.events.filter((e) => e.type === "turn.completed").length
    const requests = () => h.events.filter((e) => e.type === "server.request").length
    expect(await h.client.send({ type: "permissions.list", sessionId })).toMatchObject({ ok: true, result: { grants: [] } })

    await h.client.send({ type: "user.submit", sessionId, text: "write a", attachments: [] })
    await until(() => requests() === 1)
    const request = h.events.find((e) => e.type === "server.request") as Extract<SessionEvent, { type: "server.request" }>
    await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "session" } })
    await until(() => turns() === 1)
    const listed = await h.client.send({ type: "permissions.list", sessionId })
    expect(listed).toMatchObject({ ok: true, result: { grants: [{ grantId: "write", tool: "write", permission: "write" }] } })

    // The grant is in force: the next write does not ask.
    await h.client.send({ type: "user.submit", sessionId, text: "write b", attachments: [] })
    await until(() => turns() === 2)
    expect(requests()).toBe(1)
    expect(existsSync(path.join(h.project, "b.txt"))).toBe(true)

    expect(await h.client.send({ type: "permissions.revoke", sessionId, grantId: "nope" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "permissions.revoke", sessionId, grantId: "write" })).toMatchObject({ ok: true, result: { revoked: 1 } })
    expect(await h.client.send({ type: "permissions.list", sessionId })).toMatchObject({ ok: true, result: { grants: [] } })
    expect(await h.client.send({ type: "permissions.revoke", sessionId, grantId: "all" })).toMatchObject({ ok: true, result: { revoked: 0 } })

    // Revoked: the next write asks again.
    await h.client.send({ type: "user.submit", sessionId, text: "write c", attachments: [] })
    await until(() => requests() === 2)
    const again = h.events.filter((e) => e.type === "server.request").at(-1) as Extract<SessionEvent, { type: "server.request" }>
    await h.client.send({ type: "request.resolve", sessionId, requestId: again.requestId, decision: { kind: "approve", scope: "once" } })
    await until(() => turns() === 3)
    expect(await h.client.send({ type: "permissions.revoke", sessionId, grantId: "all" })).toMatchObject({ ok: true, result: { revoked: 0 } })
    expect(await h.client.send({ type: "permissions.list", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})
