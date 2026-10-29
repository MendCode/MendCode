import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { sessionMetaTool } from "../../daemon/src/session-meta-tool"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

test("session metadata is off by default and an explicit feature override works below its tier", async () => {
  let settings: Settings = {}
  const script = scriptedProvider([stop("off"), stop("on"), stop("override")])
  const engine = createNativeEngine({ provider: script.provider, tools: [sessionMetaTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", sessionMeta: () => async () => ({}), permissionPolicy: () => settings })
  for (const [next, offered] of [[{}, false], [{ tier: "balanced", features: { lean_tools: false } }, true], [{ tier: "minimalist", features: { session_meta: true, lean_tools: false } }, true]] as const) {
    settings = next
    await engine.runTurn(turn({ text: "metadata" }).input)
    expect(script.requests.at(-1)!.tools.some((tool) => tool.name === "session_meta")).toBe(offered)
  }
})
test("PR operations ask for approval; a denied operation never calls the metadata port", async () => {
  let calls = 0
  const script = scriptedProvider([callTool("session_meta", { action: "link_pr", pr: "7" }), stop("denied")])
  const engine = createNativeEngine({ provider: script.provider, tools: [sessionMetaTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", sessionMeta: () => async () => { calls++; return {} }, permissionPolicy: () => ({ tier: "balanced", features: { lean_tools: false } }) })
  const t = turn({ text: "link PR" })
  await engine.runTurn(t.input)
  expect(t.asked).toHaveLength(1)
  expect(calls).toBe(0)
})
