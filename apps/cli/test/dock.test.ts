import { describe, expect, test } from "bun:test"
import { DOCK_HEIGHT, parseTodoText, renderDock, type DockInfo } from "../src/view/dock"
import { textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"

const text = (line: Line) => line.map((span) => span.text).join("")
const info: DockInfo = { branch: "main", cwd: "~/Code/app", context: "42%", permission: "ask", model: "gpt-6-luna · low", activity: "idle" }
const todos = parseTodoText("[x] write tests\n[~] fix the reconnect\n[ ] ship it\n[-] drop the old flag\nnot a todo line")

describe("dock", () => {
  test("todo text parses into items with their status", () => {
    expect(todos).toEqual([
      { text: "write tests", status: "done" },
      { text: "fix the reconnect", status: "in_progress" },
      { text: "ship it", status: "pending" },
      { text: "drop the old flag", status: "cancelled" },
    ])
  })

  test("Todos, Subagents and Info side by side on the panel fill, exactly DOCK_HEIGHT × width", () => {
    const rows = renderDock({ width: 140, todos, subagents: [{ label: "Explore auth flow", status: "working", tone: "warning" }], info })
    expect(rows).toHaveLength(DOCK_HEIGHT)
    for (const row of rows) expect(textWidth(text(row))).toBe(140)
    const all = rows.map(text).join("\n")
    expect(all).toContain("Todos")
    expect(all).toContain("2 open")
    expect(all).toContain("▸ fix the reconnect")
    expect(all).toContain("Subagents")
    expect(all).toContain("Explore auth flow")
    expect(all).toContain("Info")
    expect(all).toContain("gpt-6-luna · low")
    const cells = rows.flatMap((row) => row.filter((span) => span.text.trim()))
    expect(rows.flat().some((span) => span.fg === "border")).toBe(true)
    expect(rows.flat().find((span) => span.text.startsWith("▸"))).toMatchObject({ fg: "warning" })
  })

  test("narrow widths drop Subagents, then Todos; Info always stays; empty todos say so", () => {
    const sub = [{ label: "x", status: "working", tone: "warning" as const }]
    expect(renderDock({ width: 60, todos, subagents: sub, info }).map(text).join("\n")).not.toContain("Subagents")
    const tiny = renderDock({ width: 40, todos, subagents: sub, info }).map(text).join("\n")
    expect(tiny).not.toContain("Todos")
    expect(tiny).toContain("Info")
    expect(renderDock({ width: 80, todos: [], subagents: [], info }).map(text).join("\n")).toContain("□ No todo items.")
  })

  test("more todos than rows end with +N more", () => {
    const many = parseTodoText(Array.from({ length: 9 }, (_, i) => `[ ] task ${i}`).join("\n"))
    // Five rows under the header: four tasks, then the count of the rest.
    expect(renderDock({ width: 80, todos: many, subagents: [], info }).map(text).join("\n")).toContain("+5 more")
  })
})
