import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Client, CommandInput } from "@mendcode/client"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { parseApply } from "../src/apply-args"
import { createApplyAutomation } from "../src/apply-automation"
import { applyFileDiff, planApply } from "../src/apply-patch"
import { parseGlobalOptions } from "../src/global-options"
import { terminateDaemon } from "../src/launcher"
import { parseAnswerJson, unsupportedKeywords, validateJson } from "../src/output-schema"
import { createHeadlessRun, EXIT } from "../src/run"
import { loadRunOutput } from "../src/run-output"
import { parseStartup } from "../src/startup"
import { completionScript } from "../src/support-output"

const ids = createIdFactory()
const MAIN = path.resolve(import.meta.dir, "../src/main.ts")

describe("scripting flags: argument parsing", () => {
  test("every run flag lands in the startup options", () => {
    expect(parseStartup(["run", "go", "--output-schema", "s.json", "-o", "last.txt", "--ephemeral", "--max-turns", "7", "--tools", "read, grep", "--exclude-tools=shell", "--system-prompt", "S", "--append-system-prompt", "A", "--permission", "plan", "--offline"])).toMatchObject({
      kind: "run", words: ["go"], outputSchema: "s.json", outputFile: "last.txt", ephemeral: true, maxTurns: 7, tools: ["read", "grep"], excludeTools: ["shell"], systemPrompt: "S", appendSystemPrompt: "A", permission: "plan", offline: true,
    })
    expect(parseStartup(["run", "go", "--output-last-message=out.txt"])).toMatchObject({ outputFile: "out.txt", ephemeral: false, offline: false })
    expect(parseStartup(["run", "go", "--no-tools"])).toMatchObject({ tools: [] })
    expect(parseStartup(["run", "-", "--max-turns", "1"])).toMatchObject({ words: [], maxTurns: 1 })
  })

  test("-c KEY=VALUE is a config override while a bare -c stays --continue", () => {
    expect(parseStartup(["run", "go", "-c", "max_turns=3", "-c", "tools=read", "--config", "offline=true", "--config=ephemeral=true", "-c", "model=openai/gpt-6-luna"])).toMatchObject({ maxTurns: 3, tools: ["read"], offline: true, ephemeral: true, model: "openai/gpt-6-luna", continue: false })
    expect(parseStartup(["run", "go", "-c"])).toMatchObject({ continue: true })
    expect(parseStartup(["run", "go", "-c", "-m", "a/b"])).toMatchObject({ continue: true, model: "a/b" })
  })

  test("an explicit flag wins over the same config key", () => {
    expect(parseStartup(["run", "go", "-c", "max_turns=9", "--max-turns", "2", "-c", "Exclude-Tools=shell"])).toMatchObject({ maxTurns: 2, excludeTools: ["shell"] })
  })

  test("bad values and bad combinations are usage errors", () => {
    const bad = [
      ["run", "x", "--max-turns", "0"], ["run", "x", "--max-turns", "abc"], ["run", "x", "--max-turns", "1001"], ["run", "x", "--permission", "full"],
      ["run", "x", "--ephemeral", "--continue"], ["run", "x", "--ephemeral", "-s", ids("session")], ["run", "x", "--no-tools", "--tools", "read"],
      ["run", "x", "-c", "unknown_key=1"], ["run", "x", "-c", "offline=maybe"], ["run", "x", "--tools", ","], ["run", "x", "--output-schema"],
      ["--max-turns", "3"], ["--ephemeral"], ["project", "-o", "file"],
    ]
    for (const args of bad) expect(() => parseStartup(args)).toThrow()
  })

  test("--offline is a global flag any command accepts", () => {
    expect(parseGlobalOptions(["session", "list", "--offline"])).toMatchObject({ args: ["session", "list"], offline: true })
    expect(parseGlobalOptions(["run", "--offline=false", "x"]).offline).toBeUndefined()
  })

  test("apply arguments", () => {
    expect(parseApply(["apply", ids("session"), "--to", "../other", "--check", "--json"])).toMatchObject({ ok: true, command: { kind: "apply", to: "../other", check: true, json: true } })
    expect(parseApply(["apply"])).toMatchObject({ ok: true, command: { kind: "apply", check: false } })
    expect(parseApply(["apply", "a", "b"])).toMatchObject({ ok: false })
    expect(parseApply(["apply", "--bogus"])).toMatchObject({ ok: false })
    expect(parseApply(["session", "list"])).toBeUndefined()
  })

  test("fish and PowerShell completions cover commands, subcommands and the scripting flags", () => {
    for (const shell of ["fish", "powershell"] as const) {
      const script = completionScript(shell)
      for (const word of ["run", "session", "output-schema", "max-turns", "ephemeral", "offline", "tools"]) expect(script).toContain(word)
    }
    expect(completionScript("fish")).toContain("complete -c $command")
    expect(completionScript("powershell")).toContain("Register-ArgumentCompleter")
  })
})

