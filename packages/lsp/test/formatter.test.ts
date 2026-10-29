import { afterEach, expect, test } from "bun:test"
import { chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createAfterWrite, createFormatterManager, createLspManager, DEFAULT_FORMATTERS, loadFormatterRegistry, type FormatterManager } from "../src"
import { formatterFixture, FORMATTER_FIXTURE } from "./formatter-fixtures"
import { STACK_FORMATTERS } from "../src/stack-formatters"
import { alive, fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()
const managers: FormatterManager[] = []
const originalOxfmt = process.env.MENDCODE_EXPERIMENTAL_OXFMT
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()))
  if (originalOxfmt === undefined) delete process.env.MENDCODE_EXPERIMENTAL_OXFMT
  else process.env.MENDCODE_EXPERIMENTAL_OXFMT = originalOxfmt
})
const manager = (options: Parameters<typeof createFormatterManager>[0] = {}) => {
  const value = createFormatterManager({ which: () => null, ...options })
  managers.push(value)
  return value
}
const config = (root: string, value: unknown) => put({ root, path: ".mendcode/formatter.json", content: JSON.stringify(typeof value === "object" && value ? { ...Object.fromEntries(STACK_FORMATTERS.map((spec) => [spec.name, { disabled: true }])), ...value } : value) })
const logOf = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))

test("formatters are opt-in, and false disables builtins and custom commands", async () => {
  const cwd = tempDir()
  formatterFixture(cwd)
  const m = manager()
  put({ root: cwd, path: "a.ts", content: "BAD" })
  expect(await m.status({ cwd })).toEqual({ formatters: [], issues: [] })
  expect(await m.file({ cwd, path: "a.ts" })).toMatchObject({ formatted: false, results: [] })
  config(cwd, false)
  expect((await m.status({ cwd })).formatters).toEqual([])
  expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("BAD")
})

test("registry overrides merge builtin env/extensions, remove disabled entries and add custom formatters", async () => {
  const cwd = tempDir()
  config(cwd, { prettier: { extensions: [".fake"], environment: { CUSTOM: "yes" } }, biome: { disabled: true }, custom: { command: ["fmt", "$FILE"], extensions: [".x"], env: { SCOPED: "value" } } })
  const result = await loadFormatterRegistry({ directory: cwd })
  expect(result.issues).toEqual([])
  expect(result.formatters.map((spec) => spec.name)).toEqual(["prettier", "oxfmt", "custom"])
  expect(result.formatters[0]).toMatchObject({ extensions: [".fake"], environment: { BUN_BE_BUN: "1", CUSTOM: "yes" } })
  expect(result.formatters[2]).toMatchObject({ command: ["fmt", "$FILE"], environment: { SCOPED: "value" } })
})

test("malformed configuration and incomplete commands are reported and never fall back to builtin execution", async () => {
  const cwd = tempDir()
  put({ root: cwd, path: ".mendcode/formatter.json", content: "{" })
  expect(await loadFormatterRegistry({ directory: cwd })).toMatchObject({ formatters: [], issues: [{ message: expect.stringContaining("valid JSON") }] })
  config(cwd, { prettier: { command: [] }, biome: { extensions: ["ts"] }, custom: { command: ["fmt"] } })
  const result = await loadFormatterRegistry({ directory: cwd })
  expect(result.issues).toHaveLength(3)
  expect(result.formatters.map((spec) => spec.name)).toEqual(["oxfmt"])
})

test.each(["prettier", "oxfmt", "biome"])("%s uses exact v1 argv, project gates and BUN_BE_BUN", async (name) => {
  process.env.MENDCODE_EXPERIMENTAL_OXFMT = "1"
  const cwd = tempDir()
  formatterFixture(cwd)
  const log = join(cwd, "runs.jsonl")
  config(cwd, Object.fromEntries(DEFAULT_FORMATTERS.map((spec) => [spec.name, spec.name === name ? { environment: { FAKE_FORMATTER_LOG: log } } : { disabled: true }])))
  const file = put({ root: cwd, path: "a file $(ignored).ts", content: "BAD" })
  const m = manager()
  expect((await m.status({ cwd })).formatters).toMatchObject([{ name, enabled: true }])
  expect(await m.file({ cwd, path: file })).toMatchObject({ formatted: true, results: [{ name, ok: true }] })
  const expected = name === "prettier" ? ["--write", file] : name === "biome" ? ["format", "--write", file] : [file]
  expect(logOf(log)).toMatchObject([{ argv: expected, cwd, bun: "1", inherited: true }])
  expect(readFileSync(file, "utf8")).toBe("GOOD")
})

