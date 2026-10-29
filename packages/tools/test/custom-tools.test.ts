import { describe, expect, test } from "bun:test"
import { chmodSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BUILTIN_TOOLS, compileArgsSchema, createCustomToolRegistry, runTool, SchemaError, type CustomTool } from "../src"
import { alive, makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()

function script({ root, path, body }: { root: string; path: string; body: string }) {
  const file = put({ root, path, content: `#!/bin/sh\n${body}\n` })
  chmodSync(file, 0o755)
  return file
}

function manifest(patch: Record<string, unknown> = {}) {
  return JSON.stringify({ description: "Count words", command: ["./run.sh"], args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, ...patch })
}

function setup(options: { trusted?: boolean } = {}) {
  const project = tmp()
  const user = tmp()
  let trusted = options.trusted ?? false
  const registry = createCustomToolRegistry({ userDir: user, trustedDirs: () => (trusted ? [project] : []) })
  return { project, user, registry, trust: (value: boolean) => void (trusted = value) }
}

const ctx = (cwd: string, signal?: AbortSignal, onOutput?: (chunk: string) => void) => makeContext({ cwd, ...(signal ? { signal } : {}), ...(onOutput ? { onOutput } : {}) })
const find = (tools: CustomTool[], name: string) => tools.find((t) => t.name === `custom__${name}`)!

function nest(levels: number): unknown {
  let schema: unknown = { type: "string" }
  for (let i = 0; i < levels; i++) schema = { type: "object", properties: { a: schema } }
  return schema
}

describe("args schema", () => {
  test("compiles typed properties, bounds, enums, arrays and nested objects, and validates", () => {
    const { zod, json } = compileArgsSchema({
      type: "object",
      properties: {
        path: { type: "string", description: "file", minLength: 1, maxLength: 20 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        ratio: { type: "number" },
        flag: { type: "boolean" },
        mode: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        nested: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
      },
      required: ["path"],
    })
    expect(zod.safeParse({ path: "a" }).success).toBe(true)
    expect(zod.safeParse({ path: "a", limit: 3, ratio: 0.5, flag: true, mode: "b", tags: ["x"], nested: { x: 1 } }).success).toBe(true)
    for (const bad of [{}, { path: "" }, { path: "a", limit: 11 }, { path: "a", limit: 1.5 }, { path: "a", mode: "c" }, { path: "a", tags: ["1", "2", "3"] }, { path: "a", nested: {} }, { path: "a", extra: 1 }, { path: 5 }]) {
      expect(zod.safeParse(bad).success).toBe(false)
    }
    expect(json).toMatchObject({ type: "object", required: ["path"], additionalProperties: false })
    expect((json.properties as Record<string, unknown>).path).toEqual({ type: "string", description: "file", minLength: 1, maxLength: 20 })
  })
  test("a missing schema means no arguments; additionalProperties: true allows extras", () => {
    expect(compileArgsSchema(undefined).zod.safeParse({}).success).toBe(true)
    expect(compileArgsSchema(undefined).zod.safeParse({ a: 1 }).success).toBe(false)
    expect(compileArgsSchema({ type: "object", additionalProperties: true }).zod.safeParse({ a: 1 }).success).toBe(true)
  })
  test("unsupported or malformed schemas are rejected with a path", () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ type: "string" }, /top-level/],
      [{ type: "object", properties: { a: { type: "string", pattern: "x" } } }, /args\.a: unsupported keyword "pattern"/],
      [{ type: "object", properties: { a: { type: "null" } } }, /args\.a: type must be/],
      [{ type: "object", properties: { a: { type: "array" } } }, /args\.a\.items/],
      [{ type: "object", required: ["ghost"] }, /required must list declared/],
      [{ type: "object", properties: { a: { type: "string", enum: [] } } }, /enum/],
      [{ type: "object", properties: { a: { type: "string", minLength: "1" } } }, /minLength must be a number/],
      [nest(6), /deeper than/],
    ]
    for (const [schema, message] of bad) expect(() => compileArgsSchema(schema)).toThrow(message)
    expect(() => compileArgsSchema({ type: "string" })).toThrow(SchemaError)
  })
})

