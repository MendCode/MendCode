import { describe, expect, test } from "bun:test"
import path from "path"
import { parseTimelineDiffRows, timelineDiffFileStatus } from "../../src/cli/cmd/tui/routes/session/renderers/diff-parse"
import { rawReasoningDisplay, unavailableReasoningLabel } from "../../src/mend/tui/presentation"
import { groupTimelineParts, isTimelineStackStart } from "../../src/mend/tui/timeline/group"
import { normalizeToolEvent, shouldRenderCompactTool, toolClass, toolSummary } from "../../src/mend/tui/timeline/normalize"

describe("mend tui presentation renderers", () => {
  test("classifies tool events by presentation class", () => {
    expect(toolClass("read")).toBe("simple-read")
    expect(toolClass("webfetch")).toBe("web")
    expect(toolClass("websearch")).toBe("web")
    expect(toolClass("edit")).toBe("artifact")
    expect(toolClass("bash")).toBe("command")
    expect(toolClass("task")).toBe("planning")
    expect(toolClass("read", "error")).toBe("failure")
  })

  test("webfetch uses a domain summary instead of raw input dumps", () => {
    const event = normalizeToolEvent({
      tool: "webfetch",
      state: "completed",
      input: { url: "https://www.example.com/docs?format=text", format: "text", timeout: 20 },
    })

    expect(event.title).toBe("Web example.com")
    expect(event.title).not.toContain("[url=")
    expect(event.lines).toEqual([])
  })

  test("websearch uses a query summary", () => {
    const event = normalizeToolEvent({
      tool: "websearch",
      state: "completed",
      input: { query: "example domain", limit: 3 },
    })

    expect(event.title).toBe('Search web "example domain"')
    expect(event.lines).toEqual([])
  })

  test("one-line mendcode events have no empty block lines", () => {
    const event = normalizeToolEvent({
      tool: "webfetch",
      state: "completed",
      input: { url: "https://example.com" },
    })

    const rendered = event.lines.length > 0 ? [`╭─ ${event.title}`, ...event.lines.map((line) => `│ ${line}`), `╰─ ${event.result ?? ""}`] : [`◈ ${event.title}`]

    expect(rendered).toEqual(["◈ Web example.com"])
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
            header: "Formato",
            question: "¿En qué formato quieres que deje el reporte editable/final para poder revisar simulaciones, capturas, evidencias y anexos sin que el bloque se rompa visualmente?",
            options: [
              { label: "DOCX y PDF" },
              { label: "Solo PDF" },
              { label: "Markdown primero" },
            ],
          },
        ],
      },
      {
        answers: [
          [
            "markdown para que vayas armando todo luego lo montas a docx y pdf completo con imagenes de las simulaciones etc todo completo bien organizado",
          ],
        ],
      },
    )
    expect(longQuestion.title).toBe("Question")
    expect(longQuestion.lines.length).toBeGreaterThan(4)
    expect(longQuestion.lines.every((line) => Bun.stringWidth(line) <= 76)).toBe(true)
    expect(longQuestion.lines).toContain("  choices: DOCX y PDF, Solo PDF, Markdown primero")
    expect(longQuestion.lines.some((line) => line.startsWith("  poder revisar"))).toBe(true)
    expect(longQuestion.lines.some((line) => line.startsWith("  con imagenes"))).toBe(true)
  })

  test("mendcode keeps artifact and command tools on rich renderers", () => {
    expect(shouldRenderCompactTool("mendcode", "read")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "webfetch")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "edit")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "apply_patch")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "bash")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "task")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "todowrite")).toBe(true)
    expect(shouldRenderCompactTool("minimal", "edit")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "apply_patch")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "task")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "todowrite")).toBe(false)
    expect(shouldRenderCompactTool("minimal", "bash")).toBe(true)
    expect(shouldRenderCompactTool("raw", "read")).toBe(false)
    expect(shouldRenderCompactTool("raw", "edit")).toBe(false)
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

    const labels = nodes.map((node) => (node.type === "row" ? node.title : node.type === "collapse" ? `◇ ${node.count} more` : node.type))
    expect(labels).toEqual([
      "◇ 6 more",
      ...Array.from({ length: 10 }, (_, index) => `Read file-${index + 7}.ts`),
      'Search web "docs"',
    ])
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 6 more"])
    expect(nodes.find((node) => node.type === "collapse")).toMatchObject({
      type: "collapse",
      count: 6,
      rows: Array.from({ length: 6 }, (_, index) =>
        expect.objectContaining({ title: `Read file-${index + 1}.ts` }),
      ),
    })
    expect(nodes.find((node) => node.type === "row" && node.title === 'Search web "docs"')).toMatchObject({
      type: "row",
      state: "running",
    })
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

    const labels = nodes.map((node) => (node.type === "row" ? node.title : node.type === "collapse" ? `◇ ${node.count} more` : node.type))
    expect(labels[0]).toBe("◇ 10 more")
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 10 more"])
    expect(labels.at(-1)).toBe("Read /tmp/current.ts (5-14)")
    expect(nodes.filter((node) => node.type === "row")).toHaveLength(11)
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

    const labels = nodes.map((node) => (node.type === "row" ? node.title : node.type === "collapse" ? `◇ ${node.count} more` : node.type))
    expect(labels[0]).toBe("◇ 3 more")
    expect(labels).toContain("Todos")
    expect(nodes.find((node) => node.type === "row" && node.title === "Todos")).toMatchObject({
      lines: ["✓ Ship the UI"],
    })
    expect(labels.at(-1)).toBe('Search web "docs"')
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 3 more"])
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
    const labels = nodes.map((node) => (node.type === "row" ? node.title : node.type === "collapse" ? `◇ ${node.count} more` : node.type))

    expect(labels[0]).toBe("◇ 4 more")
    expect(labels).not.toContain("part")
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 4 more"])
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
          title: "Read ok.md",
        },
        {
          type: "row",
          id: "read-error",
          tool: "read",
          class: "failure",
          state: "error",
          title: "Read missing.md (1-80)",
        },
        {
          type: "row",
          id: "read-after",
          tool: "read",
          class: "simple-read",
          state: "completed",
          title: "Read after.md",
        },
      ])
    }
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
        title: "Read a.ts",
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
        title: "Read a.ts",
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
