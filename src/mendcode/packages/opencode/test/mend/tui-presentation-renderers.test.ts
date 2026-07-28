import { describe, expect, test } from "bun:test"
import path from "path"
import { parseTimelineDiffRows, timelineDiffFileStatus, timelineDiffIsNonText } from "../../src/cli/cmd/tui/routes/session/renderers/diff-parse"
import { diffStatsFromPatch, formatDiffStats, patchFileTitle } from "../../src/cli/cmd/tui/routes/session/renderers/diff-label"
import { compactMemoryGraphRows, compactMemoryGraphSnapshot } from "../../src/cli/cmd/tui/util/memory-graph"
import { compactionArcadeFrames, compactionStageStates, compactionSummaryPreview, rawReasoningDisplay, resolveTuiPresentation, unavailableReasoningLabel } from "../../src/mend/tui/presentation"
import { groupTimelineParts, isTimelineStackStart, timelineCollapseLabel, timelineNodeKeys } from "../../src/mend/tui/timeline/group"
import {
  normalizeToolEvent,
  shouldRenderCompactTool,
  toolClass,
  toolPresentationIcon,
  toolPresentationIconForProfile,
  toolSummary,
  wrapTimelineLine,
} from "../../src/mend/tui/timeline/normalize"

function timelineNodeLabel(node: ReturnType<typeof groupTimelineParts>[number]) {
  if (node.type === "row") return (node as { title: string }).title
  if (node.type === "collapse" && "rows" in node) return `◇ ${timelineCollapseLabel(node)}`
  return node.type
}

function isTimelineRowWithTitle(node: ReturnType<typeof groupTimelineParts>[number], title: string) {
  return node.type === "row" && (node as { title: string }).title === title
}

