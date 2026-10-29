import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, joinSystemParts, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { HooksReport, SessionEvent, SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { systemPartsWith } from "../src/extensions"
import { createShellHooks, readShellHooks } from "../src/shell-hooks"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

type HookSpec = { matcher?: string; command: string | string[]; timeout?: number }
const hooksFile = (events: Record<string, HookSpec[]>) =>
  JSON.stringify({ hooks: Object.fromEntries(Object.entries(events).map(([event, specs]) => [event, specs.map(({ matcher, ...hook }) => ({ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", ...hook }] }))])) })

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("hooks.json parsing", () => {
  test("reads Claude-style groups, case-insensitive event names, matchers and relative array commands; bad entries become problems", () => {
    const user = temp("hooks-user-")
    put(user, "hooks.json", JSON.stringify({
      hooks: {
        pretooluse: [{ matcher: "bash|write", hooks: [{ type: "command", command: "echo hi", timeout: 3 }] }],
        PostToolUse: [{ hooks: [{ command: ["./after.sh", "--flag"] }] }],
        Bogus: [{ hooks: [{ command: "x" }] }],
        Stop: [{ hooks: [] }],
        SessionStart: [{ matcher: "(", hooks: [{ command: "x" }] }],
      },
    }))
    const { hooks, problems } = readShellHooks([{ dir: user, source: "user" }])
    expect(hooks.map((hook) => [hook.event, hook.matcher, hook.timeoutMs])).toEqual([["PreToolUse", "bash|write", 3_000], ["PostToolUse", undefined, 15_000]])
    expect(hooks[0]!.regex!.test("BASH")).toBe(true)
    expect(hooks[0]!.regex!.test("read")).toBe(false)
    expect(hooks[1]!.argv).toEqual([path.join(user, "after.sh"), "--flag"])
    expect(problems.join("\n")).toContain("unknown event Bogus")
    expect(problems.join("\n")).toContain("invalid matcher")
    expect(problems.length).toBe(3)
  })

  test("invalid JSON and unknown top-level keys are problems, not exceptions", () => {
    const user = temp("hooks-user-")
    put(user, "hooks.json", "{ nope")
    const project = temp("hooks-proj-")
    put(project, "hooks.json", JSON.stringify({ hooks: {}, extra: 1 }))
    const { hooks, problems } = readShellHooks([{ dir: user, source: "user" }, { dir: project, source: "project" }])
    expect(hooks).toEqual([])
    expect(problems).toHaveLength(2)
  })
})

describe("running hooks", () => {
  function setup(options: { events: Record<string, HookSpec[]>; trusted?: boolean; source?: "user" | "project"; env?: Record<string, string | undefined>; enabled?: boolean }) {
    const dir = temp("hooks-run-")
    const cwd = temp("hooks-cwd-")
    put(dir, "hooks.json", hooksFile(options.events))
    const logs: string[] = []
    const continued: Array<[string, string]> = []
    const shell = createShellHooks({
      layersFor: () => [{ dir, source: options.source ?? "user" }],
      isTrusted: () => options.trusted ?? false,
      now: () => Date.now(),
      log: (level, message) => void logs.push(`${level}: ${message}`),
      mask: (_session, text) => text.replaceAll("TOPSECRET", "[secret #1]"),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.env ? { env: options.env } : {}),
      continueSession: (sessionId, text) => void continued.push([sessionId, text]),
    })
    cleanups.push(() => shell.halt())
    return { dir, cwd, shell, logs, continued }
  }
  const call = (cwd: string, text = "hi") => ({ sessionId: "ses_1", cwd, turnId: "turn_1", tool: "bash", callId: "call_1", args: { command: text } })

  test("exit 2 blocks with stderr as the reason, exit 1 and a timeout do not, and the tool input arrives on stdin", async () => {
    const { shell, cwd, dir, logs } = setup({ events: { PreToolUse: [{ command: 'cat > "$MENDCODE_HOOK_DIR/stdin.json"; echo "not on my watch" >&2; exit 2' }] } })
    expect(await shell.toolBefore(call(cwd, "rm -rf x"))).toEqual({ block: "blocked by a PreToolUse hook: not on my watch" })
    const stdin = JSON.parse(readFileSync(path.join(dir, "stdin.json"), "utf8"))
    expect(stdin).toMatchObject({ session_id: "ses_1", cwd, hook_event_name: "PreToolUse", tool_name: "bash", tool_use_id: "call_1", tool_input: { command: "rm -rf x" } })

    const failing = setup({ events: { PreToolUse: [{ command: "echo oops >&2; exit 1" }, { command: "sleep 5", timeout: 0.2 }] } })
    expect(await failing.shell.toolBefore(call(failing.cwd))).toBeUndefined()
    const runs = failing.shell.report(failing.cwd).runs
    expect(runs.map((run) => run.outcome)).toEqual(["timeout", "failed"])
    expect(runs[1]).toMatchObject({ exitCode: 1, message: "oops" })
    // The log names the outcome, never what the hook printed.
    expect(failing.logs.join("\n")).toContain("hook failed (exit 1)")
    expect(failing.logs.join("\n")).not.toContain("oops")
    expect(logs).toEqual([])
  })

  test("a JSON decision blocks, an allow decision never approves anything, and a missing program is a failed run", async () => {
    const block = setup({ events: { PreToolUse: [{ command: `printf '{"decision":"block","reason":"policy"}'` }] } })
    expect(await block.shell.toolBefore(call(block.cwd))).toEqual({ block: "blocked by a PreToolUse hook: policy" })
    const deny = setup({ events: { PreToolUse: [{ command: `printf '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"nope"}}'` }] } })
    expect(await deny.shell.toolBefore(call(deny.cwd))).toEqual({ block: "blocked by a PreToolUse hook: nope" })
    const allow = setup({ events: { PreToolUse: [{ command: `printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }, { command: ["/nonexistent/mendcode-hook"] }] } })
    expect(await allow.shell.toolBefore(call(allow.cwd))).toBeUndefined()
    expect(allow.shell.report(allow.cwd).runs.map((run) => run.outcome)).toEqual(["failed", "ok"])
  })

  test("matchers choose hooks by tool name; the first blocking hook ends the chain", async () => {
    const { shell, cwd, dir } = setup({ events: { PreToolUse: [
      { matcher: "write|edit", command: `echo wrong >&2; exit 2` },
      { matcher: "BASH", command: `echo one >&2; touch "$MENDCODE_HOOK_DIR/one"; exit 2` },
      { command: `touch "$MENDCODE_HOOK_DIR/two"` },
    ] } })
    expect(await shell.toolBefore(call(cwd))).toEqual({ block: "blocked by a PreToolUse hook: one" })
    expect(existsSync(path.join(dir, "one"))).toBe(true)
    expect(existsSync(path.join(dir, "two"))).toBe(false)
    expect(shell.has("PreToolUse", cwd)).toBe(true)
    expect(shell.has("PostToolUse", cwd)).toBe(false)
  })

  test("secrets are masked in what a hook receives and says; stderr feedback is capped", async () => {
    const { shell, cwd, dir } = setup({ events: { PreToolUse: [{ command: `cat > "$MENDCODE_HOOK_DIR/in.json"; printf 'leaked TOP%s ' SECRET; head -c 200000 /dev/zero | tr '\\0' x >&2; exit 2` }] } })
    const refused = await shell.toolBefore({ ...call(cwd), args: { command: "echo TOPSECRET" } })
    expect(readFileSync(path.join(dir, "in.json"), "utf8")).not.toContain("TOPSECRET")
    expect(readFileSync(path.join(dir, "in.json"), "utf8")).toContain("[secret #1]")
    expect(refused!.block.length).toBeLessThan(4_200)
    expect(JSON.stringify(shell.report(cwd))).not.toContain("TOPSECRET")
  })

  test("PostToolUse feedback is appended to the result; UserPromptSubmit blocks or adds context", async () => {
    const post = setup({ events: { PostToolUse: [{ command: `cat > "$MENDCODE_HOOK_DIR/in.json"; echo "lint failed" >&2; exit 2` }] } })
    expect(await post.shell.toolAfter({ ...call(post.cwd), output: "done", isError: false })).toEqual({ output: "done\n\n[PostToolUse hook feedback] lint failed" })
    expect(JSON.parse(readFileSync(path.join(post.dir, "in.json"), "utf8"))).toMatchObject({ hook_event_name: "PostToolUse", tool_response: { output: "done", is_error: false } })

    const prompt = setup({ events: { UserPromptSubmit: [{ command: `echo "today is friday"` }] } })
    expect(await prompt.shell.prompt({ sessionId: "ses_1", cwd: prompt.cwd, text: "hello" })).toEqual({ text: "hello\n\ntoday is friday" })
    const blocked = setup({ events: { UserPromptSubmit: [{ command: `echo "no deploys on fridays" >&2; exit 2` }] } })
    expect(await blocked.shell.prompt({ sessionId: "ses_1", cwd: blocked.cwd, text: "deploy" })).toEqual({ blocked: "no deploys on fridays" })
  })

  test("project hooks run only in a trusted directory and without credential-looking variables; user hooks keep them", async () => {
    const env = { PATH: process.env.PATH, MY_SERVICE_TOKEN: "t0ken", PLAIN: "ok" }
    const command = `printf '%s|%s' "$MY_SERVICE_TOKEN" "$PLAIN" > "$MENDCODE_HOOK_DIR/env.txt"`
    const untrusted = setup({ events: { PreToolUse: [{ command }] }, source: "project", trusted: false, env })
    await untrusted.shell.toolBefore(call(untrusted.cwd))
    expect(existsSync(path.join(untrusted.dir, "env.txt"))).toBe(false)
    expect(untrusted.shell.report(untrusted.cwd)).toMatchObject({ trusted: false, pending: { hooks: 1 }, hooks: [{ source: "project", active: false }] })

    const trusted = setup({ events: { PreToolUse: [{ command }] }, source: "project", trusted: true, env })
    await trusted.shell.toolBefore(call(trusted.cwd))
    expect(readFileSync(path.join(trusted.dir, "env.txt"), "utf8")).toBe("|ok")

    const user = setup({ events: { PreToolUse: [{ command }] }, source: "user", env })
    await user.shell.toolBefore(call(user.cwd))
    expect(readFileSync(path.join(user.dir, "env.txt"), "utf8")).toBe("t0ken|ok")
  })

  test("a Stop hook that blocks queues feedback as a follow-up turn, at most three times until the next prompt", async () => {
    const { shell, cwd, continued } = setup({ events: { Stop: [{ command: `cat >> "$MENDCODE_HOOK_DIR/stops.jsonl"; echo "tests still fail" >&2; exit 2` }] } })
    for (let index = 0; index < 5; index++) await shell.stop({ sessionId: "ses_1", cwd })
    expect(continued).toHaveLength(3)
    expect(continued[0]).toEqual(["ses_1", "A Stop hook asked you to continue: tests still fail"])
    await shell.prompt({ sessionId: "ses_1", cwd, text: "again" })
    await shell.stop({ sessionId: "ses_1", cwd })
    expect(continued).toHaveLength(4)
  })

  test("with hooks disabled nothing is read or run", async () => {
    const { shell, cwd } = setup({ events: { PreToolUse: [{ command: "exit 2" }] }, enabled: false })
    expect(shell.has("PreToolUse", cwd)).toBe(false)
    expect(await shell.toolBefore(call(cwd))).toBeUndefined()
    expect(shell.report(cwd)).toMatchObject({ enabled: false, hooks: [] })
  })
})

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown, callId = `call-${name}`): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]

function scripted(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted: the model must not be called here")
      yield* step
    },
  }
  return { provider, requests }
}

async function boot(options: { steps: ModelEvent[][]; user?: Record<string, HookSpec[]>; project?: Record<string, HookSpec[]> }) {
  const dir = temp("mendd-hooks-")
  const project = temp("mendd-hooks-proj-")
  const executed: string[] = []
  if (options.user) put(dir, "hooks.json", hooksFile(options.user))
  if (options.project) put(project, ".mendcode/hooks.json", hooksFile(options.project))
  const script = scripted(options.steps)
  const logs: string[] = []
  const tool = defineTool({ name: "echo", description: "echo text", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => (executed.push(text), { output: text, truncated: false, title: "echo", isError: false }) })
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    engine: ({ store, extensions }) => {
      extensions.setBuiltinTools([tool])
      return createNativeEngine({
        provider: script.provider,
        tools: [tool],
        history: memoryHistory(),
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: (root) => joinSystemParts(systemPartsWith({ files: extensions.prompts.read(root), root, packaged: (r) => `BASE ${r}`, rest: [] })),
        systemParts: (root) => systemPartsWith({ files: extensions.prompts.read(root), root, packaged: (r) => `BASE ${r}`, rest: [] }),
        compactionPrompt: () => "SUMMARIZE",
        hooks: extensions.hooks,
        projectTools: (root, sessionId) => extensions.tools(root, sessionId),
      })
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "hooks", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  const finished = () => events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length
  async function say(text: string) {
    const before = finished()
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (ack.ok && ack.result?.handled !== true) await until(() => finished() > before)
    return ack
  }
  const report = async () => {
    const reply = await client.send({ type: "hooks.list", directory: project })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result as HooksReport
  }
  return { dir, project, client, sessionId, say, report, logs, executed, requests: script.requests, finished }
}

const toolMessages = (request: ModelRequest) => request.messages.filter((message) => message.role === "tool")

describe("shell hooks in a native-engine session", () => {
  test("PreToolUse exit 2 refuses the tool and the model reads the stderr; other tools and PostToolUse still work", async () => {
    const { say, requests, executed, dir, report } = await boot({
      steps: [callTool("echo", { text: "secret plan" }), stop("one"), callTool("echo", { text: "fine" }, "call-2"), stop("two")],
      user: {
        PreToolUse: [{ matcher: "echo", command: `cat > "$MENDCODE_HOOK_DIR/pre.json"; if grep -q "secret plan" "$MENDCODE_HOOK_DIR/pre.json"; then echo "no secret plans" >&2; exit 2; fi` }],
        PostToolUse: [{ command: `echo "audited" >&2; exit 2` }],
      },
    })
    await say("first")
    expect(executed).toEqual([])
    expect(toolMessages(requests[1]!)).toMatchObject([{ name: "echo", output: "blocked by a PreToolUse hook: no secret plans", isError: true }])
    expect(JSON.parse(readFileSync(path.join(dir, "pre.json"), "utf8"))).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "echo", tool_input: { text: "secret plan" } })
    await say("second")
    expect(executed).toEqual(["fine"])
    expect(toolMessages(requests[3]!).at(-1)).toMatchObject({ output: "fine\n\n[PostToolUse hook feedback] audited", isError: false })
    const listed = await report()
    expect(listed.hooks.map((hook) => [hook.event, hook.source, hook.active])).toEqual([["PreToolUse", "user", true], ["PostToolUse", "user", true]])
    expect(listed.runs[0]).toMatchObject({ event: "PostToolUse", tool: "echo", outcome: "blocked" })
  })

  test("UserPromptSubmit exit 2 keeps the prompt from the model; its secrets arrive as markers", async () => {
    const { say, requests, dir } = await boot({
      steps: [stop("answered")],
      user: { UserPromptSubmit: [{ command: `cat > "$MENDCODE_HOOK_DIR/prompt.json"; if grep -q forbidden "$MENDCODE_HOOK_DIR/prompt.json"; then echo "forbidden word" >&2; exit 2; fi; echo "extra context"` }] },
    })
    const refused = await say("this is forbidden")
    expect(refused).toMatchObject({ ok: true, result: { handled: true, notice: "blocked by a UserPromptSubmit hook: forbidden word" } })
    expect(requests).toHaveLength(0)
    await say("my PASSWORD=Zq7vLm2xKd9RtWb4Nc8Y is set")
    const sent = readFileSync(path.join(dir, "prompt.json"), "utf8")
    expect(sent).not.toContain("Zq7vLm2xKd9RtWb4Nc8Y")
    const userMessage = requests[0]!.messages.find((message) => message.role === "user")!
    expect(JSON.stringify(userMessage)).toContain("extra context")
    expect(JSON.stringify(userMessage)).not.toContain("Zq7vLm2xKd9RtWb4Nc8Y")
  })

  test("Stop starts one follow-up turn with the hook's reason, then lets the turn end", async () => {
    const { say, requests, dir } = await boot({
      steps: [stop("done?"), stop("fixed")],
      user: { Stop: [{ command: `cat > "$MENDCODE_HOOK_DIR/stop.json"; if [ ! -e "$MENDCODE_HOOK_DIR/once" ]; then touch "$MENDCODE_HOOK_DIR/once"; echo "run the tests first" >&2; exit 2; fi` }] },
    })
    await say("finish up")
    await until(() => requests.length === 2)
    expect(JSON.stringify(requests[1]!.messages)).toContain("A Stop hook asked you to continue: run the tests first")
    // The hook truncates and rewrites the file; a read in between sees it empty.
    await until(() => { try { return JSON.parse(readFileSync(path.join(dir, "stop.json"), "utf8")).stop_hook_active === true } catch { return false } })
  })

  test("SessionStart runs when a session is created", async () => {
    const { dir } = await boot({ steps: [], user: { SessionStart: [{ matcher: "startup", command: `cat > "$MENDCODE_HOOK_DIR/start.json"` }] } })
    await until(() => existsSync(path.join(dir, "start.json")) && readFileSync(path.join(dir, "start.json"), "utf8").length > 0)
    expect(JSON.parse(readFileSync(path.join(dir, "start.json"), "utf8"))).toMatchObject({ hook_event_name: "SessionStart", source: "startup" })
  })

  test("project hooks wait for trust: listed as pending and inactive, then enforced once the directory is trusted", async () => {
    const { say, requests, executed, report, client, project } = await boot({
      steps: [callTool("echo", { text: "one" }), stop("first"), callTool("echo", { text: "two" }, "call-2"), stop("second")],
      project: { PreToolUse: [{ command: `echo "project says no" >&2; exit 2` }] },
    })
    await say("untrusted")
    expect(executed).toEqual(["one"])
    expect(await report()).toMatchObject({ trusted: false, pending: { hooks: 1 }, hooks: [{ source: "project", active: false }], runs: [] })
    expect(await client.send({ type: "tools.trust", directory: project, trusted: true })).toMatchObject({ ok: true })
    expect(await report()).toMatchObject({ trusted: true, pending: { hooks: 0 }, hooks: [{ source: "project", active: true }] })
    await say("trusted")
    expect(executed).toEqual(["one"])
    expect(toolMessages(requests[3]!).at(-1)).toMatchObject({ output: "blocked by a PreToolUse hook: project says no", isError: true })
  })
})
