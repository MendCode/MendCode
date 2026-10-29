import type { SessionEvent } from "@mendcode/protocol"
import { createIdFactory } from "@mendcode/protocol"
import { GRAPH_MAP_RENDER } from "./tool-cards-session"

/**
 * The owner's real full-view session as a fixture: one turn of an agent checking `mendcode docs`, in the order the screenshots
 * show it (code map, skill load, a failed shell, a glob, a sentence, shells, reads, greps, a web search, a thought, a patch, a
 * unknown skill and a refused packages call, a python heredoc, the final answer). Every text is shaped like what the tool returns.
 * Shared by the density tests and `scripts/render-density-frames.ts`.
 */
const ids = createIdFactory()
export const DENSITY_NOW = new Date(2026, 9, 8, 15, 40).getTime()

const numbered = (lines: string[], from = 1) => lines.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join("\n")

export const DOC_TOPICS = [
  "keys rebind keyboard shortcuts (keybindings.json, /keymap)",
  "mcp connect an MCP server (mcp.json, mcp add, OAuth)",
  "layout move panels, the sidebar and the prompt",
  "models pick, add and price a model",
  "packages install, write and publish packages",
  "prompt-modes plan, build and custom prompt modes",
  "secrets keep keys out of the transcript",
  "themes colors, markdown colors and contrast",
  "tools what the agent may run and how it shows",
  "views replace how any part of the terminal is drawn",
  "extensions terminal extensions, hooks and slots",
  "sessions list, resume, fork and export",
]

const FAILED_DOCS_COMMAND = "mendcode docs packages && mendcode docs prompt-modes && mendcode docs layout && mendcode docs extensions"
const FAILED_DOCS_OUTPUT = [
  "mendcode docs: unknown topic 'packages'",
  ...Array.from({ length: 37 }, (_, i) => `  note ${i + 1}: topics are the file names under docs/ without the extension`),
  "Topics:",
  ...DOC_TOPICS,
].join("\n")

const WC_LINES = Array.from({ length: 82 }, (_, i) => `  ${String(120 + i * 7).padStart(5)} docs/${["views", "layout", "customize", "packages", "secrets", "sessions", "tools", "themes"][i % 8]}${i >= 8 ? `-${Math.floor(i / 8)}` : ""}.md`)

const PACKAGES_DOC = Array.from({ length: 54 }, (_, i) => (i === 0 ? "# Packages" : i % 9 === 0 ? `## Section ${i / 9}` : i % 9 === 1 ? "" : `Packages line ${i}: a package is a folder with a manifest and optional extensions, views and skills.`))
const EXTENSIONS_DOC = Array.from({ length: 28 }, (_, i) => (i === 0 ? "# Extensions" : i % 7 === 0 ? `## Part ${i / 7}` : i % 7 === 1 ? "" : `Extension line ${i}: terminal extensions load from the data dir or a trusted project.`))

const GREP_PACKAGES = [
  "docs/packages.md:3:A package is a folder with a manifest.",
  "docs/packages.md:12:mendcode package new writes two views to start from.",
  "docs/views.md:44:A package that wants to own the look lists its views in activate.views.",
  "docs/customize.md:61:Packages can ship themes and views.",
  "docs/customize.md:140:Install a package from the marketplace page.",
  "docs/layout.md:77:Package panels sit in the right slot.",
  "docs/secrets.md:9:Packages never read the secrets store.",
  "docs/sessions.md:31:Exports record the package that owned the look.",
  "docs/tools.md:18:Package tools appear under their package name.",
  "docs/themes.md:5:A package theme is a theme file in extensions/.",
]

const GREP_ONE = ["apps/cli/src/docs-commands.ts:41:const TOPICS = loadTopics(docsDir)", "apps/cli/src/docs-commands.ts:88:export function docsTopic(name: string) {"]
const GREP_TWO = ["apps/cli/src/docs-run.ts:12:import { docsTopic } from \"./docs-commands\"", "apps/cli/src/docs-run.ts:57:  const topic = docsTopic(args[0])", "apps/cli/src/docs-live.ts:20:// topics are read once per run", "apps/cli/test/docs.test.ts:8:expect(docsTopic(\"packages\")).toBeDefined()"]

