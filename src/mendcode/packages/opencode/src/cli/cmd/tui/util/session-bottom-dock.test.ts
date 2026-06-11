import { describe, expect, test } from "bun:test"
import { sessionBottomDockLayout, sessionTodoPanelWidth } from "./session-bottom-dock"

describe("session bottom dock layout", () => {
  test("keeps room for notes beside todos when the dock has side space", () => {
    const layout = sessionBottomDockLayout({
      width: 120,
      todos: [
        { content: "Mapear toasts, forms y mapas actuales", status: "completed" },
        { content: "Auto-review post-sprint", status: "in_progress" },
      ],
    })

    expect(layout.todoWidth).toBeLessThan(layout.dockWidth)
    expect(layout.showNotes).toBe(true)
    expect(layout.notesWidth).toBeGreaterThanOrEqual(28)
  })

  test("caps long todos to keep notes visible when the dock has minimum side room", () => {
    const layout = sessionBottomDockLayout({
      width: 72,
      todos: [
        {
          content:
            "Mejorar DriverForm con smart inputs y validacion/formato conservando el layout compacto del prompt",
          status: "in_progress",
        },
      ],
    })

    expect(layout.todoWidth).toBeLessThan(layout.dockWidth)
    expect(layout.showNotes).toBe(true)
    expect(layout.notesWidth).toBeGreaterThanOrEqual(28)
    expect(layout.showInfo).toBe(false)
  })

  test("does not leave a right-side clearance column when the terminal is narrow", () => {
    const layout = sessionBottomDockLayout({
      width: 44,
      todos: [
        {
          content: "Terminal should keep all visible columns after resize",
          status: "in_progress",
        },
      ],
    })

    expect(layout.dockWidth).toBe(44)
    expect(layout.todoWidth).toBe(44)
    expect(layout.showNotes).toBe(false)
    expect(layout.showInfo).toBe(false)
  })

  test("shows notes, subagents, and info by default when all side widgets fit", () => {
    const layout = sessionBottomDockLayout({
      width: 120,
      todos: [
        {
          content:
            "Mejorar DriverForm con smart inputs y validacion/formato conservando el layout compacto del prompt",
          status: "in_progress",
        },
      ],
    })

    expect(layout.showNotes).toBe(true)
    expect(layout.showSubagents).toBe(true)
    expect(layout.showInfo).toBe(true)
    expect(layout.notesWidth).toBeGreaterThanOrEqual(28)
    expect(layout.subagentsWidth).toBeGreaterThanOrEqual(28)
    expect(layout.infoWidth).toBeGreaterThanOrEqual(24)
  })

  test("shows subagents with notes and info when all side widgets fit", () => {
    const layout = sessionBottomDockLayout({
      width: 150,
      subagentCount: 2,
      todos: [
        {
          content: "Coordinate subagent followups",
          status: "in_progress",
        },
      ],
    })

    expect(layout.showNotes).toBe(true)
    expect(layout.showSubagents).toBe(true)
    expect(layout.showInfo).toBe(true)
    expect(layout.subagentsWidth).toBeGreaterThanOrEqual(28)
  })

  test("prioritizes subagents over info when child sessions exist and width is limited", () => {
    const layout = sessionBottomDockLayout({
      width: 96,
      subagentCount: 1,
      todos: [
        {
          content: "Short task",
          status: "in_progress",
        },
      ],
    })

    expect(layout.showNotes).toBe(true)
    expect(layout.showSubagents).toBe(true)
    expect(layout.showInfo).toBe(false)
    expect(layout.subagentsWidth).toBeGreaterThanOrEqual(28)
  })

  test("todo panel width uses the collapsed list instead of hidden items", () => {
    const todos = Array.from({ length: 12 }, (_, index) => ({
      content: index === 11 ? "hidden item with very very very long text that should not set collapsed width" : "short",
      status: "pending",
    }))

    const collapsed = sessionTodoPanelWidth({ todos, maxWidth: 120, expanded: false, collapsedLimit: 7 })
    const expanded = sessionTodoPanelWidth({ todos, maxWidth: 120, expanded: true, collapsedLimit: 7 })

    expect(collapsed).toBeLessThan(expanded)
  })
})
