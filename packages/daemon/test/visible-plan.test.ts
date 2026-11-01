import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { capabilityIndex, createNativeEngine, loadSystemPrompt, memoryHistory, questionTool, todoTool, type ModelRequest } from "@mendcode/engine-native"
import { TIER_BUNDLES, effectiveSettings, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { composePromptParts, createPromptModes, visiblePlanPart } from "../src/prompt-modes"
import { visiblePlanText } from "../src/prompt-guidance"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-plan-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const LINE = visiblePlanText().native

/** The requests of a fresh session as the daemon composes them: the real tools with `todo`, the tier's prompt mode, the plan line and the capability line. */
async function session(tier: Tier, steps: Parameters<typeof scriptedProvider>[0] = [stop("ok")], extra: TierSettings = {}): Promise<ModelRequest[]> {
  const dir = temp(), project = temp()
  createPromptModes(dir).set(project, { mode: TIER_BUNDLES[tier].promptMode })
  const packaged = await loadSystemPrompt()
  const { provider, requests } = scriptedProvider(steps)
  const engine = createNativeEngine({
    provider, history: memoryHistory(), compactionPrompt: "Summarize", cwdFor: () => project,
    tools: [...BUILTIN_TOOLS, questionTool, todoTool],
    system: (root, context) => composePromptParts(dir, root, [
      { id: "base", label: "base prompt", text: packaged(root) },
      visiblePlanPart(context?.tools),
      { id: "capabilities-index", label: "MendCode capabilities", text: context?.tools ? capabilityIndex(context.tools) : "" },
    ]).parts.map((part) => part.text).join("\n\n"),
    permissionPolicy: () => effectiveSettings({ tier, ...extra }),
  })
  await engine.runTurn(turn({ text: "hello" }).input)
  return requests
}
const named = (request: ModelRequest, name: string) => request.tools.find((tool) => tool.name === name)

describe("visible plan per tier", () => {
  test("balanced and full list todo with a description that says it is pinned, and carry the plan line once", async () => {
    for (const tier of ["balanced", "full"] as const) {
      const [first] = await session(tier)
      expect(named(first!, "todo")?.description).toContain("pinned above the prompt")
      expect(named(first!, "todo")?.description).toContain("3+ steps")
      expect(first!.system.split(LINE).length - 1).toBe(1)
      // The old line that sent the model to tool_search for it is gone.
      expect(first!.system).not.toContain("load it with `tool_search`")
    }
  })

  test("minimalist has no todo tool, no plan line and no todo in tool_search's description", async () => {
    const [first] = await session("minimalist")
    expect(named(first!, "todo")).toBeUndefined()
    expect(first!.system).not.toContain(LINE)
    expect(first!.system).not.toContain("`todo`")
    expect(named(first!, "tool_search")?.description).not.toMatch(/\btodo\b/)
  })

  test("minimalist cannot find todo with tool_search either: the tool belongs to balanced", async () => {
    const requests = await session("minimalist", [callTool("tool_search", { query: "todo task list plan" }), stop("done")])
    const result = requests[1]!.messages.find((message) => message.role === "tool" && message.name === "tool_search")
    expect(result && "output" in result ? result.output : "").not.toContain("\"todo\"")
    expect(named(requests[1]!, "todo")).toBeUndefined()
  })

  test("visible_plan off in balanced: todo goes back behind tool_search and the line goes with it", async () => {
    const [first] = await session("balanced", [stop("ok")], { features: { visible_plan: false } })
    expect(named(first!, "todo")).toBeUndefined()
    expect(first!.system).not.toContain(LINE)
  })

  test("the line sits right before the capability line in focus, guide and full; minimal and custom leave it out", () => {
    const dir = temp(), root = temp()
    const parts = [
      { id: "base", label: "base", text: "base" },
      visiblePlanPart({ listed: ["read", "todo"], deferred: [] }),
      { id: "capabilities-index", label: "MendCode capabilities", text: "MendCode tools listed here: todo." },
      { id: "memory", label: "memory", text: "- [x] remembered" },
    ]
    const ids = (mode: "minimal" | "focus" | "guide" | "full" | "custom") => composePromptParts(dir, root, parts, { mode }).parts.map((part) => part.id)
    for (const mode of ["focus", "guide", "full"] as const) expect(ids(mode).slice(-3)).toEqual(["visible-plan", "capabilities-index", "memory"])
    for (const mode of ["minimal", "custom"] as const) expect(ids(mode)).not.toContain("visible-plan")
    expect(visiblePlanPart({ listed: ["read"], deferred: ["todo"] }).text).toBe("")
    expect(visiblePlanPart(undefined).text).toBe("")
  })

  test("the lines stay one sentence each", () => {
    expect(LINE.length).toBeLessThanOrEqual(200)
    expect(visiblePlanText().harness.length).toBeLessThanOrEqual(200)
    expect(visiblePlanText().harness).toContain("pins")
  })
})
