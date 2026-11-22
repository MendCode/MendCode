import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createBackgroundTasks, shell, type BackgroundTasks } from "@mendcode/tools"
import { createGrantStore, createNativeEngine, memoryHistory, type ModelEvent } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const dirs: string[] = []
const registries: BackgroundTasks[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scenario(steps: ModelEvent[][], yieldMs = 150, extra: Record<string, unknown> = {}) {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-yield-")))
  dirs.push(cwd)
  const exits: string[] = []
  const tasks = createBackgroundTasks({ onExit: (_session, task) => exits.push(task.id) })
  registries.push(tasks)
  const { provider, requests } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools: [shell], history: memoryHistory(), grants: createGrantStore(), cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({}), background: (sessionId) => tasks.forSession(sessionId), shellYieldMs: () => yieldMs, ...extra })
  return { engine, requests, tasks, exits }
}

const lastUserText = (request: { messages: Array<{ role: string; content: unknown }> }) => {
  const last = [...request.messages].reverse().find((message) => message.role === "user")
  return typeof last?.content === "string" ? last.content : ""
}

test("a command that moved to the background holds the answer until it ends, then the model sees how it ended", async () => {
  const s = scenario([callTool("shell", { command: "sleep 0.5; echo built" }), stop("done before the build ended"), stop("the build passed")])
  const t = turn({ text: "build it", mode: () => "full" })
  await s.engine.runTurn(t.input)
  expect(s.requests).toHaveLength(3)
  const told = lastUserText(s.requests[2] as never)
  expect(told).toContain("ended before your answer")
  expect(told).toContain("built")
  expect(told).toContain("exit 0")
  const cards = t.events.filter((event) => event.type === "item.started" && (event as { meta?: { tool?: string } }).meta?.tool?.startsWith("waiting for "))
  expect(cards).toHaveLength(1)
})

test("a command that already ended while the model worked does not hold the answer again", async () => {
  // The first moves at 0.4 s and ends at 0.5 s; the second (0.4 s, under the yield) runs in the foreground past that exit.
  const s = scenario([callTool("shell", { command: "sleep 0.5; echo quick" }), callTool("shell", { command: "sleep 0.3" }), stop("all done")], 400)
  const t = turn({ text: "go", mode: () => "full" })
  await s.engine.runTurn(t.input)
  expect(s.requests).toHaveLength(3)
  expect(t.events.some((event) => event.type === "item.started" && (event as { meta?: { tool?: string } }).meta?.tool?.startsWith("waiting for "))).toBe(false)
})

test("the report of a moved command never carries a secret the command was given or printed", async () => {
  const secrets = { list: () => [], resolve: (_session: unknown, text: string) => text.replaceAll("‹secret:1›", "hunter2"), mask: (_session: unknown, text: string) => text.replaceAll("hunter2", "‹secret:1›"), stream: () => undefined }
  const s = scenario([callTool("shell", { command: "sleep 0.5; echo token ‹secret:1›" }), stop("early"), stop("done")], 150, { secrets })
  const t = turn({ text: "build it", mode: () => "full" })
  await s.engine.runTurn(t.input)
  const told = lastUserText(s.requests[2] as never)
  expect(told).toContain("‹secret:1›")
  expect(told).not.toContain("hunter2")
  expect(JSON.stringify(t.events)).not.toContain("hunter2")
})

test("a custom command's inline shell runs to its end before the prompt is expanded, however long it takes", async () => {
  const s = scenario([stop("expanded")], 150, { inlineShell: (text: string) => (text.includes("MARK") ? [{ marker: "MARK", command: "sleep 0.5; echo full-output" }] : []) })
  const t = turn({ text: "see MARK", mode: () => "full" })
  await s.engine.runTurn(t.input)
  const first = JSON.stringify(s.requests[0]!.messages)
  expect(first).toContain("full-output")
  expect(first).not.toContain("moved to the background")
  expect(s.exits).toHaveLength(0)
})

test("the last step and the step limit still wait for a command that moved to the background, and keep how it ended", async () => {
  // The engine's own limit: the second step is the text-only summary, with no model call left for a report.
  const last = scenario([callTool("shell", { command: "sleep 0.5; echo built" }), stop("summary")], 150, { maxSteps: 2 })
  const lastTurn = turn({ text: "build it", mode: () => "full" })
  await last.engine.runTurn(lastTurn.input)
  expect(last.requests).toHaveLength(2)
  expect(last.exits).toHaveLength(1)
  expect(lastTurn.events.some((event) => event.type === "item.started" && (event as { meta?: { tool?: string } }).meta?.tool?.startsWith("waiting for "))).toBe(true)
  // A step cap the caller set ends the loop after the tool step.
  const capped = scenario([callTool("shell", { command: "sleep 0.5; echo built" })], 150, { runLimits: () => ({ maxSteps: 1 }) })
  const cappedTurn = turn({ text: "build it", mode: () => "full" })
  const outcome = await capped.engine.runTurn(cappedTurn.input)
  expect(outcome).toMatchObject({ status: "error", code: "max_steps" })
  expect(capped.exits).toHaveLength(1)
})

test("a message the user sends while the turn waits for a moved command ends the wait; the command keeps running", async () => {
  const s = scenario([callTool("shell", { command: "sleep 3; echo built" }), stop("done before the build ended"), stop("never asked")])
  const t = turn({ text: "build it", mode: () => "full" })
  let queued: (() => void) | undefined
  t.input.onQueued = (handler) => { queued = handler }
  const started = Date.now()
  const running = s.engine.runTurn(t.input)
  while (!t.events.some((event) => event.type === "item.started" && (event as { meta?: { tool?: string } }).meta?.tool?.startsWith("waiting for "))) await Bun.sleep(20)
  queued?.()
  const outcome = await running
  expect(outcome).toMatchObject({ status: "ok" })
  expect(Date.now() - started).toBeLessThan(2_500)
  expect(s.requests).toHaveLength(2)
  expect(s.exits).toHaveLength(0)
})