describe("output schema validation (the supported JSON Schema subset)", () => {
  const schema = { type: "object", required: ["name", "n"], additionalProperties: false, properties: { name: { type: "string" }, n: { type: "integer" }, kind: { enum: ["a", "b"] }, tags: { type: "array", items: { type: "string" } }, note: { type: ["string", "null"] } } }

  test("accepts conforming documents", () => {
    expect(validateJson(schema, { name: "x", n: 2, kind: "a", tags: ["t"], note: null })).toEqual([])
    expect(validateJson({ type: "array", items: { type: "number" } }, [1, 2.5])).toEqual([])
    expect(validateJson(true, 1)).toEqual([])
    expect(validateJson({ const: { a: [1] } }, { a: [1] })).toEqual([])
  })

  test("names the path of every mismatch", () => {
    const problems = validateJson(schema, { name: 3, kind: "z", tags: ["t", 4], extra: true })
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("$.name: expected string, got number"), expect.stringContaining("$.n: required property is missing"),
      expect.stringContaining("$.kind: must be one of"), expect.stringContaining("$.tags[1]: expected string"), expect.stringContaining("$.extra: property is not allowed"),
    ]))
    expect(validateJson({ type: "integer" }, 1.5)).toHaveLength(1)
    expect(validateJson({ type: "object" }, [])).toHaveLength(1)
    expect(validateJson(false, 1)).toHaveLength(1)
  })

  test("a keyword outside the subset is rejected instead of being skipped", () => {
    expect(unsupportedKeywords(schema)).toEqual([])
    expect(unsupportedKeywords({ type: "string", pattern: "^a" })).toEqual([expect.stringContaining('unsupported keyword "pattern"')])
    expect(unsupportedKeywords({ properties: { a: { $ref: "#/x" } } })).toEqual([expect.stringContaining("$.a")])
    expect(unsupportedKeywords({ type: "date" })).toHaveLength(1)
    expect(unsupportedKeywords({ title: "t", description: "d", $schema: "x", type: "string" })).toEqual([])
    expect(unsupportedKeywords([])).toHaveLength(1)
  })

  test("the answer may be the JSON alone or one fenced block", () => {
    expect(parseAnswerJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseAnswerJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseAnswerJson("here you go: {}")).toMatchObject({ ok: false })
    expect(parseAnswerJson("  ")).toMatchObject({ ok: false })
  })
})

