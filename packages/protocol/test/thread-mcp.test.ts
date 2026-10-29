import { expect, test } from "bun:test"
import { Settings, TaskInput, ModelInfo } from "../src"
import { FEATURES } from "../src/tier-data"

test("bridge settings and engine delegation remain additive strict lazy contracts", () => {
  expect(Settings.parse({ tier: "full", threadMcp: { claude: true, codex: false } }).threadMcp).toEqual({ claude: true, codex: false })
  expect(Settings.parse({ threadMcp: { acp: { "demo.agent": true, other: false } } }).threadMcp?.acp).toEqual({ "demo.agent": true, other: false })
  for (const acp of [{ demo: "true" }, { "bad name": true }]) expect(Settings.safeParse({ threadMcp: { acp } }).success).toBe(false)
  for (const threadMcp of [{ claude: "true" }, { acp: true }, true]) expect(Settings.safeParse({ threadMcp }).success).toBe(false)
  for (const engine of ["native", "claude", "codex", "pi", "acp:demo", "acp:demo.agent"]) expect(TaskInput.parse({ description: "check", prompt: "check", engine }).engine).toBe(engine)
  expect(TaskInput.safeParse({ description: "check", prompt: "check", engine: "sh -c escape" }).success).toBe(false)
  expect(ModelInfo.parse({ id: "codex:configured", name: "Codex", engine: "codex", efforts: [] }).engine).toBe("codex")
  expect(FEATURES.thread_mcp).toMatchObject({ tier: "full", mode: "permit", legacy: false, safe: true })
})
