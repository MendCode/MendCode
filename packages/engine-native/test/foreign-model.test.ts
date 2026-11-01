import { describe, expect, test } from "bun:test"
import type { ModelChoice } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const foreignModel = (model: string) => (model === "claude-opus" ? "Claude Code" : undefined)

describe("a model another engine runs never reaches a provider of the native engine", () => {
  test("a turn on such a model fails before any request, with what to do", async () => {
    const { provider, requests } = scriptedProvider([stop("never")])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", modelFor: () => ({ model: "claude-opus" }), foreignModel })
    const outcome = await engine.runTurn(turn({ text: "hi" }).input)
    expect(outcome).toMatchObject({ status: "error", message: expect.stringContaining("claude-opus runs on Claude Code, not on MendCode's own engine") })
    expect(requests).toHaveLength(0)
  })

  test("a move to such a model mid-turn applies from the next turn; the rest of the turn keeps its model", async () => {
    let main: ModelChoice = { model: "gpt-6-luna", effort: "high" }
    const { provider, requests } = scriptedProvider([
      (request) => (async function* () { main = { model: "claude-opus" }; yield* callTool("echo", { text: request.model ?? "" }) })(),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", modelFor: () => main, foreignModel })
    const sessionId = ids("session")
    expect(await engine.runTurn(turn({ text: "hi", sessionId, mode: () => "full" }).input)).toMatchObject({ status: "ok" })
    expect(requests.map((request) => [request.model, request.effort])).toEqual([["gpt-6-luna", "high"], ["gpt-6-luna", "high"]])
    // The turn is over: the session's next turn is not this engine's to run on the old model.
    expect(await engine.runTurn(turn({ text: "again", sessionId }).input)).toMatchObject({ status: "error" })
    expect(requests).toHaveLength(2)
  })
})
