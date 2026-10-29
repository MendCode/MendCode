import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { Client, CommandInput } from "@mendcode/client"
import { createIdFactory, parseCommand, type ModelInfo } from "@mendcode/protocol"
import { parseStartup, STARTUP_USAGE } from "../src/startup"
import { parseAutomation } from "../src/automation"
import { sessionSelection } from "../src/session-output"
import { cleanTemps } from "./session-ui-harness"
import { boot, stop, type NativeHarness } from "../../../packages/daemon/test/native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup(); cleanTemps() })

const MODELS: ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", variants: { fast: { effort: "low" }, plain: {} } },
  { id: "claude-opus", name: "Claude Opus", engine: "claude", efforts: ["low", "medium", "high"] },
  { id: "claude-haiku", name: "Claude Haiku", engine: "claude", efforts: [] },
  { id: "local:small", name: "Small", provider: "local", efforts: [] },
]
const report = { engine: "native", selectable: true, models: MODELS, defaults: { model: "gpt-6-luna", effort: "medium" }, roles: {}, effective: { model: "gpt-6-luna", effort: "medium" } }
const client = { send: async (command: CommandInput) => command.type === "models.list" ? { ok: true, result: report } : { ok: false, error: { code: "x", message: "unexpected" } } } as unknown as Pick<Client, "send">

describe("--effort parsing", () => {
  test("flag, -c effort= and the usage text", () => {
    expect(parseStartup(["run", "go", "--model", "chatgpt/gpt-6-luna", "--effort", "medium"])).toMatchObject({ model: "chatgpt/gpt-6-luna", effort: "medium" })
    expect(parseStartup(["run", "go", "--effort=xhigh"])).toMatchObject({ effort: "xhigh" })
    expect(parseStartup(["run", "go", "-c", "effort=low"])).toMatchObject({ effort: "low" })
    expect(parseStartup(["run", "go", "-c", "effort=low", "--effort", "high"])).toMatchObject({ effort: "high" })
    expect(parseStartup(["--effort", "high", "../project"])).toMatchObject({ kind: "tui", project: "../project", effort: "high" })
    expect(parseStartup(["run", "go", "--variant", "high"])).not.toHaveProperty("effort")
    expect(STARTUP_USAGE).toContain("--effort")
  })
  test("an unknown level or a missing value is a usage error that names the valid levels", () => {
    expect(() => parseStartup(["run", "go", "--effort", "turbo"])).toThrow("--effort must be one of minimal, low, medium, high, xhigh, max, none")
    expect(() => parseStartup(["run", "go", "-c", "effort=ultra"])).toThrow("--effort must be one of")
    // max and none are levels now (a model's catalog says whether it takes them).
    expect(parseStartup(["run", "go", "-c", "effort=max"])).toMatchObject({ effort: "max" })
    expect(parseStartup(["run", "go", "--effort", "none"])).toMatchObject({ effort: "none" })
    expect(() => parseStartup(["run", "go", "--effort"])).toThrow("--effort needs a value")
  })
  test("session create and send take it; other session commands refuse it", () => {
    const parsed = (...argv: string[]) => parseAutomation(argv)
    expect(parsed("session", "create", "--dir", "/repo", "--model", "openai/gpt-6-luna", "--effort", "high")).toMatchObject({ ok: true, command: { kind: "session.create", model: "openai/gpt-6-luna", effort: "high" } })
    expect(parsed("session", "send", "ses_x", "hi", "--effort", "low")).toMatchObject({ ok: true, command: { kind: "session.send", effort: "low" } })
    expect(parsed("session", "create", "--effort", "turbo")).toMatchObject({ ok: false })
    expect(parsed("session", "list", "--effort", "low")).toMatchObject({ ok: false })
  })
  test("github run takes --effort and validates it", () => {
    expect(parseAutomation(["github", "run", "--effort=high"])).toMatchObject({ ok: true, command: { kind: "github.run", effort: "high" } })
    expect(parseAutomation(["github", "run", "--effort=turbo"])).toMatchObject({ ok: false })
  })
})