test("dependency/config gates and the experimental Oxfmt flag skip unconfigured presets", async () => {
  delete process.env.MENDCODE_EXPERIMENTAL_OXFMT
  const cwd = tempDir()
  config(cwd, true)
  put({ root: cwd, path: "a.ts", content: "BAD" })
  const m = manager({ which: () => process.execPath })
  expect((await m.status({ cwd })).formatters.slice(0, 3)).toMatchObject([
    { name: "prettier", enabled: false, reason: "no project prettier dependency" },
    { name: "oxfmt", enabled: false, reason: expect.stringContaining("experimental") },
    { name: "biome", enabled: false, reason: expect.stringContaining("no biome.json") },
  ])
  expect((await m.file({ cwd, path: "a.ts" })).results).toEqual([])
})

test("workspace ancestors provide project dependencies, config and executables; nearest executable wins", async () => {
  const root = tempDir()
  put({ root, path: ".git", content: "gitdir: fake" })
  formatterFixture(root)
  const cwd = join(root, "packages", "app")
  formatterFixture(cwd, ["prettier"])
  const nearest = put({ root: cwd, path: "node_modules/.bin/prettier", content: `#!${process.execPath}\nprocess.env.FAKE_FORMATTER_SUFFIX = "nearest"\nawait import(${JSON.stringify(FORMATTER_FIXTURE)})\n` })
  chmodSync(nearest, 0o755)
  const log = join(root, "runs.jsonl")
  config(cwd, { prettier: { environment: { FAKE_FORMATTER_LOG: log } }, oxfmt: { disabled: true }, biome: { disabled: true } })
  const file = put({ root: cwd, path: "app.ts", content: "BAD" })
  expect((await manager().file({ cwd, path: file })).formatted).toBe(true)
  expect(readFileSync(file, "utf8")).toBe("GOODnearest")
  // Remove the local dependency requirement, still resolve the enclosing worktree's config for Biome.
  put({ root: cwd, path: "package.json", content: "{}" })
  config(cwd, true)
  expect((await manager().status({ cwd })).formatters.slice(0, 3)).toMatchObject([{ name: "prettier", enabled: true }, { name: "oxfmt", enabled: false }, { name: "biome", enabled: true }])
})

test("all matching formatters run in registry order, custom command bypasses builtin gates and keeps env scoped", async () => {
  const cwd = tempDir()
  const log = join(cwd, "runs.jsonl")
  const command = [process.execPath, FORMATTER_FIXTURE, "$FILE"]
  config(cwd, { prettier: { command, environment: { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_SUFFIX: "1", FAKE_FORMATTER_SCOPED: "local" } }, oxfmt: { command, env: { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_SUFFIX: "2" } }, biome: { disabled: true }, custom: { command, extensions: [".ts"], environment: { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_SUFFIX: "3" } } })
  const file = put({ root: cwd, path: "a.ts", content: "BAD" })
  const report = await manager().file({ cwd, path: file })
  expect(report.results).toEqual([{ name: "prettier", ok: true }, { name: "oxfmt", ok: true }, { name: "custom", ok: true }])
  expect(readFileSync(file, "utf8")).toBe("GOOD123")
  expect(logOf(log).map((entry) => entry.scoped)).toEqual(["local", undefined, undefined])
  expect(process.env.FAKE_FORMATTER_SCOPED).toBeUndefined()
  expect(JSON.stringify(report)).not.toContain("local")
})

test("custom commands resolve relative to cwd or their scoped PATH without using the parent's PATH", async () => {
  const cwd = tempDir()
  const binary = put({ root: cwd, path: "tools/local-fmt", content: `#!${process.execPath}\nimport ${JSON.stringify(FORMATTER_FIXTURE)}\n` })
  chmodSync(binary, 0o755)
  const path = put({ root: cwd, path: "a.custom", content: "BAD" })
  config(cwd, { prettier: { disabled: true }, biome: { disabled: true }, oxfmt: { disabled: true }, custom: { command: ["local-fmt", "$FILE"], extensions: [".custom"], env: { PATH: join(cwd, "tools") } } })
  const m = manager()
  expect((await m.file({ cwd, path })).formatted).toBe(true)
  config(cwd, { prettier: { disabled: true }, biome: { disabled: true }, oxfmt: { disabled: true }, custom: { command: ["./tools/local-fmt", "$FILE"], extensions: [".custom"] } })
  expect((await m.file({ cwd, path })).formatted).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("GOOD")
})

test("simultaneous requests for a file serialize rather than racing formatter writes", async () => {
  const cwd = tempDir()
  const { command } = formatterFixture(cwd)
  config(cwd, { prettier: { command, environment: { FAKE_FORMATTER_SUFFIX: "x" } }, biome: { disabled: true }, oxfmt: { disabled: true } })
  const path = put({ root: cwd, path: "a.ts", content: "BAD" })
  const m = manager()
  const results = await Promise.all([m.file({ cwd, path }), m.file({ cwd, path })])
  expect(results.map((report) => report.formatted)).toEqual([true, true])
  expect(readFileSync(path, "utf8")).toBe("GOODxx")
})

