import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineHooks } from "@mendcode/engine-native"
import { createShellHooks, httpHookAllowed, promptVerdict, readShellHooks } from "../src/shell-hooks"
import { withShellHooks } from "../src/shell-hooks-engine"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

type Fetched = { url: string; headers: Record<string, string>; body: string; redirect: string }

function setup(input: { hooks: Record<string, unknown[]>; source?: "user" | "project"; pkg?: string; trusted?: boolean; allowed?: string[]; reply?: { status: number; body: string } | Error; model?: string | Error }) {
  const dir = temp("hooks-types-")
  const cwd = temp("hooks-cwd-")
  writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: input.hooks }))
  const fetched: Fetched[] = []
  const prompts: Array<{ system: string; prompt: string }> = []
  const logs: string[] = []
  const shell = createShellHooks({
    layersFor: () => [{ dir, source: input.source ?? "user", ...(input.pkg ? { pkg: input.pkg } : {}) }],
    isTrusted: () => input.trusted ?? false,
    now: () => Date.now(),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    mask: (_session, text) => text.replaceAll("TOPSECRET", "[secret #1]"),
    isChild: (sessionId) => sessionId === "ses_child",
    allowedHttpUrls: () => input.allowed,
    fetch: async (url, init) => {
      fetched.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
      if (input.reply instanceof Error) throw input.reply
      const reply = input.reply
      return { status: reply?.status ?? 200, text: async () => reply?.body ?? "" }
    },
    ...(input.model === undefined ? {} : {
      complete: async (request: { system: string; prompt: string; signal: AbortSignal }) => {
        prompts.push({ system: request.system, prompt: request.prompt })
        if (input.model instanceof Error) throw input.model
        return input.model!
      },
    }),
  })
  cleanups.push(() => shell.halt())
  return { shell, cwd, dir, fetched, prompts, logs }
}

const HTTP = (extra: Record<string, unknown> = {}) => ({ hooks: [{ type: "http", url: "https://hooks.example.test/pre?token=abc", headers: { "x-team": "core" }, ...extra }] })
const tool = (cwd: string) => ({ sessionId: "ses_1", cwd, turnId: "turn_1", tool: "bash", callId: "call_1", args: { command: "ls" } })

