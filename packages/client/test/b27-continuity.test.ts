import { expect, test } from "bun:test"
import { commandTimeout } from "../src"

test("bounded continuity waits have an individual RPC deadline; ordinary requests keep the configured timeout", () => {
  const sessionId = "ses_test" as import("@mendcode/protocol").SessionId
  expect(commandTimeout({ type: "continuity.wait", sessionId, recordIds: ["job_1"], timeoutMs: 60000 }, 15000)).toBe(65000)
  expect(commandTimeout({ type: "continuity.wait", sessionId, recordIds: ["job_1"] }, 1000)).toBe(15000)
  expect(commandTimeout({ type: "continuity.get", sessionId, recordId: "job_1" }, 1000)).toBe(1000)
  expect(commandTimeout({ type: "continuity.wait", sessionId, recordIds: ["job_1"], timeoutMs: 0 }, 100000)).toBe(100000)
})
