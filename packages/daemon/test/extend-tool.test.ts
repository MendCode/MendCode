import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import { createExtensions } from "../src/extensions"
import { createExtendTool, EXTEND_DESCRIPTION, extensionToolCheck } from "../src/extend-tool"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `extend-${label}-`)))
  dirs.push(dir)
  return dir
}

function setup() {
  const data = tmp("data")
  const project = tmp("project")
  const ext = createExtensions({ dataDir: data, layersFor: (directory) => extensionLayers({ userDir: data, directory }), isTrusted: () => true, notify: () => {}, hookTimeoutMs: 2_000 })
  const reload = async (directory: string) => {
    ext.invalidateAll()
    return { revision: 1, errors: (await ext.list(directory)).flatMap((entry) => entry.errors.map((error) => `${entry.name}: ${error}`)), terminalValidation: "complete" as const }
  }
  const tool = createExtendTool({ dir: data, extensions: { reload, report: (directory) => ext.report(directory), routeInput: (ref, text) => ext.routeInput(ref, text), checkTool: extensionToolCheck(ext) } })
  const run = async (args: Record<string, unknown>) => {
    const parsed = tool.args.parse(args)
    const result = await tool.execute(parsed, { cwd: project, signal: new AbortController().signal })
    return { ...result, json: result.isError && !result.output.startsWith("{") ? undefined : JSON.parse(result.output) as Record<string, unknown> }
  }
  return { data, project, ext, tool, run }
}

const HOLA = `export default { name: "hola", daemon(api) { api.registerCommand({ name: "hola", description: "the branch", run: async (_args, ctx) => { const r = await api.exec("git", ["--version"], { cwd: ctx.cwd }); return { notice: "hola " + r.stdout.trim() } } }) } }\n`

