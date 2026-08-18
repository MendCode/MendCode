import { describe, expect, test } from "bun:test"
import { TuiInfo } from "../../../src/cli/cmd/tui/config/tui-schema"
import {
  nextSessionHistoryView,
  resolveSessionHistorySettings,
  sessionHistoryBoundaryVisible,
  sessionHistoryLayout,
  sessionHistoryMissingParentIDs,
  sessionHistoryRows,
  sessionHistorySelectionOffset,
  sessionHistoryTurnCount,
  sessionHistoryTurnItems,
  type SessionHistoryItem,
} from "../../../src/cli/cmd/tui/util/session-history"

function message(input: {
  id: string
  role: "user" | "assistant"
  text: string
  parentID?: string
  time?: number
  tools?: string[]
  subagents?: string[]
}): SessionHistoryItem {
  const parts = [
    {
      id: `part-${input.id}`,
      sessionID: "ses_history",
      messageID: input.id,
      type: "text" as const,
      text: input.text,
    },
    ...(input.tools ?? []).map((tool, index) => ({
      id: `tool-${input.id}-${index}`,
      sessionID: "ses_history",
      messageID: input.id,
      type: "tool" as const,
      callID: `call-${index}`,
      tool,
      state: {
        status: "completed" as const,
        input: {},
        output: "ok",
        title: tool,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })),
    ...(input.subagents ?? []).map((description, index) => ({
      id: `subtask-${input.id}-${index}`,
      sessionID: "ses_history",
      messageID: input.id,
      type: "subtask" as const,
      prompt: description,
      description,
      agent: "build",
    })),
  ]
  const base = {
    id: input.id,
    sessionID: "ses_history",
    time: { created: input.time ?? 1_700_000_000_000 },
  }
  return {
    info:
      input.role === "user"
        ? {
            ...base,
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          }
        : {
            ...base,
            role: "assistant",
            parentID: input.parentID!,
            modelID: "test",
            providerID: "test",
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
    parts,
  } as SessionHistoryItem
}

describe("session history browser", () => {
  test("accepts every user-facing history setting in tui.json", () => {
    const config = TuiInfo.parse({
      session_history: {
        enabled: true,
        view: "tree",
        split: "auto",
        page_size: 80,
        group_by: "day",
        show_tools: "tree",
        show_subagents: true,
        search: true,
        remember_position: true,
        open_at: "latest",
        preview_width: 62,
        search_page_limit: 300,
      },
    })
    expect(config.session_history?.view).toBe("tree")
    expect(config.session_history?.split).toBe("auto")
    expect(config.session_history?.page_size).toBe(80)
    expect(() => TuiInfo.parse({ session_history: { view: "cards" } })).toThrow()
  })

  test("resolves responsive presets while allowing an explicit live override", () => {
    expect(resolveSessionHistorySettings(undefined, 140)).toMatchObject({ view: "tree", split: true })
    expect(resolveSessionHistorySettings(undefined, 90)).toMatchObject({ view: "tree", split: false })
    expect(resolveSessionHistorySettings(undefined, 60)).toMatchObject({ view: "timeline", split: false })
    expect(resolveSessionHistorySettings({ view: "timeline", page_size: 80 }, 140)).toMatchObject({
      view: "timeline",
      split: true,
      pageSize: 80,
    })
    expect(resolveSessionHistorySettings({ view: "timeline" }, 140, "tree").view).toBe("tree")
    expect(resolveSessionHistorySettings({ view: "tree", split: false }, 140)).toMatchObject({
      view: "tree",
      split: false,
    })
    expect(resolveSessionHistorySettings({ view: "pages", split: false }, 140, undefined, true)).toMatchObject({
      view: "pages",
      split: true,
    })
  })

  test("maps legacy split and chapters config without exposing duplicate modes", () => {
    expect(resolveSessionHistorySettings({ view: "split" }, 140)).toMatchObject({
      view: "timeline",
      split: true,
    })
    expect(resolveSessionHistorySettings({ view: "chapters", split: false }, 140)).toMatchObject({
      view: "timeline",
      split: false,
    })
  })

  test("builds a user to assistant tree with tool and subagent metadata", () => {
    const user = message({ id: "usr", role: "user", text: "Fix the lyrics layout" })
    const assistant = message({
      id: "ast",
      role: "assistant",
      parentID: "usr",
      text: "Implemented and verified it",
      tools: ["apply_patch", "shell"],
      subagents: ["UI verification"],
    })
    const rows = sessionHistoryRows({ items: [user, assistant], view: "tree", groupBy: "none" })
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["turn:usr", 0],
      ["response:usr", 1],
    ])
    expect(rows[0]).toMatchObject({ toolCount: 2, subagentCount: 1, kind: "turn" })
    expect(rows[1]).toMatchObject({ toolCount: 0, subagentCount: 0, kind: "response" })
    expect(sessionHistoryTurnItems([user, assistant], "ast").map((item) => item.info.id)).toEqual(["usr", "ast"])
  })

  test("collapses a raw tool burst into one bounded conversation turn", () => {
    const assistants = Array.from({ length: 50 }, (_, index) =>
      message({
        id: `ast-${index}`,
        role: "assistant",
        parentID: "outside-page",
        text: "",
        tools: [index % 2 ? "shell" : "read"],
      }),
    )
    const rows = sessionHistoryRows({ items: assistants, view: "timeline", groupBy: "none" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "turn:outside-page",
      title: "Continuation of an earlier turn",
      toolCount: 50,
    })
    expect(sessionHistoryMissingParentIDs(assistants)).toEqual(["outside-page"])
  })

  test("renders distinct timeline, tree, and pages behavior", () => {
    const user = message({ id: "usr", role: "user", text: "Fix the history" })
    const assistant = message({ id: "ast", role: "assistant", parentID: "usr", text: "Fixed it" })
    const items = [user, assistant]
    expect(sessionHistoryRows({ items, view: "timeline", groupBy: "none" }).map((row) => row.kind)).toEqual(["turn"])
    expect(sessionHistoryRows({ items, view: "tree", groupBy: "none" }).map((row) => row.kind)).toEqual([
      "turn",
      "response",
    ])
    expect(sessionHistoryRows({ items, view: "pages", groupBy: "none" }).map((row) => row.kind)).toEqual(["turn"])
    expect(nextSessionHistoryView("timeline")).toBe("tree")
    expect(nextSessionHistoryView("tree")).toBe("pages")
    expect(nextSessionHistoryView("pages")).toBe("timeline")
    expect(sessionHistoryTurnCount(items)).toBe(1)
  })

  test("keeps the parent visible when search matches a response and honors collapse", () => {
    const user = message({ id: "usr", role: "user", text: "Old request" })
    const assistant = message({ id: "ast", role: "assistant", parentID: "usr", text: "Unique lighthouse result" })
    expect(
      sessionHistoryRows({ items: [user, assistant], view: "timeline", groupBy: "none", query: "lighthouse" }).map(
        (row) => row.id,
      ),
    ).toEqual(["turn:usr"])
    expect(
      sessionHistoryRows({
        items: [user, assistant],
        view: "tree",
        groupBy: "none",
        collapsed: new Set(["usr"]),
      }).map((row) => row.id),
    ).toEqual(["turn:usr"])
  })

  test("keeps navigation and layout bounded", () => {
    expect(sessionHistoryLayout({ terminalWidth: 140, split: true, previewWidth: 58 })).toEqual({
      paddingX: 2,
      width: 136,
      listWidth: 57,
      previewWidth: 78,
    })
    expect(sessionHistoryLayout({ terminalWidth: 140, split: false, previewWidth: 58 })).toEqual({
      paddingX: 2,
      width: 136,
      listWidth: 136,
      previewWidth: 0,
    })
    expect(sessionHistorySelectionOffset("j")).toBe(1)
    expect(sessionHistorySelectionOffset("up")).toBe(-1)
    expect(sessionHistorySelectionOffset("x")).toBe(0)
    expect(sessionHistoryBoundaryVisible({ enabled: true, hasMoreOlder: true })).toBe(true)
    expect(sessionHistoryBoundaryVisible({ enabled: false, hasMoreOlder: true })).toBe(false)
  })
})
