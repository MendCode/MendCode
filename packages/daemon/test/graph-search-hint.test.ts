import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GraphIndexMode } from "@mendcode/codegraph"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { hostInstructions } from "../src/host-mcp"
import { createLazyCodegraph } from "../src/lazy-codegraph"
import { graphLocateText } from "../src/prompt-guidance"
import { composePromptParts, createPromptModes, graphLocatePart } from "../src/prompt-modes"
import { TIER_BUNDLES } from "@mendcode/protocol/wire"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-graph-search-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const FILES: Record<string, string> = {
  "src/a.ts": 'import { helper } from "./b"\n\nexport function main(): void {\n  helper()\n}\n',
  "src/b.ts": 'export function helper() {\n  return "x"\n}\n',
  "src/c.ts": 'import { main } from "./a"\n\nexport function entry() {\n  main()\n}\n',
}
function project() {
  const root = temp()
  for (const [file, text] of Object.entries(FILES)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text) }
  return root
}

const HEADER = "[code graph] Where the searched names are declared and who calls them (graph_find and graph_callers give more):"
const BLOCK = [HEADER, "helper  function  src/b.ts:1  export  1 caller", "  called by main  src/a.ts:3"].join("\n")

/** The daemon's code graph as main.ts builds it, over a cache folder of the test; `mode` is the project's `/graph` switch. */
function codegraph(cacheDir: string, { on = true, mode = "on" as GraphIndexMode } = {}) {
  const graph = createLazyCodegraph({ cacheDir, publish() {}, mode: () => mode, enabled: () => false, searchOn: () => on, searchBudgetMs: 5000, log() {} })
  cleanup.push(() => graph.autopilot.stop())
  return graph
}
async function index(cacheDir: string, root: string) {
  const find = codegraph(cacheDir).tools.find((tool) => tool.name === "graph_find")!
  expect((await find.execute({ query: "helper" }, { cwd: root, signal: new AbortController().signal })).isError).toBe(false)
}

/** One native turn whose model makes these calls with the real `shell` and `grep`, and what each call returned to it. */
async function results(root: string, graph: ReturnType<typeof codegraph>, calls: Array<{ name: string; args: unknown }>) {
  const { provider, requests } = scriptedProvider([...calls.map((call) => callTool(call.name, call.args)), stop("done")])
  const engine = createNativeEngine({ provider, tools: BUILTIN_TOOLS, history: memoryHistory(), cwdFor: () => root, system: () => "sys", compactionPrompt: "summarize", searchHint: graph.searchHint })
  const run = turn({ text: "where is helper?", mode: () => "full" })
  await engine.runTurn(run.input)
  const outputs = requests.at(-1)!.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))
  const hinted = run.events.flatMap((event) => (event.type === "item.completed" && event.meta?.graphHint !== undefined ? [event.meta.graphHint] : []))
  return { outputs, hinted }
}

describe("a native text search in a project with a code graph", () => {
  test("a shell grep and the grep tool carry the graph's answer above their own output, which is unchanged", async () => {
    const cacheDir = temp(), root = project()
    await index(cacheDir, root)
    // A daemon started after the index was built: the graph is only in its cache file.
    const graph = codegraph(cacheDir)
    const plain = await results(root, codegraph(cacheDir, { on: false }), [{ name: "shell", args: { command: "grep -rn helper src" } }, { name: "grep", args: { pattern: "helper" } }])
    const { outputs, hinted } = await results(root, graph, [{ name: "shell", args: { command: "grep -rn helper src" } }, { name: "grep", args: { pattern: "helper" } }, { name: "shell", args: { command: "ls src" } }, { name: "grep", args: { pattern: "return .x" } }])
    expect(plain.outputs.every((output) => !output.includes("[code graph]"))).toBe(true)
    expect(plain.hinted).toEqual([])
    expect(outputs[0]).toBe(`${BLOCK}\n\n${plain.outputs[0]}`)
    expect(outputs[1]).toBe(`${BLOCK}\n\n${plain.outputs[1]}`)
    expect(plain.outputs[0]).toContain("src/b.ts:1:export function helper() {")
    // A command that is no search and a pattern that names no symbol get nothing.
    expect(outputs[2]).not.toContain("[code graph]")
    expect(outputs[3]).not.toContain("[code graph]")
    // What a read-only query counts (docs/code-graph.md): the calls that carried a block, with the identifiers answered.
    expect(hinted).toEqual([1, 1])
  })

  test("a project with no index gets the search's own output only, and none is built", async () => {
    const cacheDir = temp(), root = project()
    const { outputs, hinted } = await results(root, codegraph(cacheDir), [{ name: "shell", args: { command: "grep -rn helper src" } }, { name: "grep", args: { pattern: "helper" } }])
    expect(outputs).toHaveLength(2)
    for (const output of outputs) { expect(output).toContain("helper"); expect(output).not.toContain("[code graph]") }
    expect(hinted).toEqual([])
    expect(readdirSync(cacheDir)).toEqual([])
  })

  test("a project switched off with /graph off gets nothing, though its cache file exists", async () => {
    const cacheDir = temp(), root = project()
    await index(cacheDir, root)
    const { outputs } = await results(root, codegraph(cacheDir, { mode: "off" }), [{ name: "shell", args: { command: "grep -rn helper src" } }])
    expect(outputs[0]).not.toContain("[code graph]")
  })
})

describe("where to look for a symbol", () => {
  const line = graphLocateText().native
  const compose = (tier: keyof typeof TIER_BUNDLES, listed: string[]) => {
    const dir = temp(), root = temp()
    createPromptModes(dir).set(root, { mode: TIER_BUNDLES[tier].promptMode })
    return composePromptParts(dir, root, [{ id: "base", label: "base prompt", text: "base" }, graphLocatePart({ listed, deferred: [] } as unknown as Parameters<typeof graphLocatePart>[0])]).parts.map((part) => part.text).join("\n\n")
  }

  test("the full tier's prompt says it once while graph_find is listed, and balanced too", () => {
    expect(line).toBe("To locate a function, class or symbol, call graph_find first; call graph_callers before you change a symbol. A `[code graph]` block above a search result is the graph's answer for the names you searched: use its file:line instead of searching again.")
    for (const tier of ["full", "balanced"] as const) expect(compose(tier, ["shell", "graph_find", "graph_callers"]).split(line).length - 1).toBe(1)
  })

  test("a session without the graph's lookup tool, and the minimalist tier, carry no line", () => {
    expect(compose("full", ["shell", "grep"])).not.toContain("graph_find first")
    expect(compose("minimalist", ["shell", "graph_find"])).not.toContain("graph_find first")
  })

  test("Claude Code and Codex are told too while MendCode serves them the graph tools; only Claude Code hears of the block", () => {
    const served = (...names: string[]) => names.map((name) => ({ name, description: name, parameters: {} }))
    const tools = served("graph_find", "graph_callers")
    const claude = hostInstructions(tools, "claude"), codex = hostInstructions(tools, "codex")
    for (const text of [claude, codex]) expect(text).toContain("To locate a function, class or symbol, call mcp__mendcode__graph_find first; call mcp__mendcode__graph_callers before you change a symbol.")
    expect(claude).toContain("A `[code graph]` block added to a Grep or shell search")
    expect(codex).not.toContain("[code graph]")
    expect(hostInstructions(served("webfetch"))).not.toContain("graph_find first")
  })
})