describe("--effort against the model's own levels", () => {
  test("a listed level becomes the choice's effort, keeping the model", async () => {
    expect(await sessionSelection(client, { model: "chatgpt/gpt-6-luna", effort: "xhigh" }, {})).toEqual({ ok: true, model: { model: "gpt-6-luna", effort: "xhigh" } })
    expect(await sessionSelection(client, { effort: "low" }, {})).toEqual({ ok: true, model: { model: "gpt-6-luna", effort: "low" } })
  })
  test("session create (a directory, no session yet) asks for the catalog with a command the daemon accepts", async () => {
    const sent: CommandInput[] = []
    const ids = createIdFactory()
    const recording = { send: async (command: CommandInput) => { sent.push(command); return { ok: true, result: report } } } as unknown as Pick<Client, "send">
    expect(await sessionSelection(recording, { model: "chatgpt/gpt-6-luna", effort: "low" }, { directory: "/repo" })).toEqual({ ok: true, model: { model: "gpt-6-luna", effort: "low" } })
    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0]!).sort()).toEqual(["type"])
    expect(parseCommand({ ...sent[0], id: ids("command"), clientId: ids("client") }).success).toBe(true)
  })
  test("an unlisted level fails and lists the valid ones", async () => {
    expect(await sessionSelection(client, { model: "claude-opus", effort: "xhigh" }, {})).toEqual({ ok: false, message: "unknown effort xhigh for claude-opus; use low, medium, high" })
  })
  test("a model without efforts refuses the option, native or engine", async () => {
    expect(await sessionSelection(client, { model: "local/small", effort: "high" }, {})).toEqual({ ok: false, message: "local:small has no selectable reasoning effort; omit --effort" })
    expect(await sessionSelection(client, { model: "claude-haiku", effort: "high" }, {})).toMatchObject({ ok: false, message: expect.stringContaining("no selectable reasoning effort") })
  })
  test("--model takes a full id of a Claude Code family and keeps it; its efforts are the family's; other ids stay unknown", async () => {
    expect(await sessionSelection(client, { model: "claude-haiku-5-5" }, {})).toEqual({ ok: true, model: { model: "claude-haiku-5-5" } })
    expect(await sessionSelection(client, { model: "claude-opus-5-5", effort: "high" }, {})).toEqual({ ok: true, model: { model: "claude-opus-5-5", effort: "high" } })
    expect(await sessionSelection(client, { model: "claude-opus-4-1-20250805" }, {})).toEqual({ ok: true, model: { model: "claude-opus-4-1-20250805" } })
    expect(await sessionSelection(client, { model: "claude-haiku-5-5", effort: "high" }, {})).toEqual({ ok: false, message: "claude-haiku-5-5 has no selectable reasoning effort; omit --effort" })
    for (const id of ["claude-nonsense", "claude-haiku-fast", "claude-haiku-", "claude-sonnet-5-5", "xclaude-haiku-5-5", "claude-haiku-5-5-5-5"]) expect(await sessionSelection(client, { model: id }, {})).toEqual({ ok: false, message: `unknown model ${id}` })
  })
  test("a Claude Code variant naming the same effort still works; a different one conflicts", async () => {
    expect(await sessionSelection(client, { model: "claude-opus", variant: "high" }, {})).toEqual({ ok: true, model: { model: "claude-opus", variant: "high" } })
    expect(await sessionSelection(client, { model: "claude-opus", variant: "high", effort: "high" }, {})).toMatchObject({ ok: true })
    expect(await sessionSelection(client, { model: "claude-opus", variant: "high", effort: "low" }, {})).toMatchObject({ ok: false, message: expect.stringContaining("conflicts with --effort low") })
  })
  test("a native variant carrying its own effort conflicts with another --effort; one without does not", async () => {
    expect(await sessionSelection(client, { model: "gpt-6-luna", variant: "fast", effort: "high" }, {})).toMatchObject({ ok: false, message: expect.stringContaining("--variant fast sets effort low") })
    expect(await sessionSelection(client, { model: "gpt-6-luna", variant: "plain", effort: "high" }, {})).toMatchObject({ ok: true })
  })
})

describe("run --effort reaches the model request", () => {
  const entry = path.join(import.meta.dir, "../src/entry.ts")
  function launch(dir: string, args: string[]) {
    return Bun.spawn([process.execPath, entry, "--dir", dir, ...args], { stdin: new Blob([""]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: dir, CODEX_HOME: dir, MENDCODE_V2_DIR: dir } })
  }
  async function output(child: ReturnType<typeof launch>) {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { out, err, code }
  }
  test("--effort and -c effort= send the chosen effort; an unlisted effort fails before any model call", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    harnesses.push(h)
    const flag = await output(launch(h.dir, ["run", "go", "--cwd", h.project, "--model", "gpt-6-sol", "--effort", "medium"]))
    expect(flag.code).toBe(0)
    const config = await output(launch(h.dir, ["run", "go", "--cwd", h.project, "--model", "gpt-6-sol", "-c", "effort=low"]))
    expect(config.code).toBe(0)
    expect(h.requests.map((request) => [request.model, request.effort])).toEqual([["gpt-6-sol", "medium"], ["gpt-6-sol", "low"]])
    const refused = await output(launch(h.dir, ["run", "go", "--cwd", h.project, "--model", "gpt-6-sol", "--effort", "xhigh"]))
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("unknown effort xhigh for gpt-6-sol; use low, medium, high")
    expect(h.requests).toHaveLength(2)
  }, 30_000)
})

test("a model is accepted by the name `mendcode models` prints for it (its reference), such as claude/claude-sonnet", async () => {
  const listed = { send: async () => ({ ok: true as const, result: { models: [{ id: "claude-sonnet", name: "Claude Sonnet", efforts: ["low", "high"], reference: "claude/claude-sonnet" }], roles: {}, defaults: { model: "claude-sonnet" } } }) }
  expect(await sessionSelection(listed as never, { model: "claude/claude-sonnet" }, {})).toEqual({ ok: true, model: { model: "claude-sonnet" } })
  expect(await sessionSelection(listed as never, { model: "claude-sonnet" }, {})).toEqual({ ok: true, model: { model: "claude-sonnet" } })
  expect(await sessionSelection(listed as never, { model: "claude/claude-nope" }, {})).toMatchObject({ ok: false, message: "unknown model claude/claude-nope" })
})
