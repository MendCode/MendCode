import { expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, latestUserRequestContext } from "../src"
import { callTool, scriptedProvider, stop, turn, writeTool } from "./harness"
import { remoteTurnOptions } from "../../daemon/src/remote-policy"

function setup(settings: { tier?: "minimalist" | "balanced"; tools?: Record<string, boolean>; permission?: Record<string, "ask"> }, steps = [callTool("write", { path: "a.ts" }), stop("done"), stop("again")]) {
  const reads: string[] = []
  const history = memoryHistory()
  const { provider, requests } = scriptedProvider(steps)
  const graph = ["graph_map", "graph_impact"].map((name) => defineTool({ name, description: name, permission: "read", args: z.object({ path: z.string().optional(), depth: z.number().optional() }), execute: async () => {
    reads.push(name)
    return { title: name, output: `${name} hint`, isError: false, truncated: false }
  } }))
  const engine = createNativeEngine({ provider, history, tools: [...graph, writeTool([])], cwdFor: () => "/temp/repo", system: () => "sys", compactionPrompt: "summary", permissionPolicy: () => settings })
  return { engine, requests, reads, history }
}

const ON = { tier: "balanced" as const, features: { graph_context: true } }

test("switched on, orientation persists once and impact follows successful edits without replacing user intent", async () => {
  const h = setup(ON)
  const first = turn({ text: "fix a.ts", mode: () => "full" })
  expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
  expect(h.reads).toEqual(["graph_map", "graph_impact"])
  expect(JSON.stringify(h.requests[1]!.messages)).toContain("graph_impact hint")
  expect(latestUserRequestContext(h.requests[1]!.messages).join("\n")).toContain("fix a.ts")
  await h.engine.runTurn(turn({ text: "continue", sessionId: first.input.sessionId, mode: () => "full" }).input)
  expect(h.reads).toEqual(["graph_map", "graph_impact"])
})

test("the injected orientation is marked so the transcript can fold it; a graph_map the model calls is not", async () => {
  const injected = setup(ON, [stop("done")])
  const first = turn({ text: "explain", mode: () => "full" })
  await injected.engine.runTurn(first.input)
  const started = first.events.filter((event) => event.type === "item.started" && event.kind === "tool_call")
  expect(started.map((event) => (event as { meta?: Record<string, unknown> }).meta?.injected)).toEqual([true])
  const asked = setup({ tier: "minimalist" }, [callTool("graph_map", {}), stop("done")])
  const second = turn({ text: "map it", mode: () => "full" })
  await asked.engine.runTurn(second.input)
  const calls = second.events.filter((event) => event.type === "item.started" && event.kind === "tool_call")
  expect(calls).toHaveLength(1)
  expect((calls[0] as { meta?: Record<string, unknown> }).meta?.injected).toBeUndefined()
})

test("nothing is read from the graph on its own: not by default in any tier, not with the graph tools disabled, not in a remote turn", async () => {
  for (const settings of [{ tier: "minimalist" as const }, { tier: "balanced" as const }, { ...ON, tools: { "graph_*": false } }, { ...ON, remote: true }]) {
    const { remote, ...stored } = settings as typeof settings & { remote?: boolean }
    const h = setup(stored, [stop("done")])
    const t = turn({ text: "hello", mode: () => "full" })
    if (remote) t.input.turnOptions = remoteTurnOptions()
    await h.engine.runTurn(t.input)
    expect(h.reads).toEqual([])
  }
})

test("a denied orientation never runs the lookup or calls the provider", async () => {
  const h = setup({ ...ON, permission: { graph_map: "ask" } }, [stop("must not send")])
  const t = turn({ text: "hello", answers: [{ kind: "deny" }] })
  await h.engine.runTurn(t.input)
  expect(h.reads).toEqual([])
  expect(h.requests).toHaveLength(0)
})