describe("mend tui presentation renderers", () => {
  test("compaction defaults to the normal arcade context pack", () => {
    expect(resolveTuiPresentation({}).compaction).toEqual({
      style: "arcade",
      showProgress: true,
      allowScratchpad: true,
      arcade: "snake",
    })
    expect(resolveTuiPresentation({ profile: "mendcode", compaction: { style: "cockpit", showProgress: true, allowScratchpad: true, arcade: "snake" } }).compaction).toEqual({
      style: "cockpit",
      showProgress: true,
      allowScratchpad: true,
      arcade: "snake",
    })
    expect(resolveTuiPresentation({ compaction: { arcade: "custom-game" } }).compaction.arcade).toBe("custom-game")
    expect(resolveTuiPresentation({ profile: "mendcode" }).compaction.style).toBe("arcade")
  })

  test("compaction cockpit helpers skip empty headings and expose arcade modes", () => {
    expect(compactionSummaryPreview("## Goal\n\nKeep implementing the approved plan.")).toBe("Keep implementing the approved plan.")
    expect(compactionSummaryPreview("# Goal\n")).toBeUndefined()
    expect(compactionStageStates({ hasSummary: true, tailStartID: "msg_tail", postPrompt: "next" }).map((stage) => stage.label)).toEqual([
      "Capture transcript",
      "Write memory",
      "Preserve tail",
      "Continue",
    ])
    expect(compactionArcadeFrames("snake")).toEqual([])
    expect(compactionArcadeFrames("blocks").length).toBeGreaterThan(0)
  })

  test("classifies tool events by presentation class", () => {
    expect(toolClass("read")).toBe("simple-read")
    expect(toolClass("webfetch")).toBe("web")
    expect(toolClass("websearch")).toBe("web")
    expect(toolClass("edit")).toBe("artifact")
    expect(toolClass("bash")).toBe("command")
    expect(toolClass("task")).toBe("planning")
    expect(toolClass("loop")).toBe("planning")
    expect(toolClass("plan_review")).toBe("planning")
    expect(toolClass("playwright_browser_click")).toBe("web")
    expect(toolClass("read", "error")).toBe("failure")
  })

  test("uses stable terminal-safe tool symbols with deterministic ASCII fallbacks", () => {
    expect(toolPresentationIcon("bash")).toBe("$")
    expect(toolPresentationIcon("read")).toBe("□")
    expect(toolPresentationIcon("grep")).toBe("⌕")
    expect(toolPresentationIcon("edit")).toBe("✎")
    expect(toolPresentationIcon("webfetch")).toBe("⌁")
    expect(toolPresentationIcon("task")).toBe("◔")
    expect(toolPresentationIcon("review")).toBe("◫")
    expect(toolPresentationIcon("memory")).toBe("◉")
    expect(toolPresentationIcon("memory_graph")).toBe("◎")
    expect(toolPresentationIcon("loop")).toBe("⟳")
    expect(toolPresentationIcon("playwright_browser_click")).toBe("▣")

    expect(toolPresentationIcon("read", undefined, { asciiOnly: true })).toBe("R")
    expect(toolPresentationIcon("grep", undefined, { asciiOnly: true })).toBe("S")
    expect(toolPresentationIcon("edit", undefined, { asciiOnly: true })).toBe("E")
    expect(toolPresentationIcon("memory_graph", undefined, { asciiOnly: true })).toBe("G")
    expect(toolPresentationIcon("loop", undefined, { asciiOnly: true })).toBe("L")
    expect(toolPresentationIcon("playwright_browser_click", undefined, { asciiOnly: true })).toBe("B")
    expect(toolPresentationIconForProfile("minimal", "read")).toBe("□")
    expect(toolPresentationIconForProfile("minimal", "loop")).toBe("⟳")
    expect(toolPresentationIconForProfile("minimal", undefined, "failure")).toBe("×")
    expect(toolPresentationIconForProfile("mendcode", "read")).toBe("□")
    expect(toolPresentationIconForProfile("mendcode", undefined, "failure")).toBe("×")
  })

  test("compact memory graph rows keep relation endpoints readable without duplicates", () => {
    const snapshot = compactMemoryGraphSnapshot({
      facts: [
        { id: "fact_a", text: "Use the complete durable memory text for the source endpoint.", scope: "project", categoryIDs: ["memory.policy"], materialized: true },
        { id: "fact_b", text: "Keep the related destination memory readable in session tools.", scope: "project", categoryIDs: ["memory.policy"], materialized: true },
        { id: "fact_c", text: "An isolated memory remains visible when no relation exists.", scope: "project", categoryIDs: ["memory.policy"], materialized: true },
      ],
      links: [{ from: "fact_a", to: "fact_b", kind: "supports" }],
      categories: [{ id: "memory.policy", label: "Memory policy", count: 3 }],
    })
    if (!snapshot) throw new Error("expected graph snapshot")

    expect(compactMemoryGraphRows(snapshot, 120)).toEqual([
      "From · Use the complete durable memory text for the source endpoint.",
      "Relation · supports",
      "To · Keep the related destination memory readable in session tools.",
    ])
    expect(new Set(compactMemoryGraphRows(snapshot, 120)).size).toBe(3)
  })

  test("compact memory graph rows explain isolated memories", () => {
    const snapshot = compactMemoryGraphSnapshot({
      facts: [{ id: "fact_a", text: "This isolated memory should still be readable.", scope: "global", categoryIDs: ["agent.policy"], materialized: true }],
      links: [],
      categories: [],
    })
    if (!snapshot) throw new Error("expected graph snapshot")
    expect(compactMemoryGraphRows(snapshot, 80)).toEqual([
      "Memory · This isolated memory should still be readable.",
      "Relation · isolated (global)",
    ])
  })

  test("webfetch uses a domain summary instead of raw input dumps", () => {
    const event = normalizeToolEvent({
      tool: "webfetch",
      state: "completed",
      input: { url: "https://www.example.com/docs?format=text", format: "text", timeout: 20 },
    })

    expect(event.title).toBe("Web example.com")
    expect(event.title).not.toContain("[url=")
    expect(event.lines).toEqual(["https://www.example.com/docs?format=text"])
  })

  test("webfetch does not duplicate identical title and URL detail lines", () => {
    const event = normalizeToolEvent({
      tool: "webfetch",
      state: "completed",
      input: {
        title: "https://example.com/docs",
        url: "https://example.com/docs",
      },
    })

    expect(event.title).toBe("Web example.com")
    expect(event.lines).toEqual(["https://example.com/docs"])
  })

  test("websearch uses a query summary and shows full result URLs", () => {
    const event = normalizeToolEvent({
      tool: "websearch",
      state: "completed",
      input: { query: "example domain", limit: 3 },
      metadata: {
        numResults: 4,
        results: [
          { url: "example.com/docs?ref=search#intro" },
          { href: "https://www.example.com/blog/post?utm_source=exa" },
          { link: "https://docs.example.com/guide#install" },
          { url: "https://ignored.example.com/fourth" },
        ],
      },
    })

    expect(event.title).toBe('Search web "example domain" (4 results)')
    expect(event.lines).toEqual([
      "https://example.com/docs?ref=search#intro",
      "https://www.example.com/blog/post?utm_source=exa",
      "https://docs.example.com/guide#install",
    ])
    expect(event.lines.every((line) => line.startsWith("https://"))).toBe(true)
  })

  test("websearch extracts full URLs from tool output text", () => {
    const event = normalizeToolEvent({
      tool: "websearch",
      state: "completed",
      input: { query: "release notes" },
      output: "Found https://example.com/releases/2026-07?channel=stable#notes and https://docs.example.com/setup/install?os=mac.",
    })

    expect(event.lines).toEqual([
      "https://example.com/releases/2026-07?channel=stable#notes",
      "https://docs.example.com/setup/install?os=mac",
    ])
  })

  test("timeline line wrapping splits long URLs without dropping characters", () => {
    const lines = wrapTimelineLine("", "https://example.com/docs/really/long/path/that/has/no/spaces?query=alpha-beta-gamma-delta#fragment", 36)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join("").replaceAll("  ", "")).toBe("https://example.com/docs/really/long/path/that/has/no/spaces?query=alpha-beta-gamma-delta#fragment")
    expect(lines.every((line) => Bun.stringWidth(line) <= 36)).toBe(true)
  })

  test("one-line mendcode events have no empty block lines", () => {
    const event = normalizeToolEvent({
      tool: "grep",
      state: "completed",
      input: { pattern: "example" },
    })

    const rendered = event.lines.length > 0 ? [`╭─ ${event.title}`, ...event.lines.map((line) => `│ ${line}`), `╰─ ${event.result ?? ""}`] : [`◈ ${event.title}`]

    expect(rendered).toEqual(['◈ Search "example"'])
    expect(rendered).not.toContain("╰─")
  })

  test("artifact and command summaries stay explicit", () => {
    expect(toolSummary("edit", { filePath: "src/format.ts" }).title).toBe("Edit src/format.ts")
    expect(toolSummary("bash", { command: "bun test test/mend/tui-presentation-renderers.test.ts" }).title).toBe(
      "Shell bun test test/mend/tui-presentation-renderers.test.ts",
    )
  })

  test("tool summaries include useful Grok-like details", () => {
    expect(
      toolSummary("read", { filePath: "src/file.ts", offset: 2, limit: 45 }, undefined, "(Showing lines 2-46 of 66. Use offset=47 to continue.)").title,
    ).toBe("Read src/file.ts (2-46 of 66)")
    expect(
      toolSummary(
        "read",
        { filePath: ".agents", offset: 1, limit: 200 },
        undefined,
        "<path>/repo/.agents</path>\n<type>directory</type>\n<entries>\nfoo\nbar\n\n(2 entries)\n</entries>",
      ).title,
    ).toBe("Read .agents (2 entries)")
    expect(
      toolSummary(
        "read",
        { filePath: ".agents", offset: 1, limit: 200 },
        undefined,
        "<path>/repo/.agents</path>\n<type>directory</type>\n<entries>\nfoo\n\n(Showing 200 of 250 entries. Use 'offset' parameter to read beyond entry 200)\n</entries>",
      ).title,
    ).toBe("Read .agents (200 of 250 entries)")
    expect(toolSummary("glob", { pattern: "src/**/*.ts" }, { count: 4 }).title).toBe("List src/**/*.ts (4 matches)")
    expect(toolSummary("grep", { pattern: "query" }, { matches: 3 }).title).toBe('Search "query" (3 matches)')
    expect(toolSummary("websearch", { query: "query" }, { numResults: 3 }).title).toBe('Search web "query" (3 results)')
    expect(
      toolSummary(
        "websearch",
        { query: "query" },
        undefined,
        JSON.stringify({
          results: [
            { url: "https://example.com/a" },
            { href: "https://example.com/b" },
            { link: "https://example.com/c" },
            { url: "https://example.com/d" },
          ],
        }),
      ).lines,
    ).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"])
    expect(
      toolSummary(
        "memory",
        { action: "status", scope: "project", id: "", query: "", text: "" },
        undefined,
        "enabled: true\nproject entries: 5\npending proposals: 2\ncategories: 13\nignored",
      ),
    ).toEqual({
      title: "Memory status [project]",
      lines: ["enabled: true", "project entries: 5", "pending proposals: 2", "categories: 13"],
    })
    expect(toolSummary("memory_graph", { action: "overview", query: "" }, undefined, "facts: 13\nlinks: 0")).toEqual({
      title: "Memory graph overview",
      lines: ["facts: 13", "links: 0"],
    })
    expect(
      toolSummary("todowrite", {
        todos: [
          { content: "Map repo", status: "completed" },
          { content: "Fix render", status: "in_progress" },
          { content: "Ship broken path", status: "cancelled" },
          { content: "Validate", status: "pending" },
        ],
      }).lines,
    ).toEqual(["✓ Map repo", "→ Fix render", "× Ship broken path", "○ Validate"])
    expect(
      toolSummary(
        "question",
        {
          questions: [
            {
              header: "Deploy",
              question: "Which environment should receive this change?",
              options: [{ label: "Staging" }, { label: "Production" }],
            },
          ],
        },
        { answers: [["Staging"]] },
      ),
    ).toEqual({
      title: "Question",
      lines: ["? Deploy: Which environment should receive this change?", "  choices: Staging, Production", "→ Staging"],
    })
    const longQuestion = toolSummary(
      "question",
      {
        questions: [
          {
            header: "Format",
            question: "Which editable and final report format should I use so simulations, screenshots, evidence, and appendices stay readable without breaking the block layout?",
            options: [
              { label: "DOCX and PDF" },
              { label: "PDF only" },
              { label: "Markdown first" },
            ],
          },
        ],
      },
      {
        answers: [
          [
            "markdown first so the report can be assembled progressively, then turn it into complete docx and pdf files with simulation images, evidence, appendices, and a clean structure",
          ],
        ],
      },
    )
    expect(longQuestion.title).toBe("Question")
    expect(longQuestion.lines.length).toBeGreaterThan(4)
    expect(longQuestion.lines.every((line) => Bun.stringWidth(line) <= 76)).toBe(true)
    expect(longQuestion.lines).toContain("  choices: DOCX and PDF, PDF only, Markdown first")
    expect(longQuestion.lines.some((line) => line.startsWith("  simulations"))).toBe(true)
    expect(longQuestion.lines.some((line) => line.startsWith("  appendices"))).toBe(true)
  })

  test("mendcode keeps artifact and command tools on rich renderers", () => {
    expect(shouldRenderCompactTool("mendcode", "read")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "webfetch")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "edit")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "apply_patch")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "bash")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "task")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "loop")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "memory_graph")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "todowrite")).toBe(true)
    expect(shouldRenderCompactTool("minimal", "edit")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "apply_patch")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "task")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "loop")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "memory_graph")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "todowrite")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "bash")).toBe(true)
    expect(shouldRenderCompactTool("raw", "read")).toBe(false)
    expect(shouldRenderCompactTool("raw", "edit")).toBe(false)
  })

  test("diff block titles keep action, path, and stats on one line", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "-const oldValue = true",
      "+const newValue = true",
      "+const extraValue = false",
    ].join("\n")

    expect(formatDiffStats(diffStatsFromPatch(patch))).toBe("(+2 -1)")
    expect(patchFileTitle({ type: "add", relativePath: "src/new.ts", additions: 3, deletions: 0 })).toBe(
      "Added src/new.ts (+3)",
    )
    expect(patchFileTitle({ type: "delete", relativePath: "src/old.ts", additions: 0, deletions: 2 })).toBe(
      "Deleted src/old.ts (-2)",
    )
    expect(patchFileTitle({ type: "update", relativePath: "src/app.ts" }, patch)).toBe("Patched src/app.ts (+2 -1)")
    expect(patchFileTitle({ type: "move", filePath: "src/old.ts", movePath: "src/new.ts" })).toBe(
      "Patched src/old.ts -> src/new.ts",
    )
  })

  test("loop tools stay on the rich card renderer in compact profiles", () => {
    const nodes = groupTimelineParts("minimal", [
      {
        id: "loop-tool",
        type: "tool",
        tool: "loop",
        state: {
          status: "completed",
          input: { action: "show", workflowID: "loop_test" },
          metadata: { workflowID: "loop_test", state: "sleeping", phase: "waiting" },
          output: "loop_id: loop_test",
        },
      },
    ], { completed: true, showReasoningRows: true })

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ type: "tool", tool: "loop" })
  })

  test("timeline collapse label uses expanded state and singular nouns", () => {
    const collapse = {
      count: 1,
      rows: [
        {
          type: "row" as const,
          id: "read-1",
          tool: "read",
          class: "simple-read" as const,
          state: "completed",
          title: "a.ts",
        },
      ],
    }

    expect(timelineCollapseLabel(collapse)).toBe("1 tool more")
    expect(timelineCollapseLabel(collapse, { expanded: true })).toBe("1 tool shown")
  })

  test("groups old completed timeline rows behind a single more row", () => {
    const completedReads = Array.from({ length: 16 }, (_, index) => ({
      id: `read-${index + 1}`,
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: `file-${index + 1}.ts` }, output: "" },
    }))
    const nodes = groupTimelineParts("mendcode", [
      ...completedReads,
      {
        id: "web-1",
        type: "tool",
        tool: "websearch",
        state: { status: "running", input: { query: "docs" } },
      },
    ], { completed: true, showReasoningRows: true })

    const labels = nodes.map(timelineNodeLabel)
    expect(labels).toEqual([
      "◇ 11 tools more",
      ...Array.from({ length: 5 }, (_, index) => `file-${index + 12}.ts`),
      '"docs"',
    ])
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 11 tools more"])
    expect(nodes.find((node) => node.type === "collapse")).toMatchObject({
      type: "collapse",
      count: 11,
      rows: Array.from({ length: 11 }, (_, index) => expect.objectContaining({ title: `file-${index + 1}.ts` })),
    })
    expect(nodes.find((node) => isTimelineRowWithTitle(node, '"docs"'))).toMatchObject({
      type: "row",
      state: "running",
    })
  })

  test("large tool batches keep a bounded render list and stable node keys", () => {
    const tools = Array.from({ length: 500 }, (_, index) => ({
      id: `batch-read-${index}`,
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: `batch-${index}.ts` }, output: "" },
    }))
    const nodes = groupTimelineParts("mendcode", tools, { completed: true })
    const nextNodes = groupTimelineParts("mendcode", [...tools, { ...tools.at(-1)!, id: "batch-read-new" }], {
      completed: true,
    })
    const keys = timelineNodeKeys(nodes)
    const nextKeys = timelineNodeKeys(nextNodes)

    expect(nodes.length).toBeLessThanOrEqual(6)
    expect(nextKeys.filter((key) => keys.includes(key)).length).toBeGreaterThanOrEqual(keys.length - 1)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("large raw tool batches compact otherwise heavy tool components", () => {
    const tasks = Array.from({ length: 500 }, (_, index) => ({
      id: `batch-task-${index}`,
      type: "tool",
      tool: "task",
      state: { status: "completed", input: { description: `task ${index}` }, output: "done" },
    }))

    expect(groupTimelineParts("raw", tasks)).toHaveLength(500)
    const compacted = groupTimelineParts("raw", tasks, { forceCompact: true })
    expect(compacted.length).toBeLessThanOrEqual(6)
    expect(compacted[0]).toMatchObject({ type: "collapse", count: 495 })
  })

  test("active streaming timeline keeps a single top collapse row", () => {
    const completedReads = Array.from({ length: 20 }, (_, index) => ({
      id: `active-read-${index + 1}`,
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: `active-${index + 1}.ts` }, output: "" },
    }))
    const nodes = groupTimelineParts("minimal", [
      ...completedReads,
      {
        id: "active-current",
        type: "tool",
        tool: "read",
        state: { status: "running", input: { filePath: "/tmp/current.ts", offset: 5, limit: 10 } },
      },
    ])

    const labels = nodes.map(timelineNodeLabel)
    expect(labels[0]).toBe("◇ 15 tools more")
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 15 tools more"])
    expect(labels.at(-1)).toBe("/tmp/current.ts (5-14)")
    expect(nodes.filter((node) => node.type === "row")).toHaveLength(6)
  })

  test("mendcode keeps todo writes inside compact timeline stacks", () => {
    const completedReads = Array.from({ length: 12 }, (_, index) => ({
      id: `stack-read-${index + 1}`,
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: `stack-${index + 1}.ts` }, output: "" },
    }))
    const nodes = groupTimelineParts("mendcode", [
      ...completedReads,
      {
        id: "todo-stack",
        type: "tool",
        tool: "todowrite",
        state: { status: "completed", input: { todos: [{ content: "Ship the UI", status: "completed" }] }, output: "" },
      },
      {
        id: "web-stack",
        type: "tool",
        tool: "websearch",
        state: { status: "running", input: { query: "docs" } },
      },
    ], { completed: true, showReasoningRows: true })

    const labels = nodes.map(timelineNodeLabel)
    expect(labels[0]).toBe("◇ 8 tools more")
    expect(labels).toContain("Todos")
    expect(nodes.find((node) => isTimelineRowWithTitle(node, "Todos"))).toMatchObject({
      lines: ["✓ Ship the UI"],
    })
    expect(labels.at(-1)).toBe('"docs"')
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 8 tools more"])
  })

  test("mendcode uses the live list for the latest grouped todo write", () => {
    const nodes = groupTimelineParts("mendcode", [
      {
        id: "todo-live",
        type: "tool",
        tool: "todowrite",
        state: {
          status: "completed",
          input: {
            todos: [
              { content: "Initial task", status: "in_progress" },
              { content: "Second task", status: "pending" },
            ],
          },
          output: "",
        },
      },
    ], {
      completed: true,
      latestTodoWritePartID: "todo-live",
      currentTodos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress" },
        { content: "Task 3", status: "pending" },
        { content: "Task 4", status: "pending" },
        { content: "Task 5", status: "pending" },
      ],
    })

    const row = nodes.find((node) => isTimelineRowWithTitle(node, "Todos"))
    expect(row).toMatchObject({
      lines: ["✓ Task 1", "→ Task 2", "○ Task 3", "○ Task 4", "○ Task 5"],
    })
  })

  test("empty parts do not split compact timeline stacks", () => {
    const parts = [
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `before-${index + 1}`,
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: `before-${index + 1}.ts` }, output: "" },
      })),
      { id: "empty-text", type: "text", text: "   " },
      { id: "empty-reasoning", type: "reasoning", text: "[REDACTED]", time: { start: 1_000, end: 2_000 } },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `after-${index + 1}`,
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: `after-${index + 1}.ts` }, output: "" },
      })),
    ]

    const nodes = groupTimelineParts("mendcode", parts, { completed: true, showReasoningRows: true })
    const labels = nodes.map(timelineNodeLabel)

    expect(labels[0]).toBe("◇ 9 tools more")
    expect(labels).not.toContain("part")
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 9 tools more"])
  })

  test("minimal and mendcode compact errored tools into the same timeline stack", () => {
    const parts = [
      {
        id: "read-ok",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "ok.md" }, output: "" },
      },
      {
        id: "read-error",
        type: "tool",
        tool: "read",
        state: { status: "error", input: { filePath: "missing.md", offset: 1, limit: 80 }, error: "not found" },
      },
      {
        id: "read-after",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "after.md" }, output: "" },
      },
    ]

    for (const profile of ["minimal", "mendcode"] as const) {
      expect(groupTimelineParts(profile, parts)).toEqual([
        {
          type: "row",
          id: "read-ok",
          tool: "read",
          class: "simple-read",
          state: "completed",
          title: "ok.md",
        },
        {
          type: "row",
          id: "read-error",
          tool: "read",
          class: "failure",
          state: "error",
          title: "missing.md (1-80)",
        },
        {
          type: "row",
          id: "read-after",
          tool: "read",
          class: "simple-read",
          state: "completed",
          title: "after.md",
        },
      ])
    }
  })

  test("compact grouped rows use shorter safe titles for high-volume tools", () => {
    expect(
      groupTimelineParts("mendcode", [
        {
          id: "read-short",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "src/file.ts", offset: 5, limit: 10 }, output: "" },
        },
        {
          id: "grep-short",
          type: "tool",
          tool: "grep",
          state: { status: "completed", input: { pattern: "query" }, metadata: { matches: 2 }, output: "" },
        },
        {
          id: "web-short",
          type: "tool",
          tool: "websearch",
          state: { status: "completed", input: { query: "docs" }, metadata: { numResults: 3 }, output: "" },
        },
        {
          id: "todo-short",
          type: "tool",
          tool: "todowrite",
          state: { status: "completed", input: { todos: [{ content: "Ship", status: "completed" }] }, output: "" },
        },
      ]).map(timelineNodeLabel),
    ).toEqual(["src/file.ts (5-14)", '"query" (2 matches)', '"docs" (3 results)', "Todos"])
  })

  test("timeline stacks only add top spacing after visible assistant text", () => {
    const nodes = [
      { id: "read-a", type: "row", title: "Read a.ts" },
      { id: "edit-a", type: "tool", tool: "edit" },
      { id: "read-b", type: "row", title: "Read b.ts" },
      { id: "reasoning-a", type: "row", title: "Thought: Checking" },
      { id: "question-a", type: "row", title: "Question" },
      { id: "text-a", type: "text", text: "Now I can answer." },
      { id: "read-c", type: "row", title: "Read c.ts" },
      { id: "empty-text", type: "text", text: "   " },
      { id: "read-d", type: "row", title: "Read d.ts" },
    ]

    expect(isTimelineStackStart(nodes, 0)).toBe(false)
    expect(isTimelineStackStart(nodes, 2)).toBe(false)
    expect(isTimelineStackStart(nodes, 4)).toBe(false)
    expect(isTimelineStackStart(nodes, 6)).toBe(true)
    expect(isTimelineStackStart(nodes, 8)).toBe(false)
  })

  test("raw timeline keeps original parts without wrapper nodes", () => {
    const part = {
      id: "read-raw",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "a.ts" }, output: "" },
    }

    expect(groupTimelineParts("raw", [part])).toEqual([part])
  })

  test("reasoning rows stay hidden until the renderer opts in", () => {
    const part = {
      id: "reasoning-hidden",
      type: "reasoning",
      text: "hidden",
      time: { start: 1_000, end: 3_000 },
    }

    expect(groupTimelineParts("mendcode", [part], { completed: true })).toEqual([part])
    expect(groupTimelineParts("mendcode", [part], { completed: true, showReasoningRows: true })).toEqual([part])
  })

  test("minimal and mendcode reasoning rows stay collapsed while streaming", () => {
    const part = {
      id: "reasoning-active",
      type: "reasoning",
      text: "**Exploring startup ideas**\n\nThis body should not render in compact presentations.",
      time: { start: 1_000 },
    }

    expect(groupTimelineParts("minimal", [part], { showReasoningRows: true })).toEqual([
      {
        type: "row",
        id: "reasoning-active",
        state: "running",
        class: "planning",
        title: "Thinking: Exploring startup ideas",
      },
    ])
  })

  test("minimal stacks reasoning rows while mendcode keeps reasoning body parts", () => {
    const parts = [
      {
        id: "read-before",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "a.ts" }, output: "(End of file - total 5 lines)" },
      },
      {
        id: "reasoning-middle",
        type: "reasoning",
        text: "**Checking model configuration**\n\nReasoning body",
        time: { start: 1_000, end: 5_900 },
      },
      {
        id: "read-after",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "b.ts" }, output: "(End of file - total 9 lines)" },
      },
    ]

    expect(groupTimelineParts("mendcode", parts, { showReasoningRows: true })).toEqual([
      expect.objectContaining({ type: "row", id: "read-before" }),
      parts[1],
      expect.objectContaining({ type: "row", id: "read-after" }),
    ])
  })

  test("raw reasoning keeps provider headings in the body instead of live header titles", () => {
    expect(rawReasoningDisplay("**Updating dashboard features**\n\nStreaming body")).toEqual({
      title: null,
      body: "**Updating dashboard features**\n\nStreaming body",
    })
    expect(rawReasoningDisplay("", { fallbackTitle: "reasoning unavailable" })).toEqual({
      title: "reasoning unavailable",
      body: "",
    })
  })

  test("raw reasoning labels unavailable content without hiding readable thoughts", () => {
    expect(unavailableReasoningLabel({ hasReadableContent: true, encrypted: true })).toBeNull()
    expect(unavailableReasoningLabel({ hasReadableContent: false, encrypted: true })).toBe("reasoning unavailable")
    expect(unavailableReasoningLabel({ hasReadableContent: false, encrypted: false })).toBe("reasoning unavailable")
  })

  test("minimal and mendcode compact active streaming tool rows", () => {
    const parts = [
      {
        id: "read-active",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "a.ts" }, output: "" },
      },
      {
        id: "text-active",
        type: "text",
        text: "streaming answer",
      },
    ]

    expect(groupTimelineParts("minimal", parts)).toEqual([
      {
        type: "row",
        id: "read-active",
        tool: "read",
        class: "simple-read",
        state: "completed",
        title: "a.ts",
      },
      parts[1],
    ])
    expect(groupTimelineParts("mendcode", parts)).toEqual([
      {
        type: "row",
        id: "read-active",
        tool: "read",
        class: "simple-read",
        state: "completed",
        title: "a.ts",
      },
      parts[1],
    ])
    expect(groupTimelineParts("mendcode", parts, { completed: true }).map((node) => node.type)).toEqual(["row", "text"])
  })

  test("timeline diff parser returns file-style rows without raw patch chrome", () => {
    const rows = parseTimelineDiffRows(
      [
        "diff --git a/a.ts b/a.ts",
        "index 1111111..2222222 100644",
        "Index: a.ts",
        "===================================================================",
        "--- a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
    )

    expect(rows).toContainEqual({ kind: "file", text: "a.ts" })
    expect(rows).toContainEqual({ kind: "removed", oldLine: 2, text: "old" })
    expect(rows).toContainEqual({ kind: "added", newLine: 2, text: "new" })
    expect(rows.find((row) => row.kind === "removed")?.text.startsWith("-")).toBe(false)
    expect(rows.find((row) => row.kind === "added")?.text.startsWith("+")).toBe(false)
    expect(rows.some((row) => row.text.includes("@@"))).toBe(false)
    expect(rows.some((row) => row.text.startsWith("old "))).toBe(false)
    expect(rows.some((row) => row.text.startsWith("new "))).toBe(false)
    expect(rows.some((row) => row.text.startsWith("diff --git"))).toBe(false)
    expect(rows.filter((row) => row.kind === "file")).toEqual([{ kind: "file", text: "a.ts" }])
  })

  test("timeline diff parser normalizes absolute workspace headers", () => {
    const file = path.join(process.cwd(), "scripts/install.ps1")
    const rows = parseTimelineDiffRows([`--- ${file}`, `+++ ${file}`, "@@ -1 +1 @@", "-old", "+new"].join("\n"))

    expect(rows[0]).toEqual({ kind: "file", text: "scripts/install.ps1" })
  })

  test("timeline diff parser keeps deleted file contents as removed rows", () => {
    const diff = [
      "diff --git a/lib/optimization/vroom-client.ts b/lib/optimization/vroom-client.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/lib/optimization/vroom-client.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      '-import { createClient } from "vroom"',
      "-export const client = createClient()",
      "-export default client",
    ].join("\n")
    const rows = parseTimelineDiffRows(diff)

    expect(timelineDiffFileStatus(diff)).toBe("removed")
    expect(rows).toContainEqual({ kind: "file", text: "lib/optimization/vroom-client.ts" })
    expect(rows.filter((row) => row.kind === "removed").map((row) => row.text)).toEqual([
      'import { createClient } from "vroom"',
      "export const client = createClient()",
      "export default client",
    ])
  })

  test("timeline diff parser omits binary-looking patches instead of rendering bytes", () => {
    const diff = [
      "Index: /repo/public/blog/hero.png",
      "===================================================================",
      "--- /repo/public/blog/hero.png",
      "+++ /repo/public/blog/hero.png",
      "@@ -1,2 +0,0 @@",
      "-\ufffdPNG",
      "-\u0000\u0000\u0000\rIHDR\u0000\u0000",
    ].join("\n")
    const rows = parseTimelineDiffRows(diff)

    expect(rows).toEqual([
      { kind: "file", text: "/repo/public/blog/hero.png" },
      { kind: "meta", text: expect.stringContaining("Binary/non-text patch omitted") },
    ])
    expect(rows.map((row) => row.text).join("\n")).not.toContain("\ufffdPNG")
  })

  test("timeline diff parser treats compact binary summaries as non-text", () => {
    const diff = [
      "Index: /repo/.bun-build",
      "===================================================================",
      "Binary files /repo/.bun-build and /dev/null differ (476,227 bytes)",
    ].join("\n")

    expect(timelineDiffIsNonText(diff)).toBe(true)
    expect(parseTimelineDiffRows(diff)).toEqual([
      { kind: "file", text: "/repo/.bun-build" },
      { kind: "meta", text: "Binary/non-text patch omitted (476,227 bytes)" },
    ])
  })

  test("timeline diff parser caps only very large text diffs", () => {
    const body = Array.from({ length: 20_500 }, (_, index) => `+line ${index}`).join("\n")
    const rows = parseTimelineDiffRows(["+++ b/huge.ts", "@@ -0,0 +1,4000 @@", body].join("\n"))

    expect(rows.length).toBeLessThanOrEqual(20_001)
    expect(rows.at(-1)).toEqual({
      kind: "meta",
      text: expect.stringContaining("Diff preview truncated: too large to render safely"),
    })
    expect(rows.at(-1)?.text).toContain("Show more")
  })

  test("timeline diff detects complete created files", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const value = 1",
      "+export default value",
    ].join("\n")

    expect(timelineDiffFileStatus(diff)).toBe("added")
  })
})
