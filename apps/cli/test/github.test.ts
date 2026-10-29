import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient, commandTimeout } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import type { SessionEvent, SessionId, PrCheckoutReport } from "@mendcode/protocol"
import { fakeGithub, githubEvent } from "../../../packages/daemon/test/github-fake"
import { parseAutomation, runAutomation, helpText, type AutomationDeps } from "../src/automation"
import { parseRemoteFlags } from "../src/remote"
import { appHarness, cleanTemps } from "./session-ui-harness"
import { prepareStartup, parseStartup } from "../src/startup"
import { textWidth } from "../src/view/wrap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { cleanTemps(); for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b48-cli-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
async function fixture(options: { fail?: boolean; toolOnly?: boolean; hang?: boolean } = {}) {
  const dir = temp(), directory = temp(), fake = fakeGithub(directory)
  let listener: ((event: SessionEvent) => void) | undefined, interrupt: (() => void) | undefined, output = "", errors = "", opened: PrCheckoutReport | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), githubProcess: fake.process, log: () => {}, engine: () => ({ needsCompaction: () => false, compact: async () => ({ status: "ok" }), async runTurn(input) {
    if (options.hang) {
      if (!input.signal.aborted) await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { status: "ok" }
    }
    if (options.fail) return { status: "error", code: "fixture", message: "local failure" }
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: options.toolOnly ? "tool_call" : "agent_message", ...(options.toolOnly ? { meta: { tool: "Edit src/parser.ts" } } : {}) })
    if (!options.toolOnly) input.emit({ type: "item.delta", itemId, text: "Fixed parser; rejection is covered." })
    input.emit({ type: "item.completed", itemId, status: "ok", text: options.toolOnly ? "tool completed" : "Fixed parser; rejection is covered." })
    return { status: "ok" }
  } }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b48-cli", onEvent: (event) => { listener?.(event); if (options.hang && event.type === "turn.started") interrupt?.() } })
  await client.connect()
  cleanup.push(() => client.close())
  const deps: AutomationDeps = { client, cwd: directory, env: {}, now: Date.now, listen: (fn) => { listener = fn }, onInterrupt: (fn) => { interrupt = fn }, out: { write: (text) => { output += text } }, err: { write: (text) => { errors += text } }, openPr: async (report) => { opened = report } }
  const run = async (...args: string[]) => {
    output = ""; errors = ""; opened = undefined
    const parsed = parseAutomation(args)
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    const code = await runAutomation(parsed.command, deps)
    return { code, output, errors, opened }
  }
  return { dir, directory, fake, daemon, client, deps, run }
}

test("B48 parser accepts inline/global options and rejects ambiguous, malformed or unrelated arguments without echoing secrets", () => {
  expect(parseAutomation(["--data-dir", "/tmp/data", "github", "install", "--model", "openai/model", "--write", "--project", "/tmp/project"])).toMatchObject({ ok: true, command: { kind: "github.install", dir: "/tmp/data", projectDir: "/tmp/project", write: true } })
  expect(parseAutomation(["github", "run", `--event=${githubEvent()}`, "--token=hidden", "--publish", "--approve", "--variant=high", "--attachments"])).toMatchObject({ ok: true, command: { kind: "github.run", token: "hidden", publish: true, approve: true, variant: "high", attachments: true } })
  expect(parseAutomation(["github", "run", "--token=hidden"])).toMatchObject({ ok: true, command: { kind: "github.run", attachments: false } })
  expect(parseAutomation(["pr", "42", "--json"])).toMatchObject({ ok: true, command: { kind: "pr", number: 42, noTui: false } })
  for (const args of [["github"], ["github", "nope"], ["github", "run", "--event", "broken"], ["github", "run", "--token", "private\nsecret"], ["github", "run", "--token", "private", "--token", "another"], ["github", "install", "--token", "private"], ["github", "install", "--model", "plain"], ["github", "run", "--write"], ["github", "run", "extra"], ["pr", "0"], ["pr", "-1"], ["pr", "1.5"], ["pr", "42", "--force"], ["pr", "42", "--publish"], ["pr", "2147483648"]]) {
    const parsed = parseAutomation(args)
    expect(parsed.ok).toBe(false)
    expect(JSON.stringify(parsed)).not.toContain("private")
  }
  expect(helpText("github")).toContain("--event JSON")
  expect(helpText()).toContain("github run")
  expect(parseAutomation(["github", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "github" } })
  expect(parseRemoteFlags(["--dir", "/tmp/data", "github", "run", "--token", "private", "--event", githubEvent()]).args).toContain("private")
  expect(() => parseRemoteFlags(["session", "list", "--token", "private"])).toThrow("not supported")
  expect(commandTimeout({ type: "github.finish", runId: crypto.randomUUID(), status: "completed" }, 15000)).toBe(180000)
})

