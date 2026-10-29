import { createIdFactory, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { createTranscript, type PresentationMode } from "../src/view/transcript"

/**
 * A realistic faux session with one call of every kind a tool card draws (list, glob, reads, grep, shells, edit, write,
 * graph tools, web, sub-agent, MCP), shared by the tool-card tests and the frame dump (`bun apps/cli/test/tool-cards-frames.ts`).
 * Every text is shaped like what the real tool returns.
 */
const ids = createIdFactory()
const sessionId = ids("session")
export const SESSION_NOW = new Date(2026, 9, 5, 11, 30).getTime()

const numbered = (lines: string[], from = 1) => lines.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join("\n")

const README = [
  "# MendCode",
  "",
  "A terminal coding agent. One daemon owns the sessions; the TUI, the CLI and editors attach to it.",
  "",
  "## Install",
  "",
  "```sh",
  "bun install",
  "bun run build",
  "```",
  "",
  "## Layout",
  "",
  "- `apps/cli` the terminal client and the `mendcode` command",
  "- `packages/daemon` sessions, REST and the event stream",
  "- `packages/engine-native` the agent loop and its tools",
  "- `packages/codegraph` the symbol graph behind the graph tools",
  ...Array.from({ length: 106 }, (_, i) => `- reference line ${i + 1}: details that are not needed to know what happened`),
]

const TRANSCRIPT_SLICE = [
  "  /** How much of a tool's card shows: a card the reader opened or closed keeps that; else ctrl+o and the view decide. */",
  "  function levelOf(block: Block): ToolLevel {",
  "    const own = toolOpen.get(block.itemId)",
  "    if (own) return \"full\"",
  "    if (own === undefined && toolOutput === \"auto\" && toolsOpenAll) return \"full\"",
  "    if (toolOutput === \"collapsed\") return \"summary\"",
  "    return toolOutput === \"expanded\" || mode === \"full\" ? \"preview\" : \"summary\"",
  "  }",
  "",
  "  /** A click on a tool card's rows: open or close the card, turn to its next page, or open the folded run it leads. */",
  "  function toggleTool(block: Block, fold: number) {",
  "    const id = block.itemId",
  "    if (fold === FOLD_RUN) {",
  "      if (!openRuns.delete(id)) openRuns.add(id)",
  "    } else if (fold === FOLD_PAGE) {",
  "      toolPage.set(id, (toolPage.get(id) ?? 0) + 1)",
  "    } else {",
  "      toolOpen.set(id, !(levelOf(block) === \"full\"))",
  "      toolPage.delete(id)",
  "    }",
  "    cache.delete(id)",
  "  }",
  ...Array.from({ length: 29 }, (_, i) => `  const step${i} = steps[${i}] ?? undefined // slice line ${i}`),
]

const GREP_ROWS = [
  "apps/cli/src/view/transcript.ts:11:import { FOLD_CARD, FOLD_PAGE, FOLD_RUN, isCompactTool, parseToolTitle, renderToolCard, SPINNER_FRAMES } from \"./tool-card\"",
  "apps/cli/src/view/transcript.ts:595:        return renderToolCard({",
  "apps/cli/src/view/transcript.ts:640:    // renderToolCard is pure: rows in, rows out.",
  "apps/cli/src/view/tool-card.ts:264:export function renderToolCard(input: ToolCardInput): Line[] {",
  "apps/cli/src/view/tool-card.ts:276:  // the card of a task adds its own footer to what renderToolCard returns",
  "apps/cli/src/view/tool-card.ts:301:  const rows = cardRows(input) // renderToolCard wraps this",
  "apps/cli/test/tool-output.test.ts:5:import { renderToolCard } from \"../src/view/tool-card\"",
  "apps/cli/test/tool-output.test.ts:88:    const rows = renderToolCard({ title: \"read: a.ts\", text, status: \"ok\", width: 80 })",
  "apps/cli/test/tool-output.test.ts:131:    expect(renderToolCard({ title: \"ls: .\", text, status: \"ok\", width: 80 })).toHaveLength(2)",
  "apps/cli/test/code-map.test.ts:8:import { renderToolCard } from \"../src/view/tool-card\"",
  "apps/cli/test/render-spec.test.ts:4:import { renderToolCard } from \"../src/view/tool-card\"",
  "apps/cli/test/render-spec.test.ts:40:  const rows = renderToolCard({ title: \"graph_map\", text: \"\", status: \"ok\", width: 100, expanded: true, frame: 0, tailLines: 4 })",
]

const BUN_TEST = [
  "bun test v1.3.13 (bf2e2cec)",
  "",
  "· 233 passing test line(s) omitted",
  "",
  " 241 pass",
  " 0 fail",
  " 1204 expect() calls",
  "Ran 241 tests across 9 files. [412.00ms]",
].join("\n")

const BUN_FAIL = [
  "bun test v1.3.13 (bf2e2cec)",
  "",
  "apps/cli/test/tool-output.test.ts:",
  "· 98 passing test line(s) omitted",
  "187 |     const text = view(events).text()",
  "188 |     expect(text).toEqual([",
  "189 |       \"     □ Read README.md · 126 lines\",",
  "                       ^",
  "error: expect(received).toEqual(expected)",
  "",
  "- Expected  - 1",
  "+ Received  + 1",
  "",
  "(fail) reading tools in balanced: one line each > Read says what it found",
  "",
  " 98 pass",
  " 1 fail",
  " 412 expect() calls",
  "Ran 99 tests across 1 file. [203.00ms]",
].join("\n")

const EDIT_DIFF = [
  "@@ -118,3 +118,4 @@",
  "-    const open = levelOf(block) === \"full\"",
  "-    toolOpen.set(id, !open)",
  "-    toolPage.delete(id)",
  "+    const open = levelOf(block) === \"full\" && toolOpen.get(id) !== false",
  "+    toolOpen.set(id, !open)",
  "+    toolPage.delete(id)",
  "+    toolRows.delete(id)",
].join("\n")

const EDIT_SMALL = ["@@ -22,1 +22,1 @@", "-const DIFF_ROWS = 16", "+const DIFF_ROWS = 12"].join("\n")

const WEBFETCH = [
  "# Writing tests",
  "",
  "Bun ships a fast, built-in, Jest-compatible test runner. Tests are executed with the Bun runtime.",
  "",
  "```ts",
  "import { expect, test } from \"bun:test\"",
  "",
  "test(\"2 + 2\", () => {",
  "  expect(2 + 2).toBe(4)",
  "})",
  "```",
  ...Array.from({ length: 60 }, (_, i) => `Documentation paragraph ${i + 1} about writing and running tests.`),
].join("\n")

const LINEAR_ISSUE = JSON.stringify(Object.fromEntries(["id", "identifier", "title", "description", "priority", "state", "assignee", "team", "project", "labels", "estimate", "createdAt", "updatedAt", "url"].map((key, i) => [key, `value ${i}`])), null, 2)

const ROOT_ENTRIES = [".agents/", ".claude/", ".github/", "apps/", "benchmarks/", "docs/", "editors/", "examples/", "graft/", "packages/", "scripts/", "specs/", "spikes/", "task-evidence/", "templates/", "tests/", "tools/", "vendor/", ".gitignore", "LICENSE", "README.md", "THIRD_PARTY.md", "package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]

const GLOB_FILES = [
  ...["tool-output", "chat-transcript", "code-map", "presentation", "render-spec", "tool-card-sessions", "footprint", "tui-automation", "inline-mode", "commands", "palette-app", "ui", "ui-4", "tool-discovery"].map((name) => `apps/cli/test/${name}.test.ts`),
  ...["graph", "impact", "savings", "scan"].map((name) => `packages/codegraph/test/${name}.test.ts`),
]

const GRAPH_MAP_SUMMARY = "7 dirs · 2,360 files · hubs: ids 559 · textWidth 290 · createClient 211"
const HUBS = [
  ["ids", "protocol/src/ids", "559"],
  ["textWidth", "view/wrap", "290"],
  ["createClient", "client/src/client", "211"],
  ["fail", "tools/src/util", "187"],
  ["succeed", "tools/src/util", "176"],
  ["clip", "codegraph/src/tools", "143"],
]
const DIR_ROWS = ["apps/cli  812 files  ts 790, js 22", "packages/daemon  210 files  ts 210", "packages/engine-native  188 files  ts 188", "packages/tools  144 files  ts 144", "packages/codegraph  96 files  ts 96", "packages/protocol  88 files  ts 88", "packages/client  41 files  ts 41"]
const HUB_ROWS = Array.from({ length: 20 }, (_, i) => `${HUBS[i % HUBS.length]![0]}${i >= HUBS.length ? i : ""}  ${HUBS[i % HUBS.length]![1]}.ts:${10 + i}  callers:${559 - i * 17}`)

export const GRAPH_MAP_RENDER = {
  type: "stack",
  children: [
    { type: "graph", root: "MendCodeV2", title: "Project map", edges: [{ from: "MendCodeV2", to: "apps/cli", relation: "dir" }, { from: "MendCodeV2", to: "packages/daemon", relation: "dir" }, { from: "MendCodeV2", to: "packages/tools", relation: "dir" }, { from: "apps/cli", to: "textWidth", relation: "290 callers" }, { from: "packages/tools", to: "fail", relation: "187 callers" }, { from: "packages/protocol", to: "ids", relation: "559 callers" }] },
    { type: "text", text: GRAPH_MAP_SUMMARY, tone: "muted" },
    { type: "detail", at: "preview", children: [{ type: "table", columns: ["hub", "file", "callers"], rows: HUBS.map(([name, file, callers]) => [name!, file!.split("/").at(-1)!, callers!]) }] },
    { type: "detail", at: "open", children: [{ type: "text", text: "Directories", bold: true }, { type: "list", items: DIR_ROWS }, { type: "text", text: "Hub symbols", bold: true }, { type: "list", items: HUB_ROWS }] },
  ],
}

const entry = (label: string, file: string, line: number, kind = "function") => ({ label, file, line, kind })
export const CALLERS_RENDER = {
  type: "codemap",
  center: entry("renderToolCard", "apps/cli/src/view/tool-card.ts", 264),
  left: { title: "callers", flow: "in", more: 0, entries: [entry("styled", "apps/cli/src/view/transcript.ts", 447), entry("renderSpecLines", "apps/cli/src/view/render-spec.ts", 24), entry("cardFor", "apps/cli/src/ui/app/find.ts", 61)] },
  right: { title: "callees", flow: "out", more: 4, entries: [entry("cardRows", "apps/cli/src/view/tool-card.ts", 301), entry("parseToolTitle", "apps/cli/src/view/tool-card.ts", 119), entry("renderSpecLines", "apps/cli/src/view/render-spec.ts", 24), entry("shellBlock", "apps/cli/src/view/tool-card.ts", 395)] },
}

function stream() {
  let seq = 0
  let clock = SESSION_NOW - 120_000
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 100) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const turn = () => {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    return turnId
  }
  const tool = (turnId: TurnId, title: string, text: string, options: { status?: string; input?: object; meta?: Record<string, unknown>; render?: unknown; took?: number } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
    if (options.status !== "running") emit({ type: "item.completed", itemId, status: options.status ?? "ok", text, ...(options.input ? { toolInput: JSON.stringify(options.input) } : {}), ...(options.meta ? { meta: options.meta } : {}), ...(options.render ? { render: options.render } : {}) }, options.took ?? 120)
    return itemId
  }
  return { emit, turn, tool, events }
}

/** Every kind of call, one per turn so none of them folds into a run. */
export function toolCardsSession() {
  const { turn, tool, events } = stream()
  const call = (title: string, text: string, options: Parameters<typeof tool>[3] = {}) => tool(turn(), title, text, options)
  call("ls: .", ROOT_ENTRIES.join("\n"), { meta: { entries: 25 } })
  call("glob: apps/cli/test", GLOB_FILES.join("\n"), { input: { pattern: "**/*.test.ts" }, meta: { matches: GLOB_FILES.length } })
  call("read: README.md", numbered(README), { meta: { lines: README.length } })
  call("read: apps/cli/src/view/transcript.ts", `${numbered(TRANSCRIPT_SLICE, 396)}`, { input: { path: "apps/cli/src/view/transcript.ts", offset: 396, limit: TRANSCRIPT_SLICE.length }, meta: { lines: TRANSCRIPT_SLICE.length } })
  call("grep: renderToolCard", GREP_ROWS.join("\n"), { input: { pattern: "renderToolCard" }, meta: { matches: GREP_ROWS.length } })
  call("shell: bun test apps/cli/test", BUN_TEST, { meta: { exitCode: 0, durationMs: 12_400 } })
  call("edit: apps/cli/src/view/transcript.ts", EDIT_DIFF, { meta: { replacements: 1 } })
  call("edit: apps/cli/src/view/tool-card.ts", EDIT_SMALL, { meta: { replacements: 1 } })
  call("write: docs/design/tool-cards.md", "Created docs/design/tool-cards.md (4231 bytes)", { meta: { bytes: 4231, created: true } })
  call("shell: bun test apps/cli/test/tool-output.test.ts", BUN_FAIL, { status: "error", meta: { exitCode: 1, durationMs: 3_100 } })
  call("graph_map", "7 dirs", { render: GRAPH_MAP_RENDER, meta: { files: 2360, directories: 7 } })
  call("graph_callers: renderToolCard", "renderToolCard (function)", { render: CALLERS_RENDER })
  call("webfetch: https://bun.sh/docs/test/writing", WEBFETCH, { meta: { status: 200, contentType: "text/html", bytes: 48_213, finalUrl: "https://bun.sh/docs/test/writing" }, took: 1_800 })
  call("task: Review graph tool cards", "Both cards read well; the hub table should cap at six rows.", { input: { description: "Review graph tool cards", agent: "reviewer", model: "gpt-5.5" }, meta: { toolCalls: 7, durationMs: 65_000 } })
  call("mcp__linear__get_issue: MEN-482", LINEAR_ISSUE, { meta: {} })
  call("shell: bun test --watch", "bun test v1.3.13\n\napps/cli/test/tool-output.test.ts:\n(pass) reading tools\n", { status: "running" })
  return events
}

export type ToolCardsViewOptions = { mode?: PresentationMode; width?: number; height?: number; toolOutput?: string; /** The full view's `toolDensity`; these tests pin the cards of every kind, so `dense` (the whole preview) is their default. */ toolDensity?: "calm" | "standard" | "dense" }

/** The transcript column of a session in one view, as plain rows. */
export function toolCardsView(events: SessionEvent[], options: ToolCardsViewOptions = {}) {
  const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full" }, glyphs: glyphs({}), mode: options.mode ?? "balanced", now: () => SESSION_NOW })
  t.setAppearance({ reasoning: "auto", toolOutput: (options.toolOutput ?? "auto") as "auto", toolDensity: options.toolDensity ?? "dense", timestamps: false })
  for (const event of events) t.apply(event)
  return { t, rows: () => t.viewport(options.width ?? 100, options.height ?? 1000).map((line) => line.text) }
}