describe("discovery and trust", () => {
  test("user tools are trusted; project tools are listed but load only after the directory is trusted", async () => {
    const { project, user, registry, trust } = setup()
    put({ root: user, path: "tools/from_user.json", content: manifest({ description: "user tool" }) })
    put({ root: project, path: ".mendcode/tools/from_project.json", content: manifest({ description: "project tool" }) })
    const listed = await registry.list(project)
    expect(listed.issues).toEqual([])
    expect(listed.tools.map((t) => [t.name, t.toolName, t.source, t.trusted])).toEqual([["from_user", "custom__from_user", "user", true], ["from_project", "custom__from_project", "project", false]])
    expect((await registry.tools(project)).map((t) => t.name)).toEqual(["custom__from_user"])
    trust(true)
    expect((await registry.tools(project)).map((t) => t.name).sort()).toEqual(["custom__from_project", "custom__from_user"])
    expect((await registry.list(project)).tools.every((t) => t.trusted)).toBe(true)
    trust(false)
    expect((await registry.tools(project)).map((t) => t.name)).toEqual(["custom__from_user"])
  })
  test("trust is per directory: another project's tools stay off", async () => {
    const { project, registry } = setup({ trusted: true })
    const other = tmp()
    put({ root: project, path: ".mendcode/tools/a.json", content: manifest() })
    put({ root: other, path: ".mendcode/tools/b.json", content: manifest() })
    expect((await registry.tools(project)).map((t) => t.name)).toEqual(["custom__a"])
    expect(await registry.tools(other)).toEqual([])
  })
  test("project tools win over user tools with the same name", async () => {
    const { project, user, registry } = setup({ trusted: true })
    put({ root: user, path: "tools/dup.json", content: manifest({ description: "from user" }) })
    put({ root: project, path: ".mendcode/tools/dup.json", content: manifest({ description: "from project" }) })
    const tools = await registry.tools(project)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.description).toBe("[custom:project] from project")
  })
  test("bad manifests and names are reported, the rest still load", async () => {
    const { project, registry } = setup({ trusted: true })
    put({ root: project, path: ".mendcode/tools/ok.json", content: manifest() })
    put({ root: project, path: ".mendcode/tools/not json.json", content: manifest() })
    put({ root: project, path: ".mendcode/tools/broken.json", content: "{ nope" })
    put({ root: project, path: ".mendcode/tools/nocommand.json", content: JSON.stringify({ description: "x" }) })
    put({ root: project, path: ".mendcode/tools/typo.json", content: manifest({ comand: ["x"] }) })
    put({ root: project, path: ".mendcode/tools/badargs.json", content: manifest({ args: { type: "object", properties: { a: { type: "string", pattern: "." } } } }) })
    put({ root: project, path: ".mendcode/tools/huge.json", content: manifest({ description: "x".repeat(70_000) }) })
    put({ root: project, path: ".mendcode/tools/readme.md", content: "not a manifest" })
    const { tools, issues } = await registry.list(project)
    expect(tools.map((t) => t.name)).toEqual(["ok"])
    expect(issues.map((i) => i.file.split("/").pop()).sort()).toEqual(["badargs.json", "broken.json", "huge.json", "nocommand.json", "not json.json", "typo.json"])
    expect(issues.find((i) => i.file.endsWith("badargs.json"))!.message).toContain("unsupported keyword")
    expect(issues.find((i) => i.file.endsWith("broken.json"))!.message).toContain("invalid JSON")
  })
  test("names are namespaced and never collide with built-in tools", async () => {
    const { project, registry } = setup({ trusted: true })
    for (const name of ["read", "shell", "write", "mcp__x__y"]) put({ root: project, path: `.mendcode/tools/${name}.json`, content: manifest() })
    const tools = await registry.tools(project)
    const builtin = new Set(BUILTIN_TOOLS.map((t) => t.name))
    expect(tools.map((t) => t.name).sort()).toEqual(["custom__mcp__x__y", "custom__read", "custom__shell", "custom__write"])
    for (const tool of tools) {
      expect(builtin.has(tool.name)).toBe(false)
      expect(tool.permission).toBe("execute")
    }
  })
  test("discovery is cached by mtime and refreshes when a manifest changes or appears", async () => {
    const { project, registry } = setup({ trusted: true })
    const file = put({ root: project, path: ".mendcode/tools/a.json", content: manifest({ description: "one" }) })
    const first = await registry.tools(project)
    expect(first[0]!.description).toContain("one")
    writeFileSync(file, manifest({ description: "two" }))
    utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1))
    expect((await registry.tools(project))[0]!.description).toContain("two")
    put({ root: project, path: ".mendcode/tools/b.json", content: manifest() })
    expect((await registry.tools(project)).map((t) => t.name)).toEqual(["custom__a", "custom__b"])
  })
  test("an empty or missing tools directory is fine", async () => {
    const { project, registry } = setup({ trusted: true })
    expect(await registry.list(project)).toEqual({ tools: [], issues: [] })
  })
})