const GLOB_DOCS = Array.from({ length: 81 }, (_, i) => `docs/${["guides", "reference", "specs", "notes"][i % 4]}/${["views", "layout", "customize", "packages", "secrets", "sessions", "tools", "themes", "models", "keys"][i % 10]}-${i}.md`)
const GLOB_TESTS = [
  ...["docs", "docs-live", "docs-commands", "docs-run", "package-scaffold", "package-file-command", "package-args", "views-docs", "customize-docs"].map((name) => `apps/cli/test/${name}.test.ts`),
  ...["manifest", "install", "publish", "resolve", "scan", "tree", "budget", "owner", "lock", "extensions"].map((name) => `packages/packages/test/${name}.test.ts`),
]

const WEB_RESULTS = ["1. Bun test runner - Bun docs", "2. Writing tests - Bun", "3. Snapshot testing in Bun", "4. bun:test mocking", "5. Lifecycle hooks - Bun", "6. Bun test reporters", "7. Test coverage - Bun", "8. Migrating from Jest - Bun"]

const DOCS_JSON = (() => {
  const lines = ["{", "  \"topics\": ["]
  for (let i = 0; i < 1150; i++) lines.push(`    { "name": "topic-${i}", "file": "docs/topic-${i}.md", "lines": ${100 + i} },`)
  lines.push("  ],", "  \"count\": 1150", "}")
  return lines.join("\n")
})()

const PATCH = [
  "*** Update File: apps/cli/src/docs-commands.ts",
  "@@ -38,6 +38,8 @@",
  " const TOPICS = loadTopics(docsDir)",
  " ",
  "-export const ORDER = [\"keys\", \"mcp\"]",
  "+export const ORDER = [\"keys\", \"mcp\", \"packages\"]",
  "+// packages sits after mcp: both are about what the terminal can load",
  " export function docsTopic(name: string) {",
  "   return TOPICS.get(name)",
  " }",
].join("\n")

const BUN_PASS = ["bun test v1.3.13 (bf2e2cec)", "", "· 233 passing test line(s) omitted", "", " 241 pass", " 0 fail", " 1204 expect() calls", "Ran 241 tests across 9 files. [412.00ms]"].join("\n")

const PACKAGES_TREE = JSON.stringify({ name: "acme-theme", version: "0.3.1", extensions: ["theme.ts", "view-footer.ts"], files: 14 }, null, 2)

const PYTHON_OUTPUT = ["topics: 24", "with packages doc: 23", "missing: ['prompt-modes']", "longest: views (348 lines)", "shortest: keys (41 lines)"].join("\n")

export type DensityTool = { itemId: string; title: string; failed: boolean }
export type DensitySession = { events: SessionEvent[]; turnId: string; tools: DensityTool[]; failed: string[] }

/** The events of one turn holding only the tool calls `keep` accepts (the turn's start, those calls, its end): a card on its own. */
export function densitySubset(session: DensitySession, keep: (tool: DensityTool) => boolean): SessionEvent[] {
  const items = new Set(session.tools.filter(keep).map((tool) => tool.itemId))
  return session.events.filter((event) => event.type === "turn.started" || event.type === "turn.completed" || items.has((event as { itemId?: string }).itemId ?? ""))
}