describe("hook events", () => {
  test("hooks.json accepts the new events and rejects unknown ones", () => {
    const dir = temp("hooks-events-")
    const names = ["PostToolUseFailure", "PermissionRequest", "Notification", "PreCompact", "PostCompact", "SubagentStop"]
    writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { ...Object.fromEntries(names.map((name) => [name, [{ hooks: [{ command: "true" }] }]])), Nope: [{ hooks: [{ command: "true" }] }] } }))
    const { hooks, problems } = readShellHooks([{ dir, source: "user" }])
    expect(hooks.map((hook) => hook.event as string)).toEqual(names)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("unknown event Nope")
  })

  test("PostToolUseFailure feedback is appended to the error the model sees", async () => {
    const { shell, cwd, dir } = setup({ hooks: { PostToolUseFailure: [{ hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/in.json"; echo "try the other flag" >&2; exit 2' }] }] } })
    expect(await shell.toolFailed({ ...tool(cwd), output: "boom" })).toEqual({ output: "boom\n\n[PostToolUseFailure hook feedback] try the other flag" })
    expect(JSON.parse(readFileSync(path.join(dir, "in.json"), "utf8"))).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "bash", error: "boom" })
  })

  test("PermissionRequest can refuse a call before the prompt and never approves one", async () => {
    const refuse = setup({ hooks: { PermissionRequest: [{ matcher: "bash", hooks: [{ command: "echo no shell here >&2; exit 2" }] }] } })
    expect(await refuse.shell.permissionRequest({ sessionId: "ses_1", cwd: refuse.cwd, tool: "bash", args: { command: "ls" }, detail: "ls" })).toEqual({ deny: "no shell here" })
    expect(await refuse.shell.permissionRequest({ sessionId: "ses_1", cwd: refuse.cwd, tool: "write", args: {}, detail: "x" })).toBeUndefined()
    const allow = setup({ hooks: { PermissionRequest: [{ hooks: [{ command: `printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] } })
    expect(await allow.shell.permissionRequest({ sessionId: "ses_1", cwd: allow.cwd, tool: "bash", args: {}, detail: "x" })).toBeUndefined()
  })

  test("Notification is matched by type, PreCompact blocks a compaction, PostCompact and SubagentStop observe", async () => {
    const { shell, cwd, dir } = setup({
      hooks: {
        Notification: [{ matcher: "question", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/note.json"' }] }],
        PreCompact: [{ matcher: "manual", hooks: [{ command: "echo keep it >&2; exit 2" }] }],
        PostCompact: [{ hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/post.json"' }] }],
        SubagentStop: [{ hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/sub.json"' }] }],
      },
    })
    await shell.notification({ sessionId: "ses_1", cwd, type: "permission_prompt", title: "Allow shell?", message: "ls" })
    expect(() => readFileSync(path.join(dir, "note.json"), "utf8")).toThrow()
    await shell.notification({ sessionId: "ses_1", cwd, type: "question", title: "Which?", message: "a or b" })
    expect(JSON.parse(readFileSync(path.join(dir, "note.json"), "utf8"))).toMatchObject({ hook_event_name: "Notification", notification_type: "question", title: "Which?" })
    expect(await shell.compactBefore({ sessionId: "ses_1", cwd, reason: "manual", tokens: 10 })).toEqual({ cancel: true })
    expect(await shell.compactBefore({ sessionId: "ses_1", cwd, reason: "auto", tokens: 10 })).toBeUndefined()
    await shell.compactAfter({ sessionId: "ses_1", cwd, reason: "auto", summary: "short" })
    expect(JSON.parse(readFileSync(path.join(dir, "post.json"), "utf8"))).toMatchObject({ hook_event_name: "PostCompact", trigger: "auto", summary: "short" })
    await shell.subagentStop({ sessionId: "ses_1", cwd })
    expect(() => readFileSync(path.join(dir, "sub.json"), "utf8")).toThrow()
    await shell.subagentStop({ sessionId: "ses_child", cwd })
    expect(JSON.parse(readFileSync(path.join(dir, "sub.json"), "utf8"))).toMatchObject({ hook_event_name: "SubagentStop", agent_session_id: "ses_child" })
  })

  test("the engine adapter wires the events and keeps `has` false without a hook", async () => {
    const inner: EngineHooks = { has: () => false }
    const { shell, cwd } = setup({ hooks: { PreCompact: [{ hooks: [{ command: "exit 2" }] }], PermissionRequest: [{ hooks: [{ command: "echo stop >&2; exit 2" }] }], PostToolUseFailure: [{ hooks: [{ command: "echo fix >&2; exit 2" }] }] } })
    const hooks = withShellHooks(inner, shell)
    expect(hooks.has("compact.before", cwd)).toBe(true)
    expect(hooks.has("compact.after", cwd)).toBe(false)
    expect(hooks.has("permission.request", cwd)).toBe(true)
    expect(hooks.has("tool.after", cwd)).toBe(true)
    expect(hooks.has("tool.before", cwd)).toBe(false)
    expect(await hooks.compactBefore!({ sessionId: "ses_1" as never, cwd, reason: "auto", tokens: 1 })).toEqual({ cancel: true })
    expect(await hooks.permissionRequest!({ sessionId: "ses_1" as never, cwd, tool: "bash", args: {}, detail: "" })).toEqual({ deny: "stop" })
    const failed = await hooks.toolAfter!({ sessionId: "ses_1" as never, cwd, turnId: "turn_1" as never, tool: "bash", callId: "c", args: {}, output: "boom", isError: true })
    expect(failed?.output).toBe("boom\n\n[PostToolUseFailure hook feedback] fix")
    expect(await hooks.toolAfter!({ sessionId: "ses_1" as never, cwd, turnId: "turn_1" as never, tool: "bash", callId: "c", args: {}, output: "fine", isError: false })).toBeUndefined()
  })
})

describe("http hooks", () => {
  test("do not run until the URL is in the allow-list, and say why in the report", async () => {
    const closed = setup({ hooks: { PreToolUse: [HTTP()] } })
    expect(closed.shell.has("PreToolUse", closed.cwd)).toBe(false)
    expect(await closed.shell.toolBefore(tool(closed.cwd))).toBeUndefined()
    expect(closed.fetched).toEqual([])
    const report = closed.shell.report(closed.cwd)
    expect(report.hooks[0]).toMatchObject({ kind: "http", layer: "user", active: false, inactiveReason: "url is not in allowedHttpHookUrls" })
    expect(report.pending.hooks).toBe(0)

    const other = setup({ hooks: { PreToolUse: [HTTP()] }, allowed: ["https://elsewhere.example.test/*"] })
    expect(other.shell.has("PreToolUse", other.cwd)).toBe(false)
  })

  test("POST the masked event as JSON, never follow redirects, and a block decision refuses the call", async () => {
    const { shell, cwd, fetched } = setup({ hooks: { PreToolUse: [HTTP()] }, allowed: ["https://hooks.example.test/*"], reply: { status: 200, body: '{"decision":"block","reason":"policy says no"}' } })
    expect(await shell.toolBefore({ ...tool(cwd), args: { command: "echo TOPSECRET" } })).toEqual({ block: "blocked by a PreToolUse hook: policy says no" })
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatchObject({ url: "https://hooks.example.test/pre?token=abc", redirect: "manual" })
    expect(fetched[0]!.headers).toMatchObject({ "content-type": "application/json", "x-team": "core" })
    expect(JSON.parse(fetched[0]!.body)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "bash" })
    expect(fetched[0]!.body).not.toContain("TOPSECRET")
    const run = shell.report(cwd).runs[0]!
    expect(run).toMatchObject({ kind: "http", outcome: "blocked" })
    // The shown command and the report carry the host and path, never the query that may hold a token.
    expect(JSON.stringify(shell.report(cwd))).not.toContain("token=abc")
  })

  test("a non-2xx status, a network error and a plain 200 never block; the log has no URL", async () => {
    const status = setup({ hooks: { PreToolUse: [HTTP()] }, allowed: ["https://hooks.example.test/*"], reply: { status: 500, body: "oops" } })
    expect(await status.shell.toolBefore(tool(status.cwd))).toBeUndefined()
    expect(status.shell.report(status.cwd).runs[0]).toMatchObject({ outcome: "failed", message: "HTTP 500" })
    const down = setup({ hooks: { PreToolUse: [HTTP()] }, allowed: ["https://hooks.example.test/*"], reply: new Error("connect refused") })
    expect(await down.shell.toolBefore(tool(down.cwd))).toBeUndefined()
    expect(down.shell.report(down.cwd).runs[0]).toMatchObject({ outcome: "failed" })
    expect(down.logs.join("\n")).not.toContain("hooks.example.test")
    const fine = setup({ hooks: { PreToolUse: [HTTP()] }, allowed: ["https://hooks.example.test/*"], reply: { status: 204, body: "" } })
    expect(await fine.shell.toolBefore(tool(fine.cwd))).toBeUndefined()
    expect(fine.shell.report(fine.cwd).runs[0]).toMatchObject({ outcome: "ok" })
  })

  test("project-layer http hooks also need the directory trust", async () => {
    const untrusted = setup({ hooks: { PreToolUse: [HTTP()] }, source: "project", allowed: ["https://hooks.example.test/*"] })
    expect(untrusted.shell.has("PreToolUse", untrusted.cwd)).toBe(false)
    expect(untrusted.shell.report(untrusted.cwd)).toMatchObject({ pending: { hooks: 1 }, hooks: [{ layer: "project", inactiveReason: "project directory is not trusted" }] })
    const trusted = setup({ hooks: { PreToolUse: [HTTP()] }, source: "project", trusted: true, allowed: ["https://hooks.example.test/*"] })
    expect(trusted.shell.has("PreToolUse", trusted.cwd)).toBe(true)
  })

  test("the allow-list matches the whole URL with * as a wildcard", () => {
    expect(httpHookAllowed("https://a.test/x?y=1", ["https://a.test/*"])).toBe(true)
    expect(httpHookAllowed("https://a.test.evil.example/x", ["https://a.test/*"])).toBe(false)
    expect(httpHookAllowed("https://a.test/x", [])).toBe(false)
    expect(httpHookAllowed("https://a.test/x", undefined)).toBe(false)
    expect(httpHookAllowed("https://a.test/x", ["https://a.test/x"])).toBe(true)
  })

  test("a non-http scheme in hooks.json is a problem", () => {
    const dir = temp("hooks-scheme-")
    writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "http", url: "file:///etc/passwd" }] }] } }))
    const { hooks, problems } = readShellHooks([{ dir, source: "user" }])
    expect(hooks).toEqual([])
    expect(problems).toHaveLength(1)
  })
})

describe("prompt hooks", () => {
  const PROMPT = (text = "Is this command safe? $ARGUMENTS") => ({ hooks: [{ type: "prompt", prompt: text }] })

  test("ok false blocks with the model's reason; ok true continues; the event is sent masked", async () => {
    const block = setup({ hooks: { PreToolUse: [PROMPT()] }, model: 'Sure. {"ok": false, "reason": "it deletes files"}' })
    expect(await block.shell.toolBefore({ ...tool(block.cwd), args: { command: "echo TOPSECRET" } })).toEqual({ block: "blocked by a PreToolUse hook: it deletes files" })
    expect(block.prompts[0]!.prompt).toContain("Is this command safe?")
    expect(block.prompts[0]!.prompt).toContain('"tool_name":"bash"')
    expect(block.prompts[0]!.prompt).not.toContain("TOPSECRET")
    expect(block.shell.report(block.cwd).runs[0]).toMatchObject({ kind: "prompt", outcome: "blocked" })
    const pass = setup({ hooks: { PreToolUse: [PROMPT("Judge this event.")] }, model: '{"ok":true}' })
    expect(await pass.shell.toolBefore(tool(pass.cwd))).toBeUndefined()
    expect(pass.prompts[0]!.prompt.startsWith("Judge this event.\n\n")).toBe(true)
  })

  test("an unreadable answer, a model error or no model at all never block", async () => {
    const garbled = setup({ hooks: { PreToolUse: [PROMPT()] }, model: "I think it is fine" })
    expect(await garbled.shell.toolBefore(tool(garbled.cwd))).toBeUndefined()
    expect(garbled.shell.report(garbled.cwd).runs[0]).toMatchObject({ outcome: "failed" })
    const broken = setup({ hooks: { PreToolUse: [PROMPT()] }, model: new Error("provider down") })
    expect(await broken.shell.toolBefore(tool(broken.cwd))).toBeUndefined()
    expect(broken.shell.report(broken.cwd).runs[0]).toMatchObject({ outcome: "failed", message: "provider down" })
    const none = setup({ hooks: { PreToolUse: [PROMPT()] } })
    expect(await none.shell.toolBefore(tool(none.cwd))).toBeUndefined()
    expect(none.shell.report(none.cwd).runs[0]).toMatchObject({ outcome: "failed", message: "no model is available for prompt hooks" })
  })

  test("verdicts are read from prose and fences", () => {
    expect(promptVerdict('```json\n{"ok":false,"reason":"x"}\n```')).toEqual({ ok: false, reason: "x" })
    expect(promptVerdict("nothing here")).toBeUndefined()
  })
})

describe("layer labels", () => {
  test("a hook says which layer it came from", () => {
    const user = temp("hooks-l1-")
    const pkg = temp("hooks-l2-")
    const project = temp("hooks-l3-")
    for (const dir of [user, pkg, project]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "true" }] }] } }))
    }
    const { hooks } = readShellHooks([{ dir: user, source: "user" }, { dir: pkg, source: "user", pkg: "lint-kit" }, { dir: project, source: "project" }])
    expect(hooks.map((hook) => hook.layer)).toEqual(["user", "user package lint-kit", "project"])
  })
})

describe("the notify command (Notification hooks for turn ends)", () => {
  const turn = (cwd: string, type: "turn_completed" | "turn_failed") => ({ sessionId: "ses_1", cwd, type, title: type === "turn_completed" ? "turn finished" : "turn failed", message: type === "turn_failed" ? "provider said no" : "" })

  test("a hook that names turn_completed runs when a turn ends; one without a matcher keeps to approvals and questions", async () => {
    const { shell, cwd, dir } = setup({
      hooks: {
        Notification: [
          { matcher: "turn_completed", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/done.json"' }] },
          { hooks: [{ command: 'cat >> "$MENDCODE_HOOK_DIR/any.log"' }] },
        ],
      },
    })
    await shell.notification(turn(cwd, "turn_completed"))
    expect(JSON.parse(readFileSync(path.join(dir, "done.json"), "utf8"))).toMatchObject({ hook_event_name: "Notification", notification_type: "turn_completed", title: "turn finished" })
    expect(() => readFileSync(path.join(dir, "any.log"), "utf8")).toThrow()
    await shell.notification({ sessionId: "ses_1", cwd, type: "question", title: "Which?", message: "a or b" })
    expect(readFileSync(path.join(dir, "any.log"), "utf8")).toContain("notification_type")
  })

  test("turn_failed carries the error text, and a hook that names only turn_completed does not see it", async () => {
    const { shell, cwd, dir } = setup({
      hooks: {
        Notification: [
          { matcher: "turn_failed", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/failed.json"' }] },
          { matcher: "turn_completed", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/done.json"' }] },
        ],
      },
    })
    await shell.notification(turn(cwd, "turn_failed"))
    expect(JSON.parse(readFileSync(path.join(dir, "failed.json"), "utf8"))).toMatchObject({ notification_type: "turn_failed", message: "provider said no" })
    expect(() => readFileSync(path.join(dir, "done.json"), "utf8")).toThrow()
  })

  test("a project hook for turn ends stays off until the project is trusted", async () => {
    const untrusted = setup({ source: "project", trusted: false, hooks: { Notification: [{ matcher: "turn_completed", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/done.json"' }] }] } })
    await untrusted.shell.notification(turn(untrusted.cwd, "turn_completed"))
    expect(() => readFileSync(path.join(untrusted.dir, "done.json"), "utf8")).toThrow()
    const trusted = setup({ source: "project", trusted: true, hooks: { Notification: [{ matcher: "turn_completed", hooks: [{ command: 'cat > "$MENDCODE_HOOK_DIR/done.json"' }] }] } })
    await trusted.shell.notification(turn(trusted.cwd, "turn_completed"))
    expect(readFileSync(path.join(trusted.dir, "done.json"), "utf8")).toContain("turn_completed")
  })
})
