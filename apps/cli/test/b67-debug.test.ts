import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { parseAutomation, runAutomation, helpText, type Automation, type AutomationDeps } from "../src/automation"
import { databaseText } from "../src/debug-automation"
import { completionScript } from "../src/support-output"
import { b67Harness } from "../../../packages/daemon/test/b67-harness"
import type { CommandInput } from "@mendcode/client"
import { cleanTemps, tempDir } from "./session-ui-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { cleanTemps(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function parse(...args: string[]): Automation {
  const parsed = parseAutomation(args)
  if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
  return parsed.command
}
function io(reply: Record<string, unknown> = {}) {
  const sent: CommandInput[] = [], out: string[] = [], err: string[] = []
  let interrupt: (() => void) | undefined
  let timeout: (() => void) | undefined
  const deps = { cwd: "/work/project", client: { send: async (command: CommandInput) => { sent.push(command); return { ok: true, result: reply } } }, out: { write: (text: string) => out.push(text) }, err: { write: (text: string) => err.push(text) }, now: () => 1000, listen: () => {}, onInterrupt: (callback: () => void) => { interrupt = callback }, setTimer: (_: number, callback: () => void) => { timeout = callback; return { cancel: () => {} } } } as unknown as AutomationDeps
  return { sent, out, err, deps, interrupt: () => interrupt?.(), timeout: () => timeout?.() }
}

test("B67 parses every donor command and keeps existing rg delegation", () => {
  for (const [args, operation] of [
    [["config"], "config"], [["info"], "info"], [["paths"], "paths"], [["scrap"], "projects"], [["skill"], "skills"], [["startup"], "startup"],
    [["agent", "build"], "agent"], [["file", "search", "app"], "file.search"], [["file", "read", "src/app.ts"], "file.read"], [["file", "status"], "file.status"], [["file", "list", "."], "file.list"], [["file", "tree"], "file.tree"],
    [["lsp", "diagnostics", "app.ts"], "lsp.diagnostics"], [["lsp", "symbols", "execute"], "lsp.symbols"], [["lsp", "document-symbols", "file:///work/project/app.ts"], "lsp.document-symbols"],
    [["snapshot", "track"], "snapshot.track"], [["snapshot", "patch", "a".repeat(40)], "snapshot.patch"], [["snapshot", "diff", "a".repeat(40)], "snapshot.diff"],
  ] as const) expect(parse("--dir", "/tmp/data", "debug", ...args)).toMatchObject({ kind: "debug", dir: "/tmp/data", input: { operation } })
  expect(parse("debug", "agent", "build", "--tool", "read", "--params", '{"path":"README.md"}', "--approve")).toMatchObject({ input: { tool: "read", params: { path: "README.md" }, approve: true } })
  expect(parse("debug", "rg", "files", "--query", "app")).toMatchObject({ kind: "files", operation: "files", query: "app" })
  expect(parse("debug", "wait")).toMatchObject({ kind: "debug.wait" })
  expect(parse("db")).toMatchObject({ kind: "db", operation: "shell", format: "tsv" })
  expect(parse("db", "SELECT 1", "--format", "json")).toMatchObject({ kind: "db", operation: "query", format: "json" })
  expect(parse("--data-dir", "/tmp/data", "db", "path")).toMatchObject({ kind: "db", operation: "path", dir: "/tmp/data" })
  expect(helpText("debug")).toContain("snapshot track")
  expect(helpText("db")).toContain("json|tsv")
  expect(completionScript("zsh")).toContain("document-symbols")
  for (const args of [["debug"], ["debug", "agent", "build", "--approve=false"], ["debug", "config", "extra"], ["debug", "snapshot", "patch", "--evil"], ["debug", "agent", "build", "--params", "[]", "--tool", "read"], ["debug", "lsp", "symbols"], ["debug", "wait", "--timeout-ms", "0"], ["db", "path", "extra"], ["db", "--format", "table"]]) expect(parseAutomation(args).ok).toBe(false)
})

