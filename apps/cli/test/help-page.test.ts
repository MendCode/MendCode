import { describe, expect, test } from "bun:test"
import { renderHelpPage } from "../src/view/help-page"
import { SLASH_COMMANDS } from "../src/view/commands"
import type { Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")
const render = (width: number, height: number) => renderHelpPage({ width, height })
const keyCount = Number(/(\d+) keys/.exec(text(render(120, 35)[1]!))![1])

describe("help page chrome", () => {
  test("page header carries hints; summary and bordered panels use the width", () => {
    const lines = render(120, 35)
    const title = text(lines[0]!)
    expect(title.trimStart()).toStartWith("Help")
    expect(text(lines[1]!)).toContain(`${keyCount} keys · ${SLASH_COMMANDS.length} commands`)
    expect(title).not.toContain("MENDCODE")
    expect(title).not.toContain("LIVE")
    expect(title).toContain("esc back")
    expect(text(lines[2]!)).toContain("Keys")
  })

  test("lists keys and every slash command somewhere in the body", () => {
    const lines = render(160, Math.max(60, SLASH_COMMANDS.length + 9)).map(text).join("\n")
    expect(lines).toContain("send")
    expect(lines).toContain("cancel turn")
    for (const command of SLASH_COMMANDS) expect(lines).toContain(`/${command.name}`)
  })

  test("keeps key hints in the page header", () => {
    const lines = render(120, 35).map(text)
    expect(lines[0]).toContain("esc back")
    expect(lines.at(-1)).not.toContain("esc back")
  })

  test("side by side from 70 columns, single column below it", () => {
    const wide = render(140, 40).map(text)
    const keysRow = wide.findIndex((line) => line.includes("Keys"))
    const commandsRow = wide.findIndex((line) => line.includes("Commands"))
    expect(keysRow).toBeGreaterThanOrEqual(0)
    expect(commandsRow).toBeGreaterThanOrEqual(0)
    expect(keysRow).toBe(commandsRow)

    const narrow = render(60, 60).map(text)
    const narrowKeysRow = narrow.findIndex((line) => line.includes("Keys"))
    const narrowCommandsRow = narrow.findIndex((line) => line.includes("Commands"))
    expect(narrowKeysRow).toBeGreaterThanOrEqual(0)
    expect(narrowCommandsRow).toBeGreaterThan(narrowKeysRow)
  })

  test("sections share the bordered panel grid", () => {
    const lines = render(140, 40)
    const title = lines.flatMap((line) => line).find((span) => span.text.includes("Keys"))
    expect(title).toMatchObject({ fg: "primary" })
    expect(lines.map(text).join("")).toMatch(/[┌┐└┘│]/)
  })
})

describe("help page fills exactly width x height at every tier", () => {
  test("is exactly width x height at 60x20, 80x30, 120x40 and 160x50", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      const lines = render(width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBe(width)
    }
  })

  test("never exceeds width or height at the other sizes", () => {
    for (const width of [60, 90, 120, 160]) {
      for (const height of [20, 35, 50]) {
        const lines = render(width, height)
        expect(lines.length).toBeLessThanOrEqual(height)
        for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test("keeps the Keys section even at a very small height", () => {
    const lines = render(80, 12).map(text)
    expect(lines.join("\n")).toContain("Keys")
  })
})
