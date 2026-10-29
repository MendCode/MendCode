import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "@mendcode/daemon"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
test("prompt and control-plane prompt parse every v1 operation and build binding without mutating flags", () => {
  for (const prefix of [["prompt"], ["control-plane", "prompt"]]) {
    expect(parseAutomation([...prefix, "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "prompt" } })
    for (const operation of ["sources", "build", "mode", "cycle-mode"]) expect(parseAutomation([...prefix, operation, "--dir", "/tmp/test", "--json"])).toMatchObject({ ok: true, command: { kind: "prompt", operation, dir: "/tmp/test", json: true } })
    expect(parseAutomation([...prefix, "build", "--mode", "full", "--focus", "gemini", "--model", "test", "--role", "review", "--workflow", "edit", "--show-full"])).toMatchObject({ ok: true, command: { mode: "full", focusID: "gemini", modelID: "test", role: "review", workflow: "edit", showFull: true } })
    expect(parseAutomation([...prefix, "mode", "dev-js"])).toMatchObject({ ok: true, command: { mode: "full" } })
    expect(parseAutomation([...prefix, "mode", "--focus", "kimi"])).toMatchObject({ ok: true, command: { focusID: "kimi" } })
    expect(parseAutomation([...prefix, "mode", "--focus", "auto"])).toMatchObject({ ok: true, command: { focusID: "auto" } })
    expect(parseAutomation([...prefix, "build"])).toMatchObject({ ok: true, command: { focusID: "auto" } })
    expect(parseAutomation([...prefix, "sources", "--model", "claude-sonnet-5-5"])).toMatchObject({ ok: true, command: { modelID: "claude-sonnet-5-5" } })
    for (const args of [["mode", "bad"], ["mode", "focus", "extra"], ["build", "--focus", "bad"], ["sources", "--show-full"], ["cycle-mode", "--mode", "full"], ["build", "--mode"], ["build", "--model", "--json"]]) expect(parseAutomation([...prefix, ...args])).toMatchObject({ ok: false })
  }
})
test("all four automation operations reach the daemon, do no turns, and build never saves its overrides", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b05-cli-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b05-cli" })
  await client.connect()
  cleanup.push(() => client.close())
  let output = "", errors = ""
  const deps: AutomationDeps = { client, cwd: dir, now: () => Date.now(), out: { write: (text) => { output += text } }, err: { write: (text) => { errors += text } }, listen() {} }
  const run = async (...args: string[]) => {
    const parsed = parseAutomation(["control-plane", "prompt", ...args, "--json", "--dir", dir])
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    output = ""
    expect(await runAutomation(parsed.command, deps)).toBe(0)
    return JSON.parse(output).data
  }
  expect(await run("mode")).toMatchObject({ mode: "focus" })
  expect(await run("mode", "minimal", "--focus", "deepseek")).toMatchObject({ mode: "minimal", focusID: "deepseek" })
  expect(await run("build", "--mode", "full", "--focus", "mistral")).toMatchObject({ mode: "full", focusID: "mistral", printsFullPrompt: false, includeProjectInstructions: true })
  expect(await run("mode")).toMatchObject({ mode: "minimal", focusID: "deepseek" })
  expect(await run("cycle-mode")).toMatchObject({ mode: "focus", focusID: "deepseek" })
  const sources = await run("sources")
  expect(Object.keys(sources.sources)).toEqual(["codex", "claude", "gemini", "kimi", "deepseek", "mistral", "glm", "minimax", "grok", "local"])
  expect(await run("mode", "--focus", "auto")).toMatchObject({ focusID: "auto" })
  expect(await run("sources", "--model", "anthropic:claude-sonnet-5-5")).toMatchObject({ focusID: "auto", resolvedFocus: "claude", focusLabel: "auto → claude" })
  expect(await run("build", "--mode", "focus", "--model", "claude-sonnet-5-5")).toMatchObject({ focusID: "auto", resolvedFocus: "claude", sections: expect.arrayContaining([expect.objectContaining({ id: "focus", label: "auto → claude focus" })]) })
  expect((await run("build", "--show-full")).instructions).toContain("MendCode")
  expect(await client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [] } })
  expect(errors).toBe("")
  // The cost notice: the JSON carries the per-call estimates of every mode, the plain output leads with the chosen mode's line.
  const costs = (await run("mode", "guide")).costs as Array<{ mode: string; tokens: number; overFocus: number }>
  expect(costs.map((cost) => cost.mode)).toEqual(["minimal", "focus", "guide", "full"])
  expect(costs[2]!.overFocus).toBeGreaterThan(0)
  expect(costs[2]!.tokens).toBe(costs[1]!.tokens + costs[2]!.overFocus)
  for (const [args, pattern] of [[["mode", "guide"], /^guide · \+[\d,]+ tokens per call \([\d,]+ total\) · sent with every call\n/], [["mode", "focus"], /^focus · [\d,]+ tokens per call\n/], [["cycle-mode"], /^guide · \+[\d,]+ tokens per call/]] as const) {
    output = ""
    const parsed = parseAutomation(["control-plane", "prompt", ...args, "--dir", dir])
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    expect(await runAutomation(parsed.command, deps)).toBe(0)
    expect(output).toMatch(pattern)
  }
})