test("CLI workflow factory previews/writes local files; PR factory opens v2 runtime in the checkout and keeps JSON/headless explicit", async () => {
  const h = await fixture()
  expect(await h.run("github", "install", "--model", "openai/model")).toMatchObject({ code: 0, errors: "" })
  expect(existsSync(path.join(h.directory, ".github"))).toBe(false)
  const written = await h.run("github", "install", "--model", "openai/model", "--write", "--json")
  expect(JSON.parse(written.output)).toMatchObject({ schema: "mendcode-next.cli.v1", command: "github.install", data: { written: true } })
  expect(readFileSync(path.join(h.directory, ".github/workflows/mendcode.yml"), "utf8")).toContain("self-hosted")
  const pr = await h.run("pr", "42")
  expect(pr).toMatchObject({ code: 0, opened: { directory: h.directory, branch: "pr/42", donorSession: "skipped" } })
  expect(pr.output).toContain("Starting MendCode runtime")
  expect((await h.run("pr", "42", "--no-tui")).opened).toBeUndefined()
  expect(JSON.parse((await h.run("pr", "42", "--json")).output)).toMatchObject({ command: "pr", data: { number: 42 } })
  h.deps.allowFiles = false
  const before = h.fake.calls.length
  expect((await h.run("pr", "42", "--no-tui")).code).toBe(64)
  expect(h.fake.calls.length).toBe(before)
}, 15_000)

test("--event and --token run a real daemon turn with a local fake; default never reacts/pushes/comments and JSON keeps its envelope", async () => {
  const h = await fixture()
  const run = await h.run("github", "run", "--event", githubEvent(), "--token", "private-test-token", "--json")
  expect(run.code).toBe(0)
  const lines = run.output.trim().split("\n").map((line) => JSON.parse(line))
  expect(lines.some((line) => line.type === "turn.completed")).toBe(true)
  expect(lines.at(-1)).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "github.run", data: { status: "completed", published: false } })
  expect(run.output + run.errors).not.toContain("private-test-token")
  expect(h.fake.calls.some((call) => call.argv.includes("push") || call.stdin)).toBe(false)
  expect((await h.run("github", "run", "--event", githubEvent(), "--token", "private-test-token")).output).toContain("Fixed parser; rejection is covered.")
}, 15_000)

test("Actions event environment, prompt and token are supplied by the invoking client; run failures never publish and locks release", async () => {
  const h = await fixture({ fail: true })
  h.deps.env = { GITHUB_EVENT_PATH: "/tmp/local-event.json", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "acme/project", GITHUB_ACTOR: "alice", GITHUB_TOKEN: "test-token", PROMPT: "Fix parser" }
  h.deps.readJson = async () => ({ inputs: {} })
  const run = await h.run("github", "run", "--publish")
  expect(run).toMatchObject({ code: 1 })
  expect(run.output).toContain("GitHub run failed")
  expect(h.fake.calls.some((call) => call.argv.includes("push") || call.stdin)).toBe(false)
  expect((await h.run("pr", "42", "--no-tui")).code).toBe(0)
}, 15_000)

test("tool-only response completes without losing the run; publish posts a bounded response and clears its reaction", async () => {
  const h = await fixture({ toolOnly: true })
  const run = await h.run("github", "run", "--event", githubEvent(), "--token", "test-token", "--publish")
  expect(run).toMatchObject({ code: 0 })
  expect(run.output).toContain("Published")
  expect(h.fake.calls.some((call) => call.stdin?.includes("Agent completed without a text response. Tool calls (1):\\n- Edit src/parser.ts"))).toBe(true)
  expect(h.fake.calls.some((call) => call.argv.includes("DELETE"))).toBe(true)
}, 15_000)