describe("mendcode_extend writes an extension, loads it and shows what it registered", () => {
  test("write reports the command it registered, and command runs it the way a typed /hola would", async () => {
    const { data, run } = setup()
    const written = await run({ action: "write", file: "hola.ts", content: HOLA })
    expect(written.isError).toBe(false)
    expect(written.json).toMatchObject({ file: path.join(data, "extensions/hola.ts"), extension: { name: "hola", commands: ["/hola"] }, errors: [] })
    const ran = await run({ action: "command", text: "/hola" })
    expect(ran.isError).toBe(false)
    expect(String(ran.json?.notice)).toMatch(/^hola git version \d/)
    const missing = await run({ action: "command", text: "/nope" })
    expect(missing.isError).toBe(true)
    expect(missing.output).toContain("not an extension command")
  })

  test("a module that fails to load is an error result naming the problem; edit fixes it", async () => {
    const { run } = setup()
    const broken = await run({ action: "write", file: "guard.ts", content: `export default { name: "guard", daemon(api) { api.on("tool.before", (e) => ({ block: "no" })); api.on("not.a.hook", () => {}) } }\n` })
    expect(broken.isError).toBe(true)
    expect(JSON.stringify(broken.json?.errors)).toContain('unknown hook \\"not.a.hook\\"')
    const fixed = await run({ action: "edit", file: "guard.ts", old: `; api.on("not.a.hook", () => {})`, new: "" })
    expect(fixed.isError).toBe(false)
    expect(fixed.json).toMatchObject({ extension: { name: "guard", hooks: ["tool.before"] }, errors: [] })
  })

  test("list is read-only and shows every extension; writing needs write, a command needs execute", async () => {
    const { run, tool } = setup()
    await run({ action: "write", file: "hola.ts", content: HOLA })
    const listed = await run({ action: "list" })
    expect(listed.json).toMatchObject({ extensions: [{ name: "hola", source: "user", commands: ["/hola"] }] })
    expect(tool.permissionFor?.({ action: "list" })).toBe("read")
    expect(tool.permissionFor?.({ action: "write", file: "a.ts", content: "" })).toBe("write")
    expect(tool.permissionFor?.({ action: "command", text: "/hola" })).toBe("execute")
  })

  test("check runs the tool.before rules on a call that never executes, so a guard's gaps show before the user relies on it", async () => {
    const { run, tool } = setup()
    // gpt-6-luna's guard: it tests JSON.stringify(args) but wants a slash or the start before "private", and skips shell.
    await run({ action: "write", file: "guard.ts", content: `export default { name: "guard", daemon(api) { api.on("tool.before", (e) => { if (!["read", "grep"].includes(e.tool)) return; if (/(?:^|[\\\\/])private(?:[\\\\/]|$)/.test(JSON.stringify(e.args))) return { block: "private/ is off limits" } }) } }\n` })
    expect((await run({ action: "check", tool: "read", args: { path: "/repo/private/keys.txt" } })).json).toEqual({ blocked: "private/ is off limits" })
    expect((await run({ action: "check", tool: "read", args: { path: "private/keys.txt" } })).json).toEqual({ allowed: true })
    expect((await run({ action: "check", tool: "shell", args: { command: "cat private/keys.txt" } })).json).toEqual({ allowed: true })
    expect(tool.permissionFor?.({ action: "check", tool: "read", args: {} })).toBe("execute")
  })

  test("a rule written for reads also stops shell commands, grep and multi-file reads that reach the path", async () => {
    const { run, project } = setup()
    mkdirSync(path.join(project, "private"))
    writeFileSync(path.join(project, "private/keys.txt"), "k\n")
    await run({ action: "write", file: "guard.ts", content: `export default { name: "guard", daemon(api) { api.on("tool.before", (e) => e.tool === "read" && String(e.args.path).replace(/^\\.\\//, "").startsWith("private") ? { block: "private/ is off limits" } : undefined) } }\n` })
    for (const command of ["cat private/keys.txt", "cd private && cat keys.txt", "head -n 1 < private/keys.txt", "grep -r x ./private", "echo $(cat 'private/keys.txt')", "base64 --input=private/keys.txt"]) {
      expect({ command, verdict: (await run({ action: "check", tool: "shell", args: { command } })).json }).toEqual({ command, verdict: { blocked: "private/ is off limits" } })
    }
    expect((await run({ action: "check", tool: "grep", args: { pattern: "k", path: "private" } })).json).toEqual({ blocked: "private/ is off limits" })
    expect((await run({ action: "check", tool: "read", args: { paths: [{ path: "README.md" }, { path: "private/keys.txt" }] } })).json).toEqual({ blocked: "private/ is off limits" })
    expect((await run({ action: "check", tool: "shell", args: { command: "cat README.md | wc -l" } })).json).toEqual({ allowed: true })
    expect((await run({ action: "check", tool: "shell", args: { command: "curl https://example.test/private/x" } })).json).toEqual({ allowed: true })
  })

  test("write with checks tries each call on the loaded rules and is an error result while one gets the wrong answer", async () => {
    const { run } = setup()
    const leaky = `export default { name: "guard", daemon(api) { api.on("tool.before", (e) => /(^|[\\\\/])private\\//.test(String(e.args.path ?? "")) && e.tool === "grep" ? { block: "no" } : undefined) } }\n`
    const checks = [{ tool: "read", args: { path: "private/keys.txt" }, expect: "block" }, { tool: "shell", args: { command: "cat private/keys.txt" }, expect: "block" }, { tool: "read", args: { path: "README.md" }, expect: "allow" }]
    const first = await run({ action: "write", file: "guard.ts", content: leaky, checks })
    expect(first.isError).toBe(true)
    expect(first.json?.checks).toMatchObject([{ tool: "read", expect: "block", got: "allow", ok: false }, { tool: "shell", got: "allow", ok: false }, { tool: "read", expect: "allow", ok: true }])
    expect(String(first.json?.failedChecks)).toContain("2 of 3")
    const fixed = await run({ action: "edit", file: "guard.ts", old: ` && e.tool === "grep"`, new: "", checks })
    expect(fixed.isError).toBe(false)
    expect((fixed.json?.checks as Array<{ ok: boolean }>).every((entry) => entry.ok)).toBe(true)
    const untested = await run({ action: "write", file: "guard2.ts", content: leaky.replace(`name: "guard"`, `name: "guard2"`) })
    expect(String(untested.json?.note)).toContain("untested")
  })

  test("prompt.system takes a string or { system } like the other hooks' results (gpt-6-luna wrote { system } 2 of 2 times)", async () => {
    const { project, ext, run } = setup()
    await run({ action: "write", file: "es.ts", content: `export default { name: "es", daemon(api) { api.on("prompt.system", (e) => ({ system: e.system + " ES" })) } }\n` })
    await run({ action: "write", file: "date.ts", content: `export default { name: "date", daemon(api) { api.on("prompt.system", (e) => e.system + " DATE") } }\n` })
    const records = (await ext.ensure(project)).records
    const system = await ext.bus.promptSystem(records, { sessionId: "s", cwd: project, role: "main", system: "base" } as never)
    expect(system?.startsWith("base")).toBe(true)
    expect(system).toContain(" ES")
    expect(system).toContain(" DATE")
  })

  test("paths and project destinations are refused; the description teaches the daemon contract", async () => {
    const { run } = setup()
    const escaped = await run({ action: "write", file: "../x.ts", content: "export default { name: 'x' }" })
    expect(escaped.isError).toBe(true)
    for (const piece of ["registerCommand", "registerTool", "tool.before", "prompt.system", "registerProvider", "api.exec", "never answer such a request with a promise", "APPEND_SYSTEM.md", "keybindings.json"]) expect(EXTEND_DESCRIPTION).toContain(piece)
  })
})
