import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { helpText, parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"
import { cliLogger, parseGlobalOptions } from "../src/global-options"
import { completionScript, contextLimitsLines, contextText } from "../src/support-output"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import { memoryGuardrail } from "../src/view/diagnostics-page"
import { missingTool, toolGate } from "../../../scripts/test-budget"

/** The absolute path of the running Bun, so a child can start with a PATH that holds nothing. */
const bunExecutable = process.execPath

afterEach(cleanTemps)
function parsed(...args: string[]): Automation {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}
function io(reply: Record<string, unknown> = {}) {
  const sent: unknown[] = [], out: string[] = [], err: string[] = []
  const deps = { client: { send: async (command: unknown) => { sent.push(command); return { ok: true, result: reply } } }, cwd: "/work/project", out: { write: (text: string) => out.push(text) }, err: { write: (text: string) => err.push(text) }, now: () => 1000, listen: () => {}, onInterrupt: () => {} } as unknown as AutomationDeps
  return { sent, out, err, deps }
}

test("global aliases, levels and completions never require a daemon", async () => {
  for (const args of [["-h"], ["help"], ["--help"]]) expect(parsed(...args).kind).toBe("help")
  for (const args of [["-v"], ["--version"], ["--dir", "/tmp/data", "--version"]]) {
    const h = io()
    expect(await runAutomation(parsed(...args), h.deps)).toBe(0)
    expect(h.sent).toHaveLength(0)
    expect(h.out.join("")).toMatch(/^\d+\.\d+\.\d+/)
  }
  expect(parseGlobalOptions(["--print-logs", "--log-level=ERROR", "run", "--", "--log-level"])).toEqual({ args: ["run", "--", "--log-level"], printLogs: true, logLevel: "ERROR" })
  for (const args of [["--log-level"], ["--log-level", "verbose"], ["--log-level=warn"]]) expect(() => parseGlobalOptions(args)).toThrow("DEBUG|INFO|WARN|ERROR")
  const log: string[] = []
  const write = cliLogger({ printLogs: true, logLevel: "WARN" }, { write: (text) => log.push(text) })
  write("INFO", "connected"); write("ERROR", "connection failed")
  expect(log).toEqual(["ERROR [CLI] connection failed\n"])
  for (const shell of ["bash", "zsh"] as const) {
    const h = io()
    expect(await runAutomation(parsed("completion", shell), h.deps)).toBe(0)
    expect(h.sent).toHaveLength(0)
    expect(h.out.join("")).toContain("config-paths")
  }
  expect(Bun.spawnSync(["bash", "-n", "-c", completionScript("bash")], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0)
})

// Only this syntax check needs an installed zsh; printing the script never does (next test).
const zsh = toolGate("zsh")
zsh.test(`the zsh completion script parses with zsh -n${zsh.suffix}`, () => {
  const checked = Bun.spawnSync(["zsh", "-n", "-c", completionScript("zsh")], { stdout: "pipe", stderr: "pipe" })
  expect(checked.exitCode).toBe(0)
})

test("the CLI prints help, version and every completion with nothing on PATH (no zsh, bash, rg or git)", () => {
  const empty = tempDir()
  const env = { PATH: empty, HOME: empty, MENDCODE_V2_DIR: empty }
  for (const tool of ["zsh", "rg"]) expect(missingTool(tool, empty)).toBeDefined()
  for (const args of [["-h"], ["-v"], ["completion", "bash"], ["completion", "zsh"], ["completion", "fish"], ["completion", "powershell"]]) {
    const dir = path.join(empty, "uncreated")
    const process = Bun.spawnSync([bunExecutable, path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, ...args], { stdout: "pipe", stderr: "pipe", env })
    expect(process.exitCode, `${args.join(" ")}: ${process.stderr.toString()}`).toBe(0)
    expect(process.stdout.toString().length).toBeGreaterThan(0)
  }
})

test("real CLI help/version/completion exits without creating data", () => {
  for (const args of [["-h"], ["-v"], ["completion", "zsh"]]) {
    const dir = path.join(tempDir(), "uncreated")
    const process = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(process.exitCode).toBe(0)
    expect(process.stderr.toString()).toBe("")
    expect(Bun.file(path.join(dir, "mendd.db")).size).toBe(0)
  }
})

test("context validates bounds and preserves recent report in JSON", async () => {
  expect(parsed("context", "ses_123")).toMatchObject({ kind: "context", id: "ses_123", limit: 20 })
  for (const args of [["context"], ["context", "ses_123", "extra"], ["context", "ses_123", "--limit", "101"], ["context", "ses_123", "--limit", "1.5"]]) expect(parseAutomation(args).ok).toBe(false)
  const report = { sessionId: "ses_123", limit: 1, requests: [], truncated: false }
  const h = io(report)
  expect(await runAutomation(parsed("context", "ses_123", "--limit", "1", "--json"), h.deps)).toBe(0)
  expect(h.sent).toEqual([{ type: "context.recent", sessionId: "ses_123", limit: 1 }])
  expect(JSON.parse(h.out[0]!).data).toEqual(report)
  expect(contextText(report)).toContain("No recorded requests")
})

test("context opens with the session's model, window, compaction point and tokens, each with its source", async () => {
  const limits = { model: "gpt-6.1-sol", contextWindow: 500_000, contextWindowSource: "catalog", compactAtTokens: 475_000, compactAtSource: "threshold", thresholdPercent: 95, thresholdSource: "default", autoCompact: true, contextTokens: 212_340, contextTokensSource: "last-call" } as const
  const report = { sessionId: "ses_123", limit: 1, limits, requests: [], truncated: false }
  expect(contextText(report).split("\n").slice(0, 5)).toEqual([
    "model gpt-6.1-sol · context window 500,000 tokens (model list)",
    "compacts at 475,000 tokens: 95% of the window (default; compactAtTokens not set)",
    "context now 212,340 tokens, 45% of the compaction point (provider's count after the last call)",
    "",
    "Context and cache — recent requests",
  ])
  const h = io(report)
  expect(await runAutomation(parsed("context", "ses_123", "--json"), h.deps)).toBe(0)
  expect(JSON.parse(h.out[0]!).data.limits).toEqual(limits)
  expect(contextLimitsLines({ ...limits, compactAtTokens: 200_000, compactAtSource: "compactAtTokens", capped: true, contextWindow: 200_000, contextWindowSource: "session", autoCompact: false, contextTokens: 30_000, contextTokensSource: "estimate" })).toEqual([
    "model gpt-6.1-sol · context window 200,000 tokens (this session's /context-window)",
    "compacts at 200,000 tokens: the compactAtTokens setting, lowered to the window · automatic compaction is off (compaction.auto false): only /compact packs",
    "context now 30,000 tokens, 15% of the compaction point (estimate of the current history)",
  ])
  expect(contextLimitsLines({ model: "unlisted", contextWindowSource: "unknown", compactAtTokens: 160_000, compactAtSource: "no-window-default", autoCompact: true })).toEqual([
    "model unlisted · context window not stated by the model list",
    "compacts at 160,000 tokens: the default when no window is known",
    "context now: no model call recorded",
  ])
  expect(contextLimitsLines({ model: "acme:big", contextWindow: 300_000, contextWindowSource: "catalog", inputLimit: 250_000, compactAtTokens: 200_000, compactAtSource: "threshold", thresholdPercent: 80, thresholdSource: "provider-override", autoCompact: true })[1]).toBe("compacts at 200,000 tokens: 80% of the input limit (the provider's compaction.threshold)")
  expect(contextLimitsLines({ model: "claude-opus", contextWindow: 200_000, contextWindowSource: "engine", compactAtSource: "engine-managed", autoCompact: true, contextTokens: 80_000, contextTokensSource: "last-call" })).toEqual([
    "model claude-opus · context window 200,000 tokens (reported by the engine)",
    "compaction: this engine packs its own context",
    "context now 80,000 tokens, 40% of the window (provider's count after the last call)",
  ])
})

test("system commands retain failing diagnostic exit codes", async () => {
  for (const operation of ["status", "doctor", "check", "toolchain", "config-paths", "adapter-status"]) {
    const h = io({ operation, ok: false, checks: [{ name: "codex", ok: false, detail: "missing" }], failures: ["codex missing"], facts: {} })
    expect(await runAutomation(parsed("control-plane", "system", operation, "--json"), h.deps)).toBe(1)
    expect(h.sent).toEqual([{ type: "system.query", operation, directory: "/work/project" }])
    expect(JSON.parse(h.out[0]!).data.ok).toBe(false)
  }
  expect(parsed("control-plane", "ai", "env", "status")).toMatchObject({ kind: "system", operation: "ai-env" })
  expect(parsed("control-plane", "ai", "status")).toMatchObject({ kind: "system", operation: "ai-status" })
  for (const args of [["control-plane", "system", "invalid"], ["control-plane", "ai", "env", "invalid"], ["status", "extra"]]) expect(parseAutomation(args).ok).toBe(false)
})

test("debug search forwards glob/query/limit and refuses invalid inputs", async () => {
  const command = parsed("debug", "rg", "files", "--query", "source", "--glob", "*.ts", "--glob=*.tsx", "--limit", "2")
  const h = io({ lines: ["source.ts"], truncated: true })
  expect(await runAutomation(command, h.deps)).toBe(0)
  expect(h.sent).toEqual([{ type: "files.query", operation: "files", directory: "/work/project", query: "source", glob: ["*.ts", "*.tsx"], limit: 2 }])
  expect(h.out.join("")).toBe("source.ts\n[results truncated]\n")
  for (const args of [["debug", "rg", "search"], ["debug", "rg", "files", "--limit", "0"], ["debug", "rg", "files", "--limit", "10001"]]) expect(parseAutomation(args).ok).toBe(false)
})

test("the retired Hono option is absent from help/completions and fails before daemon startup", () => {
  expect(helpText("generate")).not.toContain("--hono")
  expect(parseAutomation(["generate", "--hono"])).toMatchObject({ ok: false, message: expect.stringContaining("--httpapi") })
  for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
    expect(completionScript(shell)).not.toContain("--hono")
    expect(completionScript(shell)).not.toContain("--entry--keep-config")
  }
  const dir = path.join(tempDir(), "uncreated")
  const process = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, "generate", "--hono", "--json"], { stdout: "pipe", stderr: "pipe" })
  expect(process.exitCode).toBe(64)
  expect(process.stderr.toString()).toContain("unknown generate flag --hono")
  expect(Bun.file(path.join(dir, "mendd.db")).size).toBe(0)
})

