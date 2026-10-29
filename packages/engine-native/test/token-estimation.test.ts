import { expect, test } from "bun:test"
import { estimateTokens } from "@mendcode/protocol/wire"
import { estimateTokens as dreamTokens } from "../../dream/src/meter"
import { messageTokens } from "../src/compaction-policy"
import { requestEstimates } from "../src/request-profile"

test("one text estimator rounds incomplete groups up and preserves empty text", () => {
  expect([0, 1, 2, 3, 4, 5, 7, 8, 9].map(estimateTokens)).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 3])
  expect(dreamTokens).toBe(estimateTokens)
  // JavaScript text lengths (UTF-16), not bytes or grapheme counts; no guessed image tokens.
  const message = { role: "user" as const, content: "界🙂", attachments: [] }
  expect(messageTokens(message)).toBe(estimateTokens(JSON.stringify({ content: message.content, attachments: [] }).length))
  const report = requestEstimates("abcde", [], [message], [])
  expect(report).toMatchObject({ instructions: 2, history: 1, toolSchemas: 1, media: 0, total: 4 })
})