describe("headless run with an output contract", () => {
  const dirs: string[] = []
  const temp = () => (dirs.push(mkdtempSync(path.join(tmpdir(), "mendcode-run-output-"))), dirs.at(-1)!)
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

  async function drive({ answers, output, failWith }: { answers: string[]; output: Awaited<ReturnType<typeof loadRunOutput>>; failWith?: string }) {
    const sessionId = ids("session"), queueId = ids("queue"), turnId = ids("turn")
    const out: string[] = [], err: string[] = []
    const client = { send: async () => ({ ok: true, result: { queueId } }) } as unknown as Client
    const run = createHeadlessRun({ client, sessionId, prompt: "go", json: false, approve: false, hold: output.hold, finish: (message) => output.finish(message), out: { write: (text: string) => out.push(text) }, err: { write: (text: string) => err.push(text) } })
    let seq = 0
    const emit = (event: Record<string, unknown>) => run.onEvent({ sessionId, seq: ++seq, at: 0, ...event } as SessionEvent)
    const started = run.start()
    await Promise.resolve()
    emit({ type: "turn.started", turnId, queueId })
    for (const text of answers) {
      const itemId = ids("item")
      emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
      emit({ type: "item.delta", itemId, text })
      emit({ type: "item.completed", turnId, itemId, status: "ok" })
    }
    if (failWith) emit({ type: "turn.failed", turnId, error: { code: failWith, message: "boom" } })
    else emit({ type: "turn.completed", turnId })
    return { code: await started, out: out.join(""), err: err.join("") }
  }

  test("a schema run prints only the validated final answer, exits 0 and writes the file", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "schema.json"), JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }))
    const output = await loadRunOutput({ schemaFile: "schema.json", outputFile: "nested/last.json", cwd: dir })
    expect(output.instruction).toContain('"required":["ok"]')
    const result = await drive({ answers: ["Thinking about it.", '```json\n{ "ok": true }\n```'], output })
    expect(result).toMatchObject({ code: EXIT.completed, out: '{"ok":true}\n', err: "" })
    expect(readFileSync(path.join(dir, "nested/last.json"), "utf8")).toBe('{"ok":true}')
  })

  test("a mismatching answer exits 3 with the problems on stderr, nothing on stdout, no file", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "schema.json"), JSON.stringify({ type: "object", required: ["ok"] }))
    const output = await loadRunOutput({ schemaFile: "schema.json", outputFile: "last.json", cwd: dir })
    const result = await drive({ answers: ['{"nope":1}'], output })
    expect(result.code).toBe(EXIT.schema)
    expect(result.out).toBe("")
    expect(result.err).toContain("$.ok: required property is missing")
    expect(existsSync(path.join(dir, "last.json"))).toBe(false)
    expect((await drive({ answers: ["not json"], output })).code).toBe(EXIT.schema)
    expect((await drive({ answers: [], output })).err).toContain("no final answer")
  })

  test("-o alone streams the answer as before and writes the last message verbatim", async () => {
    const dir = temp()
    const output = await loadRunOutput({ outputFile: "last.txt", cwd: dir })
    const result = await drive({ answers: ["first", "the last one"], output })
    expect(result).toMatchObject({ code: 0, out: "first\n\nthe last one\n" })
    expect(readFileSync(path.join(dir, "last.txt"), "utf8")).toBe("the last one")
  })

  test("an unwritable output file fails the run with exit 1, not 3", async () => {
    const dir = temp()
    mkdirSync(path.join(dir, "taken"))
    const output = await loadRunOutput({ outputFile: "taken", cwd: dir })
    expect((await drive({ answers: ["x"], output })).code).toBe(EXIT.failed)
  })

  test("a failed turn writes nothing; hitting --max-turns exits 4", async () => {
    const dir = temp()
    const output = await loadRunOutput({ outputFile: "last.txt", cwd: dir })
    expect((await drive({ answers: ["partial"], output, failWith: "provider_error" })).code).toBe(EXIT.failed)
    expect((await drive({ answers: ["partial"], output, failWith: "max_steps" })).code).toBe(EXIT.limit)
    expect(existsSync(path.join(dir, "last.txt"))).toBe(false)
  })

  test("a schema file that is missing, not JSON or beyond the subset is a usage error", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "bad.json"), "{")
    writeFileSync(path.join(dir, "ref.json"), JSON.stringify({ $ref: "#/x" }))
    await expect(loadRunOutput({ schemaFile: "missing.json", cwd: dir })).rejects.toThrow("cannot read")
    await expect(loadRunOutput({ schemaFile: "bad.json", cwd: dir })).rejects.toThrow("not valid JSON")
    await expect(loadRunOutput({ schemaFile: "ref.json", cwd: dir })).rejects.toThrow("unsupported keyword")
  })
})

