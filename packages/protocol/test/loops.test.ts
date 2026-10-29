import { describe, expect, test } from "bun:test"
import { Command, createIdFactory } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const update = { ...base, type: "loop.update" as const, loopId: ids("loop") }

describe("loop.update wire contract", () => {
  test("accepts partial patches and explicit clears without requiring create fields", () => {
    expect(Command.safeParse(update).success).toBe(true)
    expect(Command.parse({ ...update, name: "edited" })).toEqual({ ...update, name: "edited" })
    expect(Command.safeParse({ ...update, criteria: "", checks: [], audit: "none", reportOnly: false, workspace: "in-place" }).success).toBe(true)
  })

  test("requires identity and rejects lifecycle, history and creation-only directory edits", () => {
    expect(Command.safeParse({ ...base, type: "loop.update", name: "edited" }).success).toBe(false)
    expect(Command.safeParse({ type: "loop.update", loopId: update.loopId }).success).toBe(false)
    for (const patch of [{ directory: "/other" }, { state: "active" }, { history: [] }, { sessionId: ids("session") }]) expect(Command.safeParse({ ...update, ...patch }).success).toBe(false)
  })

  test("uses create's field validation and leaves create's required fields intact", () => {
    for (const patch of [{ name: "" }, { objective: "" }, { trigger: { kind: "daily", at: "25:00" } }, { trigger: { kind: "interval", everyMs: 1 } }, { trigger: { kind: "adaptive", everyMs: 60_000, maxMs: 1 } }, { budget: { mode: "fixed", maxRuns: 0 } }]) {
      expect(Command.safeParse({ ...update, ...patch }).success).toBe(false)
    }
    expect(Command.safeParse({ ...base, type: "loop.create", name: "new", directory: "/repo" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "loop.create", name: "new", directory: "/repo", template: "research-digest" }).success).toBe(true)
  })
})