test("B67 debug uses protocol RPC and preserves donor text/JSON outputs", async () => {
  const h = io({ operation: "file.search", data: ["src/app.ts", "src/"] })
  expect(await runAutomation(parse("debug", "file", "search", "app"), h.deps)).toBe(0)
  expect(h.sent).toEqual([{ type: "debug.query", directory: "/work/project", input: { operation: "file.search", query: "app" } }])
  expect(h.out.join("")).toBe("src/app.ts\nsrc/\n")
  const json = io({ operation: "config", data: { settings: {} } })
  expect(await runAutomation(parse("debug", "config", "--json"), json.deps)).toBe(0)
  expect(JSON.parse(json.out[0]!).data).toEqual({ operation: "config", data: { settings: {} } })
  const failed = io({ operation: "agent", data: { result: { isError: true } } })
  expect(await runAutomation(parse("debug", "agent", "build"), failed.deps)).toBe(1)
})

test("B67 database CLI emits literal TSV or JSON rows rather than an automation envelope", async () => {
  const report = { path: "/tmp/data/mendd.db", columns: ["value", "note"], rows: [{ value: 42, note: "a\tb\nc" }], truncated: false }
  const h = io(report)
  expect(await runAutomation(parse("db", "SELECT 42", "--format", "tsv"), h.deps)).toBe(0)
  expect(h.sent).toEqual([{ type: "db.query", operation: "query", sql: "SELECT 42" }])
  expect(h.out.join("")).toBe("value\tnote\n42\ta b c\n")
  const json = io(report)
  expect(await runAutomation(parse("db", "SELECT 42", "--format", "json"), json.deps)).toBe(0)
  expect(JSON.parse(json.out.join(""))).toEqual(report.rows)
  const location = io(report)
  expect(await runAutomation(parse("db", "path"), location.deps)).toBe(0)
  expect(location.out.join("")).toBe("/tmp/data/mendd.db\n")
  expect(databaseText({ ...report, rows: [] }, "tsv")).toBe("")
})

test("B67 explicit debug wait is cancellable, optionally bounded, and never issues an RPC", async () => {
  for (const args of [["debug", "wait"], ["debug", "wait", "--timeout-ms", "10"]]) {
    const h = io()
    const waiting = runAutomation(parse(...args), h.deps)
    await Bun.sleep(0)
    args.length > 2 ? h.timeout() : h.interrupt()
    expect(await waiting).toBe(0)
    expect(h.sent).toHaveLength(0)
  }
})

test("B67 SQL shell handles multiline input, schema commands, errors and subsequent queries", async () => {
  const h = await b67Harness()
  cleanups.push(h.cleanup)
  const output = io()
  const deps = { ...output.deps, client: h.client, cwd: h.project, sqlLines: async function* () { yield ".tables"; yield "SELECT"; yield "42 AS value;"; yield "DELETE FROM sessions;"; yield "SELECT 43 AS value;"; yield ".schema sessions"; yield ".quit"; yield "SELECT 99;" } }
  expect(await runAutomation(parse("db"), deps)).toBe(1)
  expect(output.out.join("")).toContain("sessions")
  expect(output.out.join("")).toContain("value\n42\n")
  expect(output.out.join("")).toContain("value\n43\n")
  expect(output.out.join("")).not.toContain("99")
  expect(output.err.join("")).toContain("read-only")
})

test("B67 real CLI routes db and debug through the supplied temp socket without loading protocol schemas", async () => {
  const h = await b67Harness()
  cleanups.push(h.cleanup)
  for (const [args, expected] of [[["db", "path"], path.join(h.dir, "mendd.db")], [["db", "SELECT 7 AS value", "--format", "json"], '"value": 7'], [["debug", "file", "read", "README.md"], "Project notes"]] as const) {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", h.dir, "--socket", path.join(h.dir, "mendd.sock"), ...args], { cwd: h.project, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(err).toBe("")
    expect(code).toBe(0)
    expect(out).toContain(expected)
  }
  // Observe the entry's startup imports in the help path without connecting to a daemon.
  const temp = tempDir()
  const script = `process.argv=[process.execPath,"entry","--dir",${JSON.stringify(temp)},"db","--help"];const stop=new Error("stop");process.exit=()=>{throw stop};process.stdout.write=()=>true;try{await import(${JSON.stringify(path.join(import.meta.dir, "../src/entry.ts"))})}catch(e){if(e!==stop)throw e}console.error(JSON.stringify(Object.keys(require.cache).filter(k=>k.includes("/zod/")||/protocol\\/src\\/(commands|debug|frames)\\.ts$/.test(k))))`
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(child.stderr).text()).toBe("[]\n")
  expect(await child.exited).toBe(0)
}, 15000)