test("interrupt targets the active turn, exits stopped and releases its reaction/checkout without publishing", async () => {
  const h = await fixture({ hang: true })
  const run = await h.run("github", "run", "--event", githubEvent(), "--token", "test-token", "--publish")
  expect(run.code).toBe(2)
  expect(run.output).toContain("GitHub run stopped")
  expect(h.fake.calls.some((call) => call.argv.includes("push") || call.argv[2] === "repos/acme/project/issues/42/comments" && call.stdin)).toBe(false)
  expect(h.fake.calls.some((call) => call.argv.includes("DELETE"))).toBe(true)
  expect((await h.run("pr", "42", "--no-tui")).code).toBe(0)
}, 15_000)

test("PR entry uses existing app factories and Line[] rendering at every required breakpoint", async () => {
  const h = await fixture()
  const checked = await h.run("pr", "42")
  const startup = parseStartup(["--cwd", checked.opened!.directory])
  const selected = await prepareStartup(h.client, startup, checked.opened!.directory, "")
  writeTuiProfile(h.dir, { ...DEFAULT_TUI_PROFILE, homeLayout: "split", homeRightPanel: "actions", pet: "off", images: "off" })
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const app = appHarness({ width, height, directory: selected.directory, sessionId: selected.sessionId, dataDir: h.dir })
    app.app.applySettings({ onboarded: true })
    app.app.render()
    expect(app.text().length).toBe(height)
    expect(app.text().every((row) => textWidth(row) <= width)).toBe(true)
    expect(app.text().join("\n")).toContain("Resume session")
    await app.app.onKey("\x03")
  }
}, 15_000)

test("GitHub help and lazy factories load no daemon, zod, schemas or process/network API in the CLI", () => {
  const source = readFileSync(path.join(import.meta.dir, "../src/github-automation.ts"), "utf8") + readFileSync(path.join(import.meta.dir, "../src/github-args.ts"), "utf8")
  expect(source).not.toMatch(/fetch\(|Bun\.spawn|child_process/)
  const probe = Bun.spawnSync([process.execPath, "-e", 'await import("./apps/cli/src/automation.ts"); await import("./apps/cli/src/github-automation.ts"); const bad = Object.keys(require.cache).filter((file) => file.includes("/zod/") || /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(file) || file.includes("/daemon/")); console.log(JSON.stringify(bad))'], { cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" })
  expect(probe.exitCode).toBe(0)
  expect(JSON.parse(probe.stdout.toString())).toEqual([])
})

test("github install --hosted needs a pinned release and installer hash; github run --review is the PR reviewer and takes no agent options", () => {
  const sha = "ab".repeat(32)
  expect(parseAutomation(["github", "install", "--hosted", "--model", "openai/gpt-6-luna", "--release", "v0.4.0", "--sha256", sha, "--write"])).toMatchObject({ ok: true, command: { kind: "github.install", hosted: true, release: "v0.4.0", sha256: sha, write: true } })
  for (const args of [["github", "install", "--hosted", "--model", "openai/m"], ["github", "install", "--hosted", "--model", "openai/m", "--release", "latest", "--sha256", sha], ["github", "install", "--hosted", "--model", "openai/m", "--release", "v1.0.0", "--sha256", "XYZ"], ["github", "install", "--model", "openai/m", "--release", "v1.0.0", "--sha256", sha], ["github", "run", "--review", "--approve"], ["github", "run", "--review", "--prompt", "hi"], ["github", "run", "--hosted"]]) expect(parseAutomation(args).ok).toBe(false)
  expect(parseAutomation(["github", "run", "--publish", "--review"])).toMatchObject({ ok: true, command: { kind: "github.run", publish: true, review: true } })
  expect(commandTimeout({ type: "github.run", directory: "/tmp", input: { event: "{}", token: "t", review: true } }, 15000)).toBe(35 * 60_000)
})
