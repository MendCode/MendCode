import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createFormatterManager, loadFormatterRegistry, type FormatterManager } from "../src"
import { STACK_FORMATTERS } from "../src/stack-formatters"
import { FORMATTER_FIXTURE, formatterFixture } from "./formatter-fixtures"
import { stackFormatterConfig, stackFormatterFixture } from "./stack-formatter-fixtures"
import { put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()
const managers: FormatterManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.stop())) })
function manager() {
  const value = createFormatterManager({ which: () => null })
  managers.push(value)
  return value
}
const config = (root: string, value: unknown) => put({ root, path: ".mendcode/formatter.json", content: JSON.stringify(value) })
const logs = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))

const cases: Array<[string, string, string[], string[]]> = [
  ["FMT-001", "gofmt", ["-w"], [".go"]],
  ["FMT-002", "mix", ["format"], [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"]],
  ["FMT-006", "zig", ["fmt"], [".zig", ".zon"]],
  ["FMT-007", "clang-format", ["-i"], [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"]],
  ["FMT-008", "ktlint", ["-F"], [".kt", ".kts"]],
  ["FMT-009", "ruff", ["format"], [".py", ".pyi"]],
  ["FMT-010", "air", ["format"], [".R"]],
  ["FMT-011", "uv", ["format", "--"], [".py", ".pyi"]],
  ["FMT-012", "rubocop", ["--autocorrect"], [".rb", ".rake", ".gemspec", ".ru"]],
  ["FMT-013", "standardrb", ["--fix"], [".rb", ".rake", ".gemspec", ".ru"]],
  ["FMT-014", "htmlbeautifier", [], [".erb", ".html.erb"]],
  ["FMT-015", "dart", ["format"], [".dart"]],
  ["FMT-016", "ocamlformat", ["-i"], [".ml", ".mli"]],
  ["FMT-017", "terraform", ["fmt"], [".tf", ".tfvars"]],
  ["FMT-018", "latexindent", ["-w", "-s"], [".tex"]],
  ["FMT-019", "gleam", ["format"], [".gleam"]],
  ["FMT-020", "shfmt", ["-w"], [".sh", ".bash"]],
  ["FMT-021", "nixfmt", [], [".nix"]],
  ["FMT-022", "rustfmt", [], [".rs"]],
  ["FMT-023", "pint", [], [".php"]],
  ["FMT-024", "ormolu", ["-i"], [".hs"]],
  ["FMT-025", "cljfmt", ["fix", "--quiet"], [".clj", ".cljs", ".cljc", ".edn"]],
  ["FMT-026", "dfmt", ["-i"], [".d"]],
]

test.each(cases)("%s %s: v1 extensions, argv and a real local write", async (_id, name, args, extensions) => {
  const cwd = tempDir(), log = join(cwd, "runs.jsonl")
  const { spec } = stackFormatterFixture(cwd, name, { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_SCOPED: "local" })
  expect(spec.extensions).toEqual(extensions)
  const file = put({ root: cwd, path: `a file $(ignored)${extensions[0]}`, content: "BAD" })
  const m = manager()
  expect((await m.status({ cwd })).formatters.find((item) => item.name === name)).toMatchObject({ name, enabled: true, extensions })
  expect(await m.file({ cwd, path: file })).toMatchObject({ formatted: true, results: [{ name, ok: true }], issues: [] })
  expect(logs(log).at(-1)).toMatchObject({ argv: [...args, file], cwd, scoped: "local" })
  expect(process.env.FAKE_FORMATTER_SCOPED).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe("GOOD")
})

test("every advertised extension dispatches, including uppercase C/H/R and compound ERB", async () => {
  expect(STACK_FORMATTERS.map((spec) => spec.name)).toEqual(cases.map((item) => item[1]))
  const cwd = tempDir()
  for (const spec of STACK_FORMATTERS) {
    const direct = { ...spec, command: [process.execPath, "$FILE"] }
    delete direct.project
    delete direct.probe
    const m = createFormatterManager({ registryLoader: () => ({ formatters: [direct], issues: [] }), run: async () => ({ output: "", truncated: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 0 }) })
    managers.push(m)
    for (const extension of spec.extensions) {
      const path = put({ root: cwd, path: `source${extension}`, content: "unchanged" })
      expect((await m.file({ cwd, path })).results).toEqual([{ name: spec.name, ok: true }])
    }
  }
})

test.each(["clang-format", "ocamlformat", "ruff", "pint"])("%s stays disabled without its project gate, even with an installed executable", async (name) => {
  const cwd = tempDir()
  config(cwd, stackFormatterConfig(name))
  const m = createFormatterManager({ which: () => process.execPath })
  managers.push(m)
  expect((await m.status({ cwd })).formatters.find((item) => item.name === name)).toMatchObject({ enabled: false, reason: expect.stringContaining("configuration or dependency") })
  const file = put({ root: cwd, path: `source${STACK_FORMATTERS.find((spec) => spec.name === name)!.extensions[0]}`, content: "BAD" })
  expect((await m.file({ cwd, path: file })).results).toEqual([])
  expect(readFileSync(file, "utf8")).toBe("BAD")
})

test.each([
  ["ruff.toml", ""], [".ruff.toml", ""], ["pyproject.toml", "[tool.ruff]\nline-length = 88"],
  ["pyproject.toml", 'dependencies = ["ruff"]'], ["requirements.txt", "ruff==test"], ["Pipfile", "ruff = '*'"],
])("Ruff detects %s through the enclosing worktree", async (file, content) => {
  const root = tempDir(), cwd = join(root, "packages", "app")
  put({ root, path: ".git", content: "gitdir: fake" })
  put({ root, path: file!, content: content! })
  formatterFixture(root, ["ruff"])
  config(cwd, stackFormatterConfig("ruff"))
  expect((await manager().status({ cwd })).formatters.find((item) => item.name === "ruff")).toMatchObject({ enabled: true })
})

test.each(["clang-format", "ocamlformat", "pint"])("%s sees enclosing project configuration but never another worktree", async (name) => {
  const root = tempDir(), cwd = join(root, "nested")
  const marker = name === "clang-format" ? ".clang-format" : name === "ocamlformat" ? ".ocamlformat" : "composer.json"
  put({ root, path: marker, content: name === "pint" ? '{"require":{"laravel/pint":"test"}}' : "" })
  put({ root, path: ".git", content: "gitdir: fake" })
  config(cwd, stackFormatterConfig(name))
  const m = createFormatterManager({ which: () => process.execPath })
  managers.push(m)
  const first = (await m.status({ cwd })).formatters.find((item) => item.name === name)!
  expect(first.reason ?? "").not.toContain("configuration or dependency")
  if (name !== "pint") expect(first.enabled).toBe(true)
  put({ root: cwd, path: ".git", content: "gitdir: nested worktree" })
  expect((await m.status({ cwd })).formatters.find((item) => item.name === name)).toMatchObject({ enabled: false, reason: expect.stringContaining("configuration or dependency") })
})

test("Ruff wins over uv; uv formats Python when Ruff lacks its project gate or executable", async () => {
  const cwd = tempDir(), log = join(cwd, "runs.jsonl")
  formatterFixture(cwd, ["ruff", "uv"])
  config(cwd, stackFormatterConfig("uv", { environment: { FAKE_FORMATTER_LOG: log } }))
  const path = put({ root: cwd, path: "module.pyi", content: "BAD" })
  const m = manager()
  expect((await m.file({ cwd, path })).results).toEqual([{ name: "uv", ok: true }])
  expect(logs(log).map((entry) => entry.argv)).toEqual([["format", "--help"], ["format", "--", path]])
  put({ root: cwd, path: "requirements.txt", content: "ruff" })
  const report = await m.status({ cwd })
  expect(report.formatters).toMatchObject([{ name: "ruff", enabled: true }, { name: "uv", enabled: false, reason: expect.stringContaining("precedence") }])
  expect((await m.file({ cwd, path })).results).toEqual([{ name: "ruff", ok: true }])
  const missingRuff = tempDir()
  stackFormatterFixture(missingRuff, "uv")
  put({ root: missingRuff, path: "requirements.txt", content: "ruff" })
  expect((await m.status({ cwd: missingRuff })).formatters.find((item) => item.name === "uv")).toMatchObject({ enabled: true })
})

test.each(["ruff", "uv"])("disabling %s disables both Python backends, independent of override order", async (name) => {
  const cwd = tempDir()
  for (const order of [["ruff", "uv"], ["uv", "ruff"]]) {
    config(cwd, Object.fromEntries(order.map((item) => [item, item === name ? { disabled: true } : {}])))
    const result = await loadFormatterRegistry({ directory: cwd })
    expect(result.formatters.some((item) => ["ruff", "uv"].includes(item.name))).toBe(false)
  }
})

test.each(["air", "uv"])("%s rejects unrelated/unsupported help without leaking its output", async (name) => {
  const cwd = tempDir()
  stackFormatterFixture(cwd, name, name === "air" ? { FAKE_FORMATTER_HELP: "Air: live reload secret" } : { FAKE_FORMATTER_MODE: "fail" })
  const m = manager()
  const report = await m.status({ cwd })
  expect(report.formatters.find((item) => item.name === name)?.enabled).toBe(false)
  expect(JSON.stringify(report)).not.toContain("secret")
  const path = put({ root: cwd, path: name === "air" ? "analysis.R" : "analysis.py", content: "BAD" })
  expect((await m.file({ cwd, path })).results).toEqual([])
  expect(readFileSync(path, "utf8")).toBe("BAD")
})

test.each(["clang-format", "ocamlformat", "ruff", "air", "uv", "pint"])("%s explicit command bypasses builtin detection while preserving extensions", async (name) => {
  const cwd = tempDir(), log = join(cwd, "runs.jsonl")
  config(cwd, stackFormatterConfig(name, { command: [process.execPath, FORMATTER_FIXTURE, "$FILE"], environment: { FAKE_FORMATTER_LOG: log } }))
  const path = put({ root: cwd, path: `source${STACK_FORMATTERS.find((spec) => spec.name === name)!.extensions[0]}`, content: "BAD" })
  expect((await manager().file({ cwd, path })).results.find((item) => item.name === name)).toEqual({ name, ok: true })
  expect(logs(log)).toHaveLength(1)
  expect(logs(log)[0].argv).toEqual([path])
})

test.each(["timeout", "cancel", "stop"])("%s bounds help probes and prevents formatting after cancellation", async (action) => {
  const cwd = tempDir(), log = join(cwd, "runs.jsonl")
  stackFormatterFixture(cwd, "air", { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_MODE: "hang" })
  const path = put({ root: cwd, path: "source.R", content: "BAD" })
  const m = manager(), abort = new AbortController()
  const pending = m.file({ cwd, path, signal: abort.signal, timeoutMs: action === "timeout" ? 1500 : 4000 }) // long enough for the fake formatter to start on a loaded machine
  await until({ check: () => Bun.file(log).size > 0 })
  if (action === "cancel") abort.abort()
  if (action === "stop") await m.stop()
  const report = await pending
  expect(report.results).toEqual([{ name: "air", ok: false, message: action === "timeout" ? "timed out" : "cancelled" }])
  if (action !== "timeout") expect(report.unavailable).toBe("cancelled")
  expect(logs(log).map((entry) => entry.argv)).toEqual([["--help"]])
  expect(readFileSync(path, "utf8")).toBe("BAD")
})

test("stop waits for and cancels an in-flight status probe", async () => {
  const cwd = tempDir(), log = join(cwd, "runs.jsonl")
  stackFormatterFixture(cwd, "air", { FAKE_FORMATTER_LOG: log, FAKE_FORMATTER_MODE: "hang" })
  const m = manager(), pending = m.status({ cwd })
  await until({ check: () => Bun.file(log).size > 0 })
  await m.stop()
  expect((await pending).formatters).toMatchObject([{ name: "air", enabled: false, reason: "cancelled" }])
})