describe("running a custom tool", () => {
  async function tool(body: string, patch: Record<string, unknown> = {}, name = "t") {
    const s = setup({ trusted: true })
    script({ root: s.project, path: ".mendcode/tools/run.sh", body })
    put({ root: s.project, path: `.mendcode/tools/${name}.json`, content: manifest(patch) })
    return { ...s, tool: find(await s.registry.tools(s.project), name) }
  }

  test("passes the validated arguments as JSON on stdin and returns the output", async () => {
    const { tool: t, project } = await tool('read line; echo "got $line"')
    expect(t.jsonSchema).toMatchObject({ type: "object", required: ["text"] })
    const result = await runTool(t, { text: "hello world" }, ctx(project))
    expect(result).toMatchObject({ isError: false, output: 'got {"text":"hello world"}\n', meta: { tool: "t", exitCode: 0, timedOut: false, cancelled: false } })
  })
  test("argv mode appends the JSON as the last argument and leaves stdin closed", async () => {
    const { tool: t, project } = await tool('echo "arg=$1"; cat', { input: "argv" })
    const result = await runTool(t, { text: "a b" }, ctx(project))
    expect(result.output).toBe('arg={"text":"a b"}\n')
  })
  test("invalid arguments never reach the process", async () => {
    const { tool: t, project } = await tool('echo ran > ran.txt')
    const result = await runTool(t, { text: 5, extra: true }, ctx(project))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("invalid arguments")
    expect(await Bun.file(join(project, "ran.txt")).exists()).toBe(false)
  })
  test("runs in the project root by default (or the tool directory), with context variables in the env", async () => {
    const { tool: t, project } = await tool('pwd; echo "$MENDCODE_PROJECT_DIR|$MENDCODE_TOOL_NAME|$TERM"; cat >/dev/null')
    const out = (await runTool(t, { text: "x" }, ctx(project))).output.trim().split("\n")
    expect(out[0]!.endsWith(project.split("/").pop()!)).toBe(true)
    expect(out[1]).toBe(`${project}|t|dumb`)
    const inTool = await tool("pwd; cat >/dev/null", { cwd: "tool" })
    expect((await runTool(inTool.tool, { text: "x" }, ctx(inTool.project))).output.trim().endsWith(".mendcode/tools")).toBe(true)
  })
  test("a non-zero exit is an error with the output; stderr is merged", async () => {
    const { tool: t, project } = await tool('cat >/dev/null; echo oops 1>&2; exit 3')
    const result = await runTool(t, { text: "x" }, ctx(project))
    expect(result).toMatchObject({ isError: true, meta: { exitCode: 3 } })
    expect(result.output).toBe("oops\n")
  })
  test("a command that cannot start is an error result, not a throw", async () => {
    const s = setup({ trusted: true })
    put({ root: s.project, path: ".mendcode/tools/gone.json", content: manifest({ command: ["./missing.sh"] }) })
    const result = await runTool(find(await s.registry.tools(s.project), "gone"), { text: "x" }, ctx(s.project))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("cannot run")
  })
  test("long output keeps its head and tail", async () => {
    const { tool: t, project } = await tool("cat >/dev/null; seq 1 10000")
    const result = await runTool(t, { text: "x" }, ctx(project))
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith("1\n2\n")).toBe(true)
    expect(result.output.trimEnd().endsWith("10000")).toBe(true)
    expect(result.output).toMatch(/lines omitted/)
  })
  test("the timeout from the manifest kills the process group", async () => {
    // 1 s leaves the shell time to print the child's pid even on a loaded machine (the full suite runs in parallel).
    const { tool: t, project } = await tool("cat >/dev/null; sleep 30 & echo $!; wait", { timeoutMs: 1_000 })
    const pids: number[] = []
    const started = Date.now()
    const result = await runTool(t, { text: "x" }, ctx(project, undefined, (c) => pids.push(...(c.match(/\d+/g) ?? []).map(Number))))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result).toMatchObject({ isError: true, meta: { timedOut: true } })
    expect(result.output).toContain("timed out after 1000 ms")
    expect(pids).toHaveLength(1)
    // The group gets SIGTERM, then SIGKILL after 2 s; poll instead of guessing how long a busy machine needs.
    for (let i = 0; i < 60 && alive(pids[0]!); i++) await Bun.sleep(50)
    expect(alive(pids[0]!)).toBe(false)
  })
  test("cancelling kills the process group; an already-cancelled call does not start", async () => {
    const { tool: t, project } = await tool("cat >/dev/null; sleep 30 & echo $!; wait")
    const controller = new AbortController()
    const pids: number[] = []
    const pending = runTool(t, { text: "x" }, ctx(project, controller.signal, (c) => pids.push(...(c.match(/\d+/g) ?? []).map(Number))))
    await Bun.sleep(300)
    controller.abort()
    const started = Date.now()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toMatchObject({ isError: true, meta: { cancelled: true } })
    for (let i = 0; i < 60 && alive(pids[0]!); i++) await Bun.sleep(50)
    expect(alive(pids[0]!)).toBe(false)
    const done = new AbortController()
    done.abort()
    expect(await runTool(t, { text: "x" }, ctx(project, done.signal))).toMatchObject({ isError: true, output: "cancelled" })
  })
  test("the manifest timeout is capped and validated", async () => {
    const s = setup({ trusted: true })
    put({ root: s.project, path: ".mendcode/tools/slow.json", content: manifest({ timeoutMs: 601_000 }) })
    expect((await s.registry.list(s.project)).issues[0]!.message).toContain("timeoutMs")
  })
})
