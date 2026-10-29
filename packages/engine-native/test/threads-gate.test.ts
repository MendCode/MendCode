import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { defineTool, type ThreadPort } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

// The real tool lives in the daemon; this stand-in has the same name, tier and permission shape.
const threads = defineTool({
  name: "threads",
  tier: "balanced",
  description: "threads",
  permission: "write",
  args: z.object({ action: z.enum(["read", "message"]), sessionId: z.string() }),
  permissionFor: (args, context) => (args.action === "read" && context?.threads?.granted(args.sessionId) ? "read" : "write"),
  async execute({ action }) { return { output: `${action} done`, truncated: false, title: "threads", isError: false } },
})

const port = (granted: string[]): ThreadPort => ({
  granted: (target) => granted.includes(target),
  list: () => ({ ok: true, output: "" }), read: () => ({ ok: true, output: "" }), search: () => ({ ok: true, output: "" }),
  message: async () => ({ ok: true, output: "" }), wait: async () => ({ ok: true, output: "" }), interrupt: async () => ({ ok: true, output: "" }),
  mergeBack: () => ({ ok: true, output: "" }),
  stats: () => ({ ok: true, output: "" }),
})

function engineWith(script: ReturnType<typeof scriptedProvider>, settings: () => Settings, granted: string[] = []) {
  return createNativeEngine({ provider: script.provider, tools: [threads], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", threads: () => port(granted), permissionPolicy: settings })
}

test("the threads tool is offered only while experimental.thread_tools is on and the tier includes it", async () => {
  let settings: Settings = {}
  const script = scriptedProvider([stop("a"), stop("b"), stop("c"), stop("d")])
  const engine = engineWith(script, () => settings)
  const input = turn({ text: "Hello" }).input
  const offered = async (next: Settings) => {
    settings = next
    await engine.runTurn({ ...input })
    return script.requests.at(-1)!.tools.map((tool) => tool.name).includes("threads")
  }
  expect(await offered({})).toBe(false)
  expect(await offered({ experimental: { thread_tools: true } })).toBe(true)
  expect(await offered({ tier: "minimalist", experimental: { thread_tools: true } })).toBe(false)
  // The lean catalogue (tier default) defers the threads tool behind tool_search; this test is about the tier gate, so it stays off here.
  expect(await offered({ tier: "balanced", features: { lean_tools: false }, experimental: { thread_tools: true } })).toBe(true)
  expect(await offered({ tier: "balanced", experimental: { thread_tools: true } })).toBe(false)
})

test("reading a session the user attached runs without a prompt; reading another one, or messaging, asks", async () => {
  const settings: Settings = { experimental: { thread_tools: true } }
  const attached = scriptedProvider([callTool("threads", { action: "read", sessionId: "session_A" }), stop("ok")])
  const quiet = turn({ text: "Look" })
  await engineWith(attached, () => settings, ["session_A"]).runTurn(quiet.input)
  expect(quiet.asked).toEqual([])
  for (const call of [{ action: "read", sessionId: "session_B" }, { action: "message", sessionId: "session_A" }]) {
    const script = scriptedProvider([callTool("threads", call), stop("ok")])
    const asking = turn({ text: "Look", answers: [{ kind: "approve", scope: "once" }] })
    await engineWith(script, () => settings, ["session_A"]).runTurn(asking.input)
    expect(asking.asked).toHaveLength(1)
  }
})