describe("apply a session's changes onto another checkout", () => {
  const original = "one\ntwo\nthree\nfour\nfive\n"
  const hunk = "@@ -1,5 +1,5 @@\n one\n-two\n+TWO\n three\n four\n five"

  test("hunks apply exactly, near where they say, and refuse a changed file", () => {
    expect(applyFileDiff(original, hunk)).toEqual({ ok: true, text: "one\nTWO\nthree\nfour\nfive\n" })
    expect(applyFileDiff(`zero\n${original}`, hunk)).toEqual({ ok: true, text: "zero\none\nTWO\nthree\nfour\nfive\n" })
    expect(applyFileDiff("one\n2\nthree\nfour\nfive\n", hunk)).toMatchObject({ ok: false })
    expect(applyFileDiff("", "@@ -0,0 +1,2 @@\n+a\n+b")).toEqual({ ok: true, text: "a\nb\n" })
    expect(applyFileDiff("a\nb\n", "@@ -1,2 +0,0 @@\n-a\n-b")).toEqual({ ok: true, text: "" })
    expect(applyFileDiff("a", "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file")).toEqual({ ok: true, text: "b" })
    expect(applyFileDiff("a\n", "garbage")).toMatchObject({ ok: false })
  })

  test("a plan is all or nothing and stays inside the target", async () => {
    const target = mkdtempSync(path.join(tmpdir(), "mendcode-apply-"))
    try {
      writeFileSync(path.join(target, "a.txt"), original)
      writeFileSync(path.join(target, "same.txt"), "a\nb\n")
      const file = (over: Record<string, unknown>) => ({ path: "a.txt", status: "modified", additions: 1, deletions: 1, binary: false, diff: hunk, truncated: false, ...over }) as never
      const good = await planApply({ files: [file({}), file({ path: "new.txt", status: "added", diff: "@@ -0,0 +1,1 @@\n+hi" }), file({ path: "same.txt", status: "added", diff: "@@ -0,0 +1,2 @@\n+a\n+b" })], target })
      expect(good).toMatchObject({ ok: true, changes: [{ action: "modify" }, { action: "create" }, { action: "create", note: "already present" }] })
      const bad = await planApply({ files: [file({}), file({ path: "../escape.txt" }), file({ path: "bin.png", binary: true }), file({ path: "cut.txt", truncated: true }), file({ path: "gone.txt" }), file({ path: "same.txt", status: "added", diff: "@@ -0,0 +1,1 @@\n+different" })], target })
      expect(bad.ok).toBe(false)
      expect(bad.ok ? [] : bad.problems.join("\n")).toMatch(/leaves the target[\s\S]*binary[\s\S]*cut short[\s\S]*does not exist[\s\S]*already exists with different/)
      expect(readFileSync(path.join(target, "a.txt"), "utf8")).toBe(original)
    } finally { rmSync(target, { recursive: true, force: true }) }
  })

  test("the command reads the session's changes, writes the other checkout, and --check writes nothing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mendcode-apply-src-"))
    const target = mkdtempSync(path.join(tmpdir(), "mendcode-apply-dst-"))
    try {
      writeFileSync(path.join(target, "a.txt"), original)
      const sent: CommandInput[] = []
      const report = { root, files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1, binary: false, diff: hunk, truncated: false }, { path: "dir/new.txt", status: "added", additions: 1, deletions: 0, binary: false, diff: "@@ -0,0 +1,1 @@\n+hi", truncated: false }, { path: "old.txt", status: "deleted", additions: 0, deletions: 1, binary: false, diff: "@@ -1,1 +0,0 @@\n-bye", truncated: false }], omittedFiles: 0, scope: "session", complete: true }
      writeFileSync(path.join(target, "old.txt"), "bye\n")
      const client = { send: async (command: CommandInput) => (sent.push(command), command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: ids("session") }] } } : { ok: true, result: report }) } as unknown as Client
      const lines: string[] = []
      const ctx = { client, directory: root, result: (_data: Record<string, unknown>, human: string) => (lines.push(human), 0), fail: (message: string) => (lines.push(`FAIL ${message}`), 1) }
      const run = createApplyAutomation(ctx)
      expect(await run({ kind: "apply", check: true, to: target, json: false } as never)).toBe(0)
      expect(readFileSync(path.join(target, "a.txt"), "utf8")).toBe(original)
      expect(lines.at(-1)).toContain("would apply 3 files")
      expect(await run({ kind: "apply", check: false, to: target, json: false } as never)).toBe(0)
      expect(readFileSync(path.join(target, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nfour\nfive\n")
      expect(readFileSync(path.join(target, "dir/new.txt"), "utf8")).toBe("hi\n")
      expect(existsSync(path.join(target, "old.txt"))).toBe(false)
      expect(sent.map((command) => command.type)).toContain("session.list")
      expect(await run({ kind: "apply", check: false, to: root, json: false } as never)).toBe(1)
      expect(lines.at(-1)).toContain("session's own project")
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }) }
  })
})

