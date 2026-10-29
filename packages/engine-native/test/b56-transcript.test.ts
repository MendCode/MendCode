import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, echoTool, scriptedProvider, stop, turn } from "./harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), "b56-engine-"))
  dirs.push(dir)
  return dir
}

test("transcript tool input records the validated arguments after extension rewrites", async () => {
  const cwd = directory()
  const { provider } = scriptedProvider([callTool("echo", { text: "before", extra: "discard" }), stop("Done")])
  const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => cwd, system: () => "Test", compactionPrompt: "Summarize", hooks: { has: (name) => name === "tool.before", toolBefore: async () => ({ args: { text: "after", extra: "discard" } }) } })
  const h = turn({ text: "Echo" })
  expect(await engine.runTurn(h.input)).toEqual({ status: "ok" })
  const completed = h.events.find((event) => event.type === "item.completed" && event.text === "echoed after")
  expect(completed?.type === "item.completed" && completed.toolInput).toBe('{"text":"after"}')
})

test("transcript tool input is redacted before its bounded event is emitted", async () => {
  const cwd = directory()
  const secret = "sk-K9mPx8BvQ3rTc7NdY2fHj6LaW0eSg4Uz"
  const { provider } = scriptedProvider([callTool("echo", { text: `${secret} ${"x".repeat(5000)}` }), stop("Done")])
  const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => cwd, system: () => "Test", compactionPrompt: "Summarize" })
  const h = turn({ text: "Echo" })
  await engine.runTurn(h.input)
  const completed = h.events.find((event) => event.type === "item.completed" && event.toolInput)
  if (!completed || completed.type !== "item.completed") throw new Error("Tool input missing")
  expect(completed.toolInput).not.toContain(secret)
  expect(completed.toolInput).toContain("[redacted:openai-key]")
  expect(completed.toolInput).toHaveLength(4000)
})
