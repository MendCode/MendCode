import { describe, expect, test } from "bun:test"
import {
  promptHistoryRecordFromUnknown,
  promptHistoryRecordsForScope,
  type PromptInfo,
} from "../../../../src/cli/cmd/tui/component/prompt/history"

const prompt = (input: string): PromptInfo => ({ input, parts: [] })

describe("prompt history scope", () => {
  test("reads legacy unscoped entries", () => {
    expect(promptHistoryRecordFromUnknown(prompt("old global"))).toEqual({ prompt: prompt("old global") })
  })

  test("reads scoped entries", () => {
    expect(promptHistoryRecordFromUnknown({ scope: "session:ses_1", prompt: prompt("scoped") })).toEqual({
      scope: "session:ses_1",
      prompt: prompt("scoped"),
    })
  })

  test("filters history by exact scope", () => {
    const records = [
      { scope: "project:repo-a", prompt: prompt("home a") },
      { scope: "project:repo-b", prompt: prompt("home b") },
      { scope: "session:ses_1", prompt: prompt("session 1") },
      { scope: "session:ses_2", prompt: prompt("session 2") },
      { prompt: prompt("legacy") },
    ]

    expect(promptHistoryRecordsForScope(records, "session:ses_1").map((record) => record.prompt.input)).toEqual([
      "session 1",
    ])
    expect(promptHistoryRecordsForScope(records, "project:repo-a").map((record) => record.prompt.input)).toEqual([
      "home a",
    ])
    expect(promptHistoryRecordsForScope(records).map((record) => record.prompt.input)).toEqual(["legacy"])
  })
})
