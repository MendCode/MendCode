import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCodeGraphTools } from "@mendcode/codegraph"
import { createClient } from "@mendcode/client"
import { createNativeEngine, loadSystemPrompt, memoryHistory } from "@mendcode/engine-native"
import { createFauxEngine } from "@mendcode/engine-faux"
import { TIER_BASELINE_TOKENS, TIER_BUNDLES, effectiveSettings, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import { BUILTIN_TOOLS, browserTool, createComputerTools, defineTool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { adaptTool, toolProblem } from "../src/extensions/tool-adapter"
import { composePromptParts, createPromptModes } from "../src/prompt-modes"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-tier-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const fakeTool = (name: string, tier?: Tier) => defineTool({
  name, description: `fake ${name}`, permission: "read", args: z.object({}), ...(tier ? { tier } : {}),
  execute: async () => ({ output: "ran", title: name, isError: false, truncated: false }),
})

/** What a fresh session sends before the user types anything: the system prompt and every tool definition the tier offers. */
async function baseline(tier: Tier | undefined, extra: { projectTools?: ReturnType<typeof fakeTool>[]; settings?: TierSettings } = {}) {
  const dir = temp(), project = temp()
  const packaged = await loadSystemPrompt()
  if (tier) createPromptModes(dir).set(project, { mode: TIER_BUNDLES[tier].promptMode })
  const { provider, requests } = scriptedProvider([stop("ok")])
  const settings: TierSettings = { ...(tier ? { tier } : {}), experimental: { tool_discovery: false }, ...(extra.settings ?? {}) }
  const engine = createNativeEngine({
    provider, history: memoryHistory(), compactionPrompt: "Summarize", cwdFor: () => project, subagents: true,
    tools: [...BUILTIN_TOOLS, ...createCodeGraphTools({ cacheDir: path.join(dir, "codegraph") }), ...createComputerTools(), browserTool],
    projectTools: async () => extra.projectTools ?? [fakeTool("mcp__docs__search"), fakeTool("mcp__docs__read")],
    system: (root) => composePromptParts(dir, root, [{ id: "base", label: "base prompt", text: packaged(root) }]).parts.map((part) => part.text).join("\n\n"),
    permissionPolicy: () => effectiveSettings(settings),
  })
  expect(await engine.runTurn(turn({ text: "hello", mode: () => "full" }).input)).toEqual({ status: "ok" })
  const request = requests[0]!
  const names = request.tools.map((tool) => tool.name)
  // A character count over four is the usual cheap estimate of tokens; the budget is about growth, not exact cost.
  const toolTokens = Math.ceil(JSON.stringify(request.tools).length / 4)
  const systemTokens = Math.ceil(request.system.length / 4)
  return { names, systemTokens, toolTokens, total: systemTokens + toolTokens }
}

/**
 * Stored budgets (estimated tokens of system prompt plus tool definitions) per tier, for the pool of tools above. A change that
 * grows a tier past its budget fails here: raise the number on purpose, in review, or move the cost to a higher tier.
 */
const BUDGET: Record<Tier, number> = TIER_BASELINE_TOKENS

describe("per-tier baseline budget", () => {
  test("full-tier MCP defaults to discovery and reduces the tool token estimate", async () => {
    const direct = await baseline("full")
    const deferred = await baseline("full", { settings: { experimental: {} } })
    expect(deferred.names).toContain("tool_search")
    expect(deferred.names).not.toContain("mcp__docs__search")
    expect(direct.toolTokens - deferred.toolTokens).toBeGreaterThan(500)
    expect(deferred.total).toBeLessThanOrEqual(BUDGET.full)
    console.info(`M7 tool tokens: direct=${direct.toolTokens} deferred=${deferred.toolTokens} delta=${direct.toolTokens - deferred.toolTokens}`)
  })
  test("each tier stays inside its stored budget and the tiers grow in order", async () => {
    const measured = { minimalist: await baseline("minimalist"), balanced: await baseline("balanced"), full: await baseline("full") }
    for (const tier of ["minimalist", "balanced", "full"] as const) expect(measured[tier].total).toBeLessThanOrEqual(BUDGET[tier])
    expect(measured.minimalist.total).toBeLessThan(measured.balanced.total)
    expect(measured.balanced.total).toBeLessThan(measured.full.total)
  })

  test("minimalist offers no MCP, code graph, sub-agent, computer or browser tools; balanced adds graph and task only", async () => {
    const minimalist = (await baseline("minimalist")).names
    for (const name of ["read", "write", "edit", "shell", "grep"]) expect(minimalist).toContain(name)
    for (const name of ["graph_find", "graph_map", "code_search", "task", "mcp__docs__search", "computer_capture", "browser"]) expect(minimalist).not.toContain(name)
    const balanced = (await baseline("balanced")).names
    for (const name of ["graph_find", "graph_callers", "graph_file_api", "graph_map", "code_search", "task"]) expect(balanced).toContain(name)
    for (const name of ["mcp__docs__search", "mcp__docs__read", "computer_capture", "browser"]) expect(balanced).not.toContain(name)
    const full = (await baseline("full")).names
    for (const name of ["graph_find", "task", "mcp__docs__search", "browser"]) expect(full).toContain(name)
    // Computer control is opt-in: no tier offers its tools.
    expect(full).not.toContain("computer_capture")
  })

  test("no tier set offers everything, as before tiers existed", async () => {
    const legacy = await baseline(undefined)
    const full = await baseline("full")
    expect(legacy.names.sort()).toEqual(full.names.sort())
  })

  test("a feature override brings a tool back without changing the rest of the tier", async () => {
    const withMcp = (await baseline("minimalist", { settings: { features: { mcp: true } } })).names
    expect(withMcp).toContain("mcp__docs__search")
    expect(withMcp).not.toContain("graph_find")
    const noGraph = (await baseline("full", { settings: { features: { codegraph: false } } })).names
    expect(noGraph).not.toContain("graph_find")
    expect(noGraph).toContain("task")
    const userTool = (await baseline("minimalist", { settings: { tools: { "graph_map": true } } })).names
    expect(userTool).toContain("graph_map")
  })

  test("a tool that declares a tier is offered only from that tier", async () => {
    const tools = [fakeTool("ext_lint", "balanced"), fakeTool("ext_any"), fakeTool("ext_deep", "full")]
    expect((await baseline("minimalist", { projectTools: tools })).names.filter((name) => name.startsWith("ext_"))).toEqual(["ext_any"])
    expect((await baseline("balanced", { projectTools: tools })).names.filter((name) => name.startsWith("ext_")).sort()).toEqual(["ext_any", "ext_lint"])
    expect((await baseline("full", { projectTools: tools })).names.filter((name) => name.startsWith("ext_")).sort()).toEqual(["ext_any", "ext_deep", "ext_lint"])
    expect((await baseline(undefined, { projectTools: tools })).names.filter((name) => name.startsWith("ext_"))).toHaveLength(3)
  })

  test("a denied tool is refused if the model calls it anyway", async () => {
    const { provider, requests } = scriptedProvider([callTool("mcp__docs__search", {}), stop("done")])
    const engine = createNativeEngine({
      provider, history: memoryHistory(), compactionPrompt: "Summarize", cwdFor: () => "/repo", system: () => "sys", tools: [],
      projectTools: async () => [fakeTool("mcp__docs__search")], permissionPolicy: () => effectiveSettings({ tier: "balanced" } as TierSettings),
    })
    await engine.runTurn(turn({ text: "go" }).input)
    expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("mcp__docs__search")
    expect(requests[1]!.messages.some((message) => message.role === "tool" && message.output.includes("unknown tool"))).toBe(true)
  })
})

describe("extension tools declare a tier", () => {
  const base = { name: "lint", description: "lint", parameters: {}, permission: "read" as const, execute: async () => ({ output: "ok" }) }

  test("the tier is validated and reaches the engine tool", () => {
    expect(toolProblem({ ...base, tier: "huge" })).toContain("tier must be minimalist, balanced or full")
    expect(toolProblem({ ...base, tier: "balanced" })).toBeUndefined()
    expect(toolProblem(base)).toBeUndefined()
    expect(adaptTool({ tool: { ...base, tier: "full" }, sessionId: "s" }).tier).toBe("full")
    expect(adaptTool({ tool: base, sessionId: "s" }).tier).toBeUndefined()
  })
})

describe("safe mode in the daemon", () => {
  async function boot(options: { safeMode?: boolean }) {
    const dir = temp(), project = temp()
    mkdirSync(path.join(dir, "packages", "demo", "skills", "hello"), { recursive: true })
    writeFileSync(path.join(dir, "packages", "demo", "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi\n---\nSay hi.\n")
    let layers: ((directory: string) => Array<{ pkg?: string; source: string }>) | undefined
    const daemon = await startDaemon({
      dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, log: () => {},
      ...(options.safeMode ? { safeMode: true, extensionsEnabled: false, shellHooksEnabled: false } : {}),
      engine: ({ clock, extensionLayers }) => { layers = extensionLayers; return createFauxEngine({ clock, deltaMs: 1 }) },
    })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "tier-test" })
    await client.connect()
    cleanup.push(() => client.close())
    return { client, layers: () => layers!(project), project }
  }

  test("daemon.info reports it and installed packages are dropped from every layer", async () => {
    const safe = await boot({ safeMode: true })
    expect(await safe.client.send({ type: "daemon.info" })).toMatchObject({ ok: true, result: { safeMode: true, extensionsEnabled: false } })
    expect(safe.layers().some((layer) => layer.pkg === "demo")).toBe(false)
    expect(safe.layers().some((layer) => layer.pkg === "builtin")).toBe(true)
    const normal = await boot({})
    const info = await normal.client.send({ type: "daemon.info" })
    expect(info.ok && info.result?.safeMode).toBeUndefined()
    expect(normal.layers().some((layer) => layer.pkg === "demo")).toBe(true)
  })

  test("tier and features are saved by the daemon, validated, and refused for an unknown value", async () => {
    const { client } = await boot({})
    expect(await client.send({ type: "settings.set", patch: { tier: "balanced", features: { mcp: true } } })).toMatchObject({ ok: true, result: { settings: { tier: "balanced", features: { mcp: true } } } })
    expect(await client.send({ type: "settings.set", patch: { tier: "tiny" } as never })).toMatchObject({ ok: false })
    expect(await client.send({ type: "settings.set", patch: { tier: null, features: null } })).toMatchObject({ ok: true })
    const settings = await client.send({ type: "settings.get" })
    expect(settings.ok && settings.result?.settings).toEqual({})
  })
})
