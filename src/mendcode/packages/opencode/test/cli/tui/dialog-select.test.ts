import { describe, expect, test } from "bun:test"
import {
  compactDialogSelectOption,
  dialogSelectOptionMaxWidth,
  normalizeDialogSelectText,
  searchDialogOptions,
  selectedDialogOptionIndex,
  sameDialogSelectText,
  shouldHandleDialogSelectCustomKeybinds,
} from "../../../src/cli/cmd/tui/ui/dialog-select"

const commandOptions = [
  {
    title: "Open Usage Insights",
    value: "stats",
    category: "Insights",
    searchText: "Open Usage Insights Insights /stats /usage",
  },
  {
    title: "Open Project Usage Insights",
    value: "project-stats",
    category: "Insights",
    searchText: "Open Project Usage Insights Insights /stats-project /project-stats",
  },
  {
    title: "Configure Status Separator",
    value: "status-separator",
    category: "Chat",
    searchText: "Configure Status Separator Chat /prompt-status-separator",
  },
  {
    title: "View Runtime Status",
    value: "runtime-status",
    category: "Tools",
    searchText: "View Runtime Status Tools /status",
  },
]

describe("DialogSelect command search", () => {
  test("matches stats without treating status as stats", () => {
    expect(searchDialogOptions("stats", commandOptions, true).map((option) => option.value)).toEqual([
      "stats",
      "project-stats",
    ])
  })

  test("keeps slash searches scoped to slash names", () => {
    expect(searchDialogOptions("/stats", commandOptions, true).map((option) => option.value)).toEqual([
      "stats",
      "project-stats",
    ])
    expect(searchDialogOptions("/unknown", commandOptions, true)).toEqual([])
  })
})

describe("DialogSelect custom keybinds", () => {
  test("ignores custom keybinds while typing in the focused filter input", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: true }, "clau")).toBe(false)
  })

  test("allows custom keybinds for the selected option when the focused filter is empty", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: true }, "")).toBe(true)
  })

  test("allows custom keybinds when the filter input is not focused", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: false }, "clau")).toBe(true)
    expect(shouldHandleDialogSelectCustomKeybinds(undefined, "clau")).toBe(true)
  })
})

describe("DialogSelect option layout", () => {
  test("normalizes whitespace and drops duplicate title descriptions", () => {
    expect(normalizeDialogSelectText("  Chat\n presentation  ")).toBe("Chat presentation")
    expect(sameDialogSelectText("Chat presentation", " Chat\tpresentation ")).toBe(true)
    expect(
      compactDialogSelectOption({
        title: "Chat presentation",
        description: "Chat\n presentation",
        maxWidth: 40,
      }),
    ).toEqual({ title: "Chat presentation", description: undefined })
  })

  test("truncates long descriptions to one predictable row budget", () => {
    const option = compactDialogSelectOption({
      title: "Full",
      description: "Full rich messages with Markdown, lists, tables, and local Mermaid rendering.",
      maxWidth: 24,
    })

    expect(option.title).toBe("Full")
    expect(option.description).toHaveLength(19)
    expect(option.description?.endsWith("…")).toBe(true)
  })

  test("reduces the display budget on narrow terminals without changing command caps", () => {
    expect(dialogSelectOptionMaxWidth(80)).toBe(60)
    expect(dialogSelectOptionMaxWidth(40)).toBe(20)
    expect(dialogSelectOptionMaxWidth(40, true)).toBe(22)
    expect(dialogSelectOptionMaxWidth(140, true)).toBe(96)
  })

  test("keeps the current option index stable for keyboard selection", () => {
    const options = [
      { title: "Raw", value: "raw" },
      { title: "Minimal", value: "minimal" },
      { title: "Full", value: "mendcode" },
    ]

    expect(selectedDialogOptionIndex(options, "mendcode")).toBe(2)
    expect(selectedDialogOptionIndex(options, "missing")).toBe(-1)
  })
})