test("missing binaries and nonzero exits are explicit, do not leak output/env and do not stop the next formatter", async () => {
  const cwd = tempDir()
  const command = [process.execPath, FORMATTER_FIXTURE, "$FILE"]
  config(cwd, { prettier: { command: ["not-a-formatter", "$FILE"] }, oxfmt: { command, env: { FAKE_FORMATTER_MODE: "fail" } }, biome: { command } })
  const file = put({ root: cwd, path: "a.ts", content: "BAD" })
  const report = await manager().file({ cwd, path: file })
  expect(report.results).toMatchObject([{ name: "prettier", ok: false, message: expect.stringContaining("not installed") }, { name: "oxfmt", ok: false, message: "exit 7" }, { name: "biome", ok: true }])
  expect(JSON.stringify(report)).not.toContain("secret")
  expect(readFileSync(file, "utf8")).toBe("GOOD")
})

test("formats only matching extensions and preserves a UTF-8 BOM removed by a formatter", async () => {
  const cwd = tempDir()
  const { command } = formatterFixture(cwd)
  config(cwd, { prettier: { command }, oxfmt: { disabled: true }, biome: { disabled: true } })
  const m = manager()
  const file = put({ root: cwd, path: "a.ts", content: "\uFEFFBAD" })
  await m.file({ cwd, path: file })
  expect(readFileSync(file, "utf8")).toBe("\uFEFFGOOD")
  expect(await m.file({ cwd, path: "a.unknown" })).toMatchObject({ formatted: false, results: [] })
  expect(await m.file({ cwd, path: "missing.ts" })).toMatchObject({ unavailable: "cannot read file" })
})

test("formatting finishes before LSP sync, every written path is formatted, clean writes stay silent", async () => {
  const cwd = tempDir()
  const { command } = formatterFixture(cwd)
  config(cwd, { prettier: { command, extensions: [".fake"] }, oxfmt: { disabled: true }, biome: { disabled: true } })
  const paths = Array.from({ length: 7 }, (_, i) => `${i}.fake`)
  for (const path of paths) put({ root: cwd, path, content: "BAD" })
  const lsp = createLspManager({ registryLoader: () => ({ servers: [fakeSpec()], issues: [] }), which: () => null, settleMs: 20 })
  try {
    const hook = createAfterWrite({ manager: lsp, formatter: manager() })
    expect(await hook({ cwd, paths })).toBeUndefined()
    for (const path of paths) expect(readFileSync(join(cwd, path), "utf8")).toBe("GOOD")
    // The write formatted seven files and started no language server to do it.
    expect(lsp.running()).toEqual([])
    put({ root: cwd, path: "problem.fake", content: "ERROR BAD" })
    await lsp.diagnostics({ path: "problem.fake", cwd })
    expect(await hook({ cwd, paths: ["problem.fake"] })).toContain("Diagnostics:")
    expect(readFileSync(join(cwd, "problem.fake"), "utf8")).toBe("ERROR GOOD")
  } finally { await lsp.stop() }
})

test.each(["timeout", "cancel", "stop"])("%s terminates the formatter process group without running the next command", async (action) => {
  const cwd = tempDir()
  const log = join(cwd, "runs.jsonl"), child = join(cwd, "child.pid")
  const command = [process.execPath, FORMATTER_FIXTURE, "$FILE"]
  config(cwd, { prettier: { command, env: { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_CHILD: child, FAKE_FORMATTER_MODE: "hang" } }, oxfmt: { command, env: { FAKE_FORMATTER_LOG: log } }, biome: { disabled: true } })
  put({ root: cwd, path: "a.ts", content: "BAD" })
  const m = manager(), abort = new AbortController()
  const pending = m.file({ cwd, path: "a.ts", signal: abort.signal, timeoutMs: action === "timeout" ? 300 : 2000 })
  await until({ check: () => Bun.file(child).size > 0 })
  if (action === "cancel") abort.abort()
  if (action === "stop") await m.stop()
  const result = await pending
  expect(result.results).toMatchObject([{ name: "prettier", ok: false, message: action === "timeout" ? "timed out" : "cancelled" }])
  expect(logOf(log)).toHaveLength(1)
  await until({ check: () => !alive(Number(readFileSync(child, "utf8"))) })
  expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("BAD")
})

test("an already cancelled write hook never spawns or asks for diagnostics", async () => {
  const cwd = tempDir(), abort = new AbortController()
  abort.abort()
  config(cwd, true)
  expect(await manager().file({ cwd, path: "a.ts", signal: abort.signal })).toMatchObject({ unavailable: "cancelled", results: [] })
  let called = false
  const lsp = createLspManager({ registryLoader: () => { called = true; return { servers: [], issues: [] } } })
  try { expect(await createAfterWrite({ manager: lsp, formatter: manager() })({ cwd, paths: ["a.ts"], signal: abort.signal })).toBeUndefined() }
  finally { await lsp.stop() }
  expect(called).toBe(false)
})
