import { describe, expect, test } from "bun:test"
import { parseTimelineDiffRows } from "../../src/cli/cmd/tui/routes/session/renderers/diff-parse"
import { rawReasoningDisplay } from "../../src/mend/tui/presentation"
import { groupTimelineParts } from "../../src/mend/tui/timeline/group"
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
  })

  test("mendcode keeps artifact and command tools on rich renderers", () => {
    expect(shouldRenderCompactTool("mendcode", "read")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "webfetch")).toBe(true)
    expect(shouldRenderCompactTool("mendcode", "edit")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "apply_patch")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "bash")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "task")).toBe(false)
    expect(shouldRenderCompactTool("mendcode", "todowrite")).toBe(false)
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
      "◇ 1 more",
      ...Array.from({ length: 15 }, (_, index) => `Read file-${index + 2}.ts`),
      'Search web "docs"',
    ])
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 1 more"])
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
    expect(labels[0]).toBe("◇ 5 more")
    expect(labels.filter((label) => label.includes("more"))).toEqual(["◇ 5 more"])
    expect(labels.at(-1)).toBe("Read /tmp/current.ts (5-14)")
    expect(nodes.filter((node) => node.type === "row")).toHaveLength(16)
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

  test("raw timeline keeps original parts as structural part nodes", () => {
    const part = {
      id: "read-raw",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "a.ts" }, output: "" },
    }

    expect(groupTimelineParts("raw", [part])).toEqual([{ type: "part", id: "read-raw", part }])
  })

  test("reasoning rows stay hidden until the renderer opts in", () => {
    const part = {
      id: "reasoning-hidden",
      type: "reasoning",
      text: "hidden",
      time: { start: 1_000, end: 3_000 },
    }

    expect(groupTimelineParts("mendcode", [part], { completed: true })).toEqual([{ type: "part", id: "reasoning-hidden", part }])
    expect(groupTimelineParts("mendcode", [part], { completed: true, showReasoningRows: true })).toEqual([
      {
        type: "row",
        id: "reasoning-hidden",
        state: "completed",
        class: "planning",
        title: "Thought: hidden · 2.0s",
      },
    ])
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

  test("minimal and mendcode reasoning rows strip partial markdown headings while streaming", () => {
    const part = {
      id: "reasoning-active",
      type: "reasoning",
      text: "**Evaluating potential issues",
      time: { start: 1_000 },
    }

    expect(groupTimelineParts("mendcode", [part], { showReasoningRows: true })).toEqual([
      {
        type: "row",
        id: "reasoning-active",
        state: "running",
        class: "planning",
        title: "Thinking: Evaluating potential issues",
      },
    ])

    part.text = "**Evaluating potential issues**"
    expect(groupTimelineParts("mendcode", [part], { showReasoningRows: true })).toEqual([
      {
        type: "row",
        id: "reasoning-active",
        state: "running",
        class: "planning",
        title: "Thinking: Evaluating potential issues",
      },
    ])
  })

  test("raw reasoning keeps provider headings in the body instead of live header titles", () => {
    expect(rawReasoningDisplay("**Updating dashboard features**\n\nStreaming body")).toEqual({
      title: null,
      body: "**Updating dashboard features**\n\nStreaming body",
    })
    expect(rawReasoningDisplay("", { fallbackTitle: "reasoning metadata" })).toEqual({
      title: "reasoning metadata",
      body: "",
    })
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
      { type: "part", id: "text-active", part: parts[1] },
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
      { type: "part", id: "text-active", part: parts[1] },
    ])
    expect(groupTimelineParts("mendcode", parts, { completed: true }).map((node) => node.type)).toEqual(["row", "part"])
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

  test("timeline diff parser keeps deleted file contents as removed rows", () => {
    const rows = parseTimelineDiffRows(
      [
        "diff --git a/lib/optimization/vroom-client.ts b/lib/optimization/vroom-client.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/lib/optimization/vroom-client.ts",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-import { createClient } from \"vroom\"",
        "-export const client = createClient()",
        "-export default client",
      ].join("\n"),
    )

    expect(rows).toContainEqual({ kind: "file", text: "lib/optimization/vroom-client.ts" })
    expect(rows.filter((row) => row.kind === "removed").map((row) => row.text)).toEqual([
      'import { createClient } from "vroom"',
      "export const client = createClient()",
      "export default client",
    ])
  })
})
