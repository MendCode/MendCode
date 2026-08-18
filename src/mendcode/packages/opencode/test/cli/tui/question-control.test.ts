import { describe, expect, test } from "bun:test"
import {
  normalizeQuestionControlOutbox,
  type QuestionControlEntry,
} from "../../../src/cli/cmd/tui/context/question-control"

const base: QuestionControlEntry = {
  id: "workspace\u0000question-1\u0000reply",
  requestID: "question-1",
  sessionID: "session-1",
  action: "reply",
  answers: [["Aprobado"]],
  workspace: "workspace",
  requestedAt: 100,
  attempts: 0,
}

describe("question control outbox", () => {
  test("keeps one stable answer for reconnect retries", () => {
    const duplicate = { ...base, requestedAt: 101, attempts: 1 }
    expect(normalizeQuestionControlOutbox([base, duplicate], 101)).toEqual([duplicate])
  })

  test("drops malformed and expired responses while retaining recent rejects", () => {
    const reject: QuestionControlEntry = {
      ...base,
      id: "workspace\u0000question-2\u0000reject",
      requestID: "question-2",
      action: "reject",
      answers: undefined,
      requestedAt: 100,
    }
    expect(normalizeQuestionControlOutbox([base, reject, null, { requestID: "bad" }], 100)).toEqual([base, reject])
    expect(normalizeQuestionControlOutbox([base], 100 + 7 * 24 * 60 * 60 * 1000 + 1)).toEqual([])
  })
})
