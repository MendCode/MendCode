import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCodeGraphTools } from "@mendcode/codegraph"
import { capabilityIndex, createNativeEngine, loadSystemPrompt, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import { TIER_BUNDLES, effectiveSettings, featureOn, setBuildChannel, type BuildChannel, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { hostInstructions } from "../src/host-mcp"
import { graphAutopilotText } from "../src/prompt-guidance"
import { composePromptParts, createPromptModes, graphAutopilotPart } from "../src/prompt-modes"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"

const cleanup: Array<() => void> = []
afterEach(() => { setBuildChannel(undefined); for (const fn of cleanup.splice(0)) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-gap-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const LINE = graphAutopilotText().native

/** The requests of a session as the daemon composes them (main.ts `systemParts`): the real tools with the code graph's, the tier's prompt mode and the autopilot's line. */
async function session({ tier, channel, steps = [stop("ok")], settings = {} }: { tier: Tier; channel: BuildChannel | undefined; steps?: Parameters<typeof scriptedProvider>[0]; settings?: TierSettings }): Promise<ModelRequest[]> {
  setBuildChannel(channel)
  const dir = temp(), project = temp()
  createPromptModes(dir).set(project, { mode: TIER_BUNDLES[tier].promptMode })
  const packaged = await loadSystemPrompt()
  const { provider, requests } = scriptedProvider(steps)
  const all: TierSettings = { tier, ...settings }
  const engine = createNativeEngine({
    provider, history: memoryHistory(), compactionPrompt: "Summarize", cwdFor: () => project, subagents: true,
    tools: [...BUILTIN_TOOLS, ...createCodeGraphTools({ cacheDir: path.join(dir, "codegraph") })],
    system: (root, context) => composePromptParts(dir, root, [
      { id: "base", label: "base prompt", text: packaged(root) },
      graphAutopilotPart({ tools: context?.tools, on: featureOn(all, "graph_autopilot") }),
      { id: "capabilities-index", label: "MendCode capabilities", text: context?.tools ? capabilityIndex(context.tools) : "" },
    ]).parts.map((part) => part.text).join("\n\n"),
    permissionPolicy: () => effectiveSettings(all),
  })
  await engine.runTurn(turn({ text: "where is the login handled?", mode: () => "full" }).input)
  return requests
}
const count = (text: string) => text.split(LINE).length - 1

describe("the graph autopilot's prompt line", () => {
  test("full tier in a nightly, dev or local build carries it once, with the graph's lookup tool listed", async () => {
    for (const channel of ["nightly", "dev", "local"] as const) {
      const [first] = await session({ tier: "full", channel })
      expect(count(first!.system)).toBe(1)
      expect(first!.tools.map((tool) => tool.name)).toContain("graph_find")
    }
  })

  test("beta and stable builds carry nothing until /tier graph_autopilot on", async () => {
    for (const channel of ["beta", "stable"] as const) {
      expect(count((await session({ tier: "full", channel }))[0]!.system)).toBe(0)
      expect(count((await session({ tier: "full", channel, settings: { features: { graph_autopilot: true } } }))[0]!.system)).toBe(1)
    }
  })

  test("minimalist and balanced get no line and no new tokens, even in a nightly build", async () => {
    for (const tier of ["minimalist", "balanced"] as const) {
      const [nightly] = await session({ tier, channel: "nightly" })
      const [stable] = await session({ tier, channel: "stable" })
      expect(count(nightly!.system)).toBe(0)
      const plain = (request: ModelRequest) => request.system.replace(/mend-gap-\w+/g, "project")
      expect(plain(nightly!)).toBe(plain(stable!))
      expect(JSON.stringify(nightly!.tools)).toBe(JSON.stringify(stable!.tools))
    }
  })

  test("no graph tool listed (the graph is off for the project or the feature) means no line", async () => {
    const [off] = await session({ tier: "full", channel: "nightly", settings: { features: { codegraph: false } } })
    expect(off!.tools.map((tool) => tool.name)).not.toContain("graph_find")
    expect(count(off!.system)).toBe(0)
    const [disabled] = await session({ tier: "full", channel: "nightly", settings: { features: { graph_autopilot: false } } })
    expect(count(disabled!.system)).toBe(0)
  })

  test("the system prompt does not change inside a turn: every request of a multi-step turn sends the same text (prompt cache)", async () => {
    const requests = await session({ tier: "full", channel: "nightly", steps: [callTool("graph_find", { query: "login" }), callTool("graph_file_api", { path: "x.ts" }), stop("done")] })
    expect(requests.length).toBe(3)
    expect(new Set(requests.map((request) => request.system)).size).toBe(1)
    expect(count(requests[2]!.system)).toBe(1)
  })

  test("it costs about 70 estimated tokens, one short sentence group", () => {
    const tokens = Math.ceil(LINE.length / 4)
    console.info(`graph autopilot line: ${LINE.length} chars, ~${tokens} tokens; harness line ~${Math.ceil(graphAutopilotText().harness.length / 4)} tokens`)
    expect(tokens).toBeLessThanOrEqual(80)
    expect(LINE.split("\n")).toHaveLength(1)
    expect(LINE).toContain("graph_find")
    expect(LINE).toContain("read only the spans")
  })

  test("a native sub-agent started with the graph tools gets the same line; one without them gets none", async () => {
    const requests = await session({ tier: "full", channel: "nightly", steps: [callTool("task", { description: "look", prompt: "Find where login is handled." }), stop("found it"), stop("done")] })
    const child = requests.find((request) => request.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Find where login is handled.")) && request !== requests[0])
    expect(child).toBeDefined()
    expect(child!.tools.map((tool) => tool.name)).toContain("graph_find")
    expect(count(child!.system)).toBe(1)
    const bare = await session({ tier: "balanced", channel: "nightly", steps: [callTool("task", { description: "look", prompt: "Find where login is handled." }), stop("found it"), stop("done")] })
    expect(bare.every((request) => count(request.system) === 0)).toBe(true)
  })
})

describe("Claude Code, Codex and ACP agents", () => {
  const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } })
  const graph = ["graph_find", "graph_callers", "graph_file_api", "graph_map"].map(tool)

  test("their instructions for MendCode's tools carry the autopilot line when the feature is on and the graph tools are served", () => {
    const line = graphAutopilotText().harness
    for (const harness of ["claude", "codex"] as const) {
      expect(hostInstructions(graph, harness, undefined, true)).toContain(line)
      expect(hostInstructions(graph, harness, undefined, false)).not.toContain(line)
      expect(hostInstructions([tool("remember")], harness, undefined, true)).not.toContain(line)
    }
  })

  test("the same text reaches Claude Code's own sub-agents (SubagentStart) and Codex's developer instructions, which are built from it", () => {
    // `harness.instructions()` is what both receive; it is `hostInstructions` with the session's tools and the feature's state.
    const told = hostInstructions(graph, "claude", undefined, true)
    expect(told).toContain("BEFORE")
    expect(told).toContain("MendCode builds and refreshes the graph, so never skip it")
  })
})
