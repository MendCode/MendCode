import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { TraceSample, type TraceSample as Sample } from "@mendcode/protocol"
import { parseGlobalOptions } from "../src/global-options"
import { parseAutomation } from "../src/automation"
import { parseStartup } from "../src/startup"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import { boot, answer } from "../../../packages/daemon/test/native-harness"
import { createClient } from "@mendcode/client"
import { terminateDaemon } from "../src/launcher"

afterEach(cleanTemps)
test("global trace flags preserve command parsing, explicit off and literal arguments", () => {
  expect(parseGlobalOptions(["--trace", "run", "--", "--trace"])).toMatchObject({ trace: true, args: ["run", "--", "--trace"] })
  expect(parseGlobalOptions(["--trace=true", "--no-trace", "session", "list"])).toMatchObject({ trace: false, args: ["session", "list"] })
  expect(parseGlobalOptions(["--trace=false", "help"]).trace).toBe(false)
  expect(() => parseGlobalOptions(["--trace=maybe"])).toThrow("true|false")
  expect(parseAutomation(["--trace", "session", "list"])).toMatchObject({ ok: true, command: { kind: "session.list" } })
  expect(parseStartup(parseGlobalOptions(["--trace", "run", "private prompt"]).args)).toMatchObject({ kind: "run", words: ["private prompt"] })
})

test("trace help exits without a daemon or diagnostics file", () => {
  const dir = tempDir()
  const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, "--trace", "help"], { stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(result.stdout.toString()).toContain("--trace")
  expect(Bun.file(path.join(dir, "mendd.db")).size).toBe(0)
  expect(Bun.file(path.join(dir, "trace.jsonl")).size).toBe(0)
}, 15_000)

test("app tracing preserves frames and sends only geometry, IDs and render duration", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60]]) {
    const samples: Sample[] = []
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", trace: (sample) => { samples.push(sample) } })
    const plain = appHarness({ width, height, sessionId: h.sessionId, dataDir: tempDir(), directory: "/work/project" })
    h.app.applySettings({ onboarded: true })
    plain.app.applySettings({ onboarded: true })
    await Bun.sleep(5)
    h.app.render()
    plain.app.render()
    expect(h.frames.at(-1)).toEqual(plain.frames.at(-1))
    const c = conversation(h.sessionId, (event) => h.app.onEvent(event))
    c.exchange("private prompt", "private answer")
    conversation(plain.sessionId, (event) => plain.app.onEvent(event)).exchange("private prompt", "private answer")
    h.app.render()
    plain.app.render()
    expect(h.frames.at(-1)).toEqual(plain.frames.at(-1))
    expect(samples.length).toBeGreaterThan(1)
    for (const sample of samples) {
      expect(TraceSample.safeParse(sample).success).toBe(true)
      expect(sample).toMatchObject({ name: "tui.frame", metadata: { sessionId: h.sessionId, cols: width, rows: height }, status: "ok" })
      expect(sample.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(JSON.stringify(samples)).not.toContain("private")
    expect(JSON.stringify(samples)).not.toContain("/work/project")
    for (const frame of h.frames) {
      expect(frame).toHaveLength(height)
      expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
    }
    expect(h.text().join("\n")).not.toContain("Tracing")
    await h.app.onKey("\x03")
    await plain.app.onKey("\x03")
  }
}, 10_000)

test("failed diagnostics observer never breaks terminal rendering", async () => {
  const h = appHarness({ dataDir: tempDir(), trace: () => { throw new Error("observer failure") } })
  expect(() => h.app.render()).not.toThrow()
  expect(h.frames.length).toBeGreaterThan(0)
  await h.app.onKey("\x03")
})

test("real CLI trace flag reaches an existing fake daemon without echoing prompt or answer", async () => {
  const h = await boot({ steps: [answer("private CLI answer", { input: 30, output: 4 })] })
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/entry.ts"), "--dir", h.dir, "--trace", "run", "private CLI prompt", "--cwd", h.project], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: h.dir, CODEX_HOME: h.dir, MENDCODE_V2_DIR: h.dir, MENDCODE_TRACE: "0" } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    expect(out).toBe("private CLI answer\n")
    expect(err).not.toContain("trace")
    const result = await h.client.traces()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.enabled).toBe(false)
    expect(result.report.spans.some((span) => span.name === "session.llm" && span.metadata.inputTokens === 30)).toBe(true)
    expect(result.report.spans.some((span) => span.operation === "user.submit")).toBe(true)
    expect(JSON.stringify(result.report)).not.toContain("private CLI")
  } finally { await h.cleanup() }
}, 15_000)

test("explicit off suppresses the environment in the launcher and local CLI", async () => {
  const dir = tempDir()
  const env = { ...process.env, HOME: dir, CODEX_HOME: dir, MENDCODE_V2_DIR: dir, MENDCODE_TRACE: "1", MENDCODE_OTEL_ENDPOINT: "", MENDCODE_OTEL_TOKEN: "" }
  const script = `import { ensureDaemon } from ${JSON.stringify(path.join(import.meta.dir, "../src/launcher.ts"))}; await ensureDaemon({ dir: ${JSON.stringify(dir)}, engine: "faux", trace: false, timeoutMs: 15000 })`
  const launcher = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env })
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  const client = createClient({ socketPath: path.join(dir, "mendd.sock"), name: "no-trace-test" })
  let connected = false
  try {
    const [err, code] = await Promise.all([new Response(launcher.stderr).text(), launcher.exited])
    expect({ code, err }).toMatchObject({ code: 0 })
    await client.connect()
    connected = true
    const launched = await client.traces()
    expect(launched.ok && launched.report.enabled).toBe(false)
    child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, "--no-trace", "run", "private prompt"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
    const [, cliErr, cliCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code: cliCode, err: cliErr }).toMatchObject({ code: 0 })
    const result = await client.traces()
    expect(result.ok && result.report.enabled).toBe(false)
    expect(result.ok && result.report.spans).toEqual([])
    expect(Bun.file(path.join(dir, "trace.jsonl")).size).toBe(0)
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGTERM")
    if (child?.exitCode === null) child.kill("SIGTERM")
    if (connected) await client.send({ type: "daemon.shutdown", force: true }).catch(() => {})
    client.close()
    if (!connected) await terminateDaemon(dir)
  }
}, 30_000)