/** The session's events for `sessionId`; `tools` are the tool cards in order, `failed` the ids of those that failed. */
export function densitySession(sessionId: string): DensitySession {
  let seq = 0
  let clock = DENSITY_NOW - 300_000
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 150) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const turnId = ids("turn")
  const tools: DensityTool[] = []
  const failed: string[] = []
  const tool = (title: string, text: string, options: { status?: string; input?: object; meta?: Record<string, unknown>; render?: unknown; injected?: boolean; took?: number } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title, ...(options.injected ? { injected: true } : {}) } })
    emit({ type: "item.completed", itemId, status: options.status ?? "ok", text, ...(options.input ? { toolInput: JSON.stringify(options.input) } : {}), ...(options.meta ? { meta: options.meta } : {}), ...(options.render ? { render: options.render } : {}) }, options.took ?? 400)
    tools.push({ itemId, title, failed: options.status === "error" })
    if (options.status === "error") failed.push(itemId)
    return itemId
  }
  const message = (kind: "user_message" | "agent_message", text: string) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind })
    emit({ type: "item.completed", itemId, status: "ok", text })
    return itemId
  }
  const thought = (text: string, took = 1500) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "reasoning" })
    emit({ type: "item.delta", itemId, text })
    emit({ type: "item.completed", itemId, status: "ok" }, took)
  }

  emit({ type: "turn.started", turnId, queueId: ids("queue") })
  message("user_message", "Check that `mendcode docs` covers every chapter and fix the gaps you find.")
  tool("graph_map", "7 dirs", { render: GRAPH_MAP_RENDER, injected: true, meta: { files: 2360, symbols: 9000, directories: 7, hubs: 20 } })
  tool("skill: whittle", "Loaded skill whittle (4 files)\n\nWhittle trims a change to what the request needs.", { meta: {} })
  tool(`shell: ${FAILED_DOCS_COMMAND}`, FAILED_DOCS_OUTPUT, { status: "error", meta: { exitCode: 2, durationMs: 1_800 } })
  tool("glob: docs", GLOB_TESTS.join("\n"), { input: { pattern: "**/*docs*.test.ts" }, meta: { matches: GLOB_TESTS.length } })
  message("agent_message", "The docs index lists 24 topics and the packages one is missing from the extension chapter, so I will read the tree before touching anything.")
  tool("shell: wc -l docs/*.md | sort -n", WC_LINES.join("\n"), { meta: { exitCode: 0, durationMs: 90 } })
  tool("read: docs/packages.md", numbered(PACKAGES_DOC), { meta: { lines: PACKAGES_DOC.length } })
  tool("grep: package", GREP_PACKAGES.join("\n"), { input: { pattern: "package" }, meta: { matches: GREP_PACKAGES.length } })
  tool("glob: docs", GLOB_DOCS.join("\n"), { input: { pattern: "docs/**/*.md" }, meta: { matches: GLOB_DOCS.length } })
  tool("web_search: bun test docs", ["8 results", ...WEB_RESULTS].join("\n"), { input: { query: "bun test docs" }, meta: { results: 8 }, took: 1_600 })
  tool("read: docs/extensions.md", numbered(EXTENSIONS_DOC), { meta: { lines: EXTENSIONS_DOC.length } })
  tool("grep: TOPICS", GREP_ONE.join("\n"), { input: { pattern: "TOPICS" }, meta: { matches: GREP_ONE.length } })
  tool("grep: docsTopic", GREP_TWO.join("\n"), { input: { pattern: "docsTopic" }, meta: { matches: GREP_TWO.length } })
  tool("shell: mendcode docs --json", DOCS_JSON, { meta: { exitCode: 0, durationMs: 380 } })
  thought("Order of the topics\nThe index is built from ORDER, so packages has to be added there; the file itself exists.")
  tool("apply_patch: apps/cli/src/docs-commands.ts", PATCH, { meta: { files: 1 } })
  tool("shell: bun test apps/cli/test/docs.test.ts", BUN_PASS, { meta: { exitCode: 0, durationMs: 12_400 }, took: 12_400 })
  tool("packages: list", PACKAGES_TREE, { meta: {} })
  tool("grep: ORDER", ["apps/cli/src/docs-commands.ts:39:export const ORDER = [\"keys\", \"mcp\", \"packages\"]"].join("\n"), { input: { pattern: "ORDER" }, meta: { matches: 1 } })
  tool("skill: whittle", "Unknown skill \"whittle\". Available: build, fix, review, rush.", { status: "error", meta: {} })
  tool("packages: inspect acme-theme", "[PACKAGES]: Package tree exceeds approval budget", { status: "error", meta: {} })
  thought("Count the topics\nA short script over docs/ tells me which chapter has no topic.")
  tool("shell: python3 - <<'PY' ... PY", PYTHON_OUTPUT, { meta: { exitCode: 0, durationMs: 220 } })
  tool("grep: prompt-modes", ["docs/prompt-modes.md:1:# Prompt modes", "apps/cli/src/docs-commands.ts:39:export const ORDER = [\"keys\", \"mcp\", \"packages\"]"].join("\n"), { input: { pattern: "prompt-modes" }, meta: { matches: 2 } })
  message("agent_message", "`mendcode docs` now lists packages after mcp. The only chapter without a topic is prompt-modes; its file exists, so it needs an entry in ORDER next.")
  emit({ type: "turn.completed", turnId })
  return { events, turnId, tools, failed }
}