test("generate --httpapi emits the HTTP adapter OpenAPI offline without a daemon", async () => {
  const h = io()
  const spec = { openapi: "3.1.0", paths: { "/global/health": {} } }
  const deps = { ...h.deps, httpApi: async () => spec } as AutomationDeps
  expect(await runAutomation(parsed("generate", "--httpapi"), deps)).toBe(0)
  expect(JSON.parse(h.out.join(""))).toEqual(spec)
  expect(await runAutomation(parsed("generate", "--httpapi", "--json"), deps)).toBe(0)
  expect(JSON.parse(h.out[1]!)).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "generate", data: spec })
  expect(h.sent).toHaveLength(0)
  expect(parseAutomation(["generate", "--httpapi", "--hono"]).ok).toBe(false)
  const dir = path.join(tempDir(), "uncreated")
  const real = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, "generate", "--httpapi"], { stdout: "pipe", stderr: "pipe" })
  expect(real.exitCode).toBe(0)
  const document = JSON.parse(real.stdout.toString())
  expect(document.openapi).toBe("3.1.0")
  expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/global/health", "/command", "/event", "/file/content", "/pty"]))
  expect(document.components.schemas.Command).toBeDefined()
  expect(Bun.file(path.join(dir, "mendd.db")).size).toBe(0)
})

