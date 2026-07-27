import { describe, expect, test } from "bun:test"
import {
  searchDialogOptions,
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
