import { describe, expect, test } from "bun:test"
import {
  movePromptHistoryItems,
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

  test("moves through supplied message history without reading other scopes", () => {
    const items = [prompt("session old"), prompt("session latest")]

    const latest = movePromptHistoryItems({ items, index: 0, direction: -1, currentPromptMatchesHistory: true })
    expect(latest).toEqual({ index: -1, prompt: prompt("session latest") })

    const previous = movePromptHistoryItems({ items, index: -1, direction: -1, currentPromptMatchesHistory: true })
    expect(previous).toEqual({ index: -2, prompt: prompt("session old") })

    const newer = movePromptHistoryItems({ items, index: -2, direction: 1, currentPromptMatchesHistory: true })
    expect(newer).toEqual({ index: -1, prompt: prompt("session latest") })

    const blank = movePromptHistoryItems({ items, index: -1, direction: 1, currentPromptMatchesHistory: true })
    expect(blank).toEqual({ index: 0, prompt: prompt("") })

    expect(movePromptHistoryItems({ items, index: -2, direction: -1, currentPromptMatchesHistory: true })).toBeUndefined()
  })

  test("does not move supplied message history after the user edits the recalled prompt", () => {
    expect(
      movePromptHistoryItems({
        items: [prompt("session prompt")],
        index: -1,
        direction: -1,
        currentPromptMatchesHistory: false,
      }),
    ).toBeUndefined()
  })

  test("does not move supplied message history after attachment-only edits", () => {
    expect(
      movePromptHistoryItems({
        items: [prompt("same text")],
        index: -1,
        direction: 1,
        currentPromptMatchesHistory: false,
      }),
    ).toBeUndefined()
  })
})
