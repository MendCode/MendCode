import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderToolCard, type ToolCardInput } from "../src/view/tool-card"

const plain = (line: Line) => line.map((span) => span.text).join("").trimEnd()
const card = (input: Partial<ToolCardInput> & Pick<ToolCardInput, "title" | "text">) => renderToolCard({ status: "ok", width: 80, expanded: false, frame: 0, tailLines: 4, ...input })
const rows = (input: Parameters<typeof card>[0]) => card(input).map(plain)

describe("what a bot learns shows as its own cards", () => {
  test("a saved note is 'Learned' with its scope in the accent role and the note as the target", () => {
    const lines = card({ title: "bot_note", text: "Learned (this project)\nDeploys go through staging first", meta: { action: "note", scope: "project" }, level: "summary" })
    expect(lines.map(plain)).toEqual(["   ✦ Learned Deploys go through staging first  this project"])
    const scope = lines[0]!.find((span) => span.text === "this project")
    expect(scope).toMatchObject({ fg: "accent" })
  })

  test("a new skill says so, names the skill and shows its description; the steps open under it in two rows", () => {
    const text = "Saved skill triage\nSort incoming issues\n1. Read the issue\n2. Label it\n3. Assign it\n4. Reply"
    const meta = { action: "create", name: "triage", created: true }
    expect(rows({ title: "bot_skill: triage", text, meta, level: "summary" })).toEqual(["   ✧ New skill triage  Sort incoming issues"])
    const balanced = rows({ title: "bot_skill: triage", text, meta, level: "preview" })
    expect(balanced[0]).toBe("   ✧ New skill triage  Sort incoming issues")
    expect(balanced.slice(1, 3)).toEqual(["   │ 1. Read the issue", "   │ 2. Label it"])
    expect(balanced.at(-1)).toBe("   │ … +2 lines")
    const opened = rows({ title: "bot_skill: triage", text, meta, level: "full", expanded: true })
    expect(opened.join("\n")).toContain("4. Reply")
  })

  test("an update and a schedule have their own words and glyphs", () => {
    expect(rows({ title: "bot_skill: triage", text: "Updated skill triage\nSort issues\nbody", meta: { action: "update", name: "triage" }, level: "summary" })[0]).toContain("✧ Skill updated triage")
    const scheduled = rows({ title: "bot_schedule: Morning digest", text: 'Scheduled "Morning digest" daily 09:00\nloopId=lop_1', meta: { action: "create", loopId: "lop_1", trigger: "daily 09:00" }, level: "summary" })
    expect(scheduled).toEqual(["   ◴ Scheduled Morning digest  daily 09:00"])
  })

  test("ASCII mode swaps the glyphs and a failed call says so", () => {
    expect(card({ title: "bot_note", text: "Learned (everywhere)\nPrefers Spanish", meta: { action: "note" }, level: "summary", ascii: true } as never).map(plain)[0]).toContain("* Learned")
    const failed = rows({ title: "bot_skill: triage", text: "[BOT]: skill triage already exists; use action=update", status: "error", level: "summary" })
    expect(failed[0]).toContain("✗")
    expect(failed.join("\n")).toContain("already exists")
  })
})