test("diagnostics uses v1 RSS guardrail thresholds", () => {
  expect(memoryGuardrail(2 * 1024 ** 3 - 1)).toBe("ok")
  expect(memoryGuardrail(2 * 1024 ** 3)).toBe("warning")
  expect(memoryGuardrail(4 * 1024 ** 3)).toBe("critical")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`diagnostics reports actual transcript counters at ${width}x${height}`, async () => {
  const memory = { rss: 1048576, heapTotal: 1048576, heapUsed: 500000, external: 0, arrayBuffers: 0 }
  const h = appHarness({ width, height, diagnostics: { memory: () => memory, snapshot: async () => "/tmp/test.heapsnapshot" }, reply: () => ({ ok: true, result: { memory, connections: 1, actors: 1, jobs: 0, scopes: 1, timers: 0, disposers: 0 } }) })
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Inspect", "Two messages")
  await h.type("/diag\r")
  h.app.render()
  expect(h.text()).toHaveLength(height)
  expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
  if (width >= 70) {
    expect(h.text().join("\n")).toMatch(/Transcript messages\s+2/)
    expect(h.text().join("\n")).toContain("TUI counters")
    expect(h.text().join("\n")).toContain("Warn / critical")
  } else {
    for (let i = 0; i < 2; i++) await h.app.onKey("\x1b[6~")
    h.app.render()
    expect(h.text().join("\n")).toContain("TUI counters")
  }
})
