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

function scenario(steps: ModelEvent[][], yieldMs = 150) {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-yield-")))
  dirs.push(cwd)
  const exits: string[] = []
  const tasks = createBackgroundTasks({ onExit: (_session, task) => exits.push(task.id) })
  registries.push(tasks)
  const { provider, requests } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools: [shell], history: memoryHistory(), grants: createGrantStore(), cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({}), background: (sessionId) => tasks.forSession(sessionId), shellYieldMs: () => yieldMs })
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