describe("scripted run against a real daemon (faux engine, temp dir, no network)", () => {
  const data = mkdtempSync(path.join(tmpdir(), "mendcode-scripting-data-"))
  const project = mkdtempSync(path.join(tmpdir(), "mendcode-scripting-project-"))
  const home = mkdtempSync(path.join(tmpdir(), "mendcode-scripting-home-"))
  beforeAll(() => { mkdirSync(path.join(home, ".config"), { recursive: true }) })
  afterAll(async () => {
    await terminateDaemon(data)
    for (const dir of [data, project, home]) rmSync(dir, { recursive: true, force: true })
  })

  const cli = (args: string[], stdin?: string) => spawn([...args, "--dir", data, "--engine", "faux", "--cwd", project], stdin)
  async function spawn(args: string[], stdin?: string) {
    const child = Bun.spawn([process.execPath, MAIN, ...args], {
      cwd: project, stdin: stdin === undefined ? "ignore" : new Response(stdin), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local"), MENDCODE_V2_DIR: data },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code }
  }
  const sessionOf = (stderr: string) => /^session: (\S+)/m.exec(stderr)?.[1]
  const listed = async () => (await spawn(["--dir", data, "--engine", "faux", "session", "list", "--all-projects", "--json"])).stdout

  test("--output-schema validates the final answer; -o writes it; exit codes are 0 and 3", async () => {
    writeFileSync(path.join(project, "schema.json"), JSON.stringify({ type: "object", required: ["name", "n"], properties: { name: { type: "string" }, n: { type: "integer" } } }))
    const good = await cli(["run", "--output-schema", "schema.json", "-o", "out/answer.json", '/say {"name":"x","n":2}'])
    expect(good).toMatchObject({ code: 0, stdout: '{"name":"x","n":2}\n' })
    expect(readFileSync(path.join(project, "out/answer.json"), "utf8")).toBe('{"name":"x","n":2}')
    rmSync(path.join(project, "out"), { recursive: true })
    const bad = await cli(["run", "--output-schema", "schema.json", "-o", "out/answer.json", '/say {"name":"x","n":"two"}'])
    expect(bad.code).toBe(3)
    expect(bad.stdout).toBe("")
    expect(bad.stderr).toContain("$.n: expected integer, got string")
    expect(existsSync(path.join(project, "out/answer.json"))).toBe(false)
  }, 60_000)

  test("the prompt can come from stdin; -o writes the last message; a failed turn exits 1", async () => {
    const piped = await cli(["run", "-o", "last.txt"], "from stdin")
    expect(piped).toMatchObject({ code: 0, stdout: "echo: from stdin\n" })
    expect(readFileSync(path.join(project, "last.txt"), "utf8")).toBe("echo: from stdin")
    expect((await cli(["run", "/fail"])).code).toBe(1)
  }, 60_000)

  test("--ephemeral leaves no session behind; a normal run does", async () => {
    const kept = await cli(["run", "keep me"])
    const gone = await cli(["run", "--ephemeral", "drop me"])
    expect(gone.code).toBe(0)
    expect(gone.stderr).toContain("ephemeral")
    const all = await listed()
    expect(all).toContain(sessionOf(kept.stderr)!)
    expect(all).not.toContain(sessionOf(gone.stderr)!)
  }, 60_000)

  test("limits reach the daemon: --tools, --exclude-tools, --max-turns, --offline, -c and a system prompt are accepted", async () => {
    const result = await cli(["run", "--tools", "read,grep", "--exclude-tools", "shell", "--max-turns", "3", "--offline", "-c", "permission=plan", "--append-system-prompt", "be brief", "limited"])
    expect(result).toMatchObject({ code: 0, stdout: "echo: limited\n" })
    expect((await cli(["run", "--no-tools", "--system-prompt", "only this", "none"])).code).toBe(0)
    expect((await cli(["--offline", "run", "global"])).code).toBe(0)
  }, 60_000)

  test("usage errors exit 64 before any session exists", async () => {
    const before = await listed()
    for (const args of [["run", "x", "--output-schema", "missing.json"], ["run", "x", "--max-turns", "0"], ["run", "x", "--ephemeral", "--continue"], ["run", "x", "-c", "nope=1"]]) {
      const result = await cli(args)
      expect(result.code).toBe(64)
      expect(result.stdout).toBe("")
    }
    expect(await listed()).toBe(before)
  }, 60_000)
})
