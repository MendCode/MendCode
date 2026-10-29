import { expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol/wire"
import { commandTimeout } from "../src"

const ids = createIdFactory()
const sessionId = ids("session"), taskId = ids("session")
test("child waits and foreground task runs have their own RPC deadline", () => {
  expect(commandTimeout({ type: "task.status", sessionId, taskId, action: "wait" }, 15_000)).toBe(35_000)
  expect(commandTimeout({ type: "task.status", sessionId, taskId, action: "wait", timeoutMs: 300_000 }, 15_000)).toBe(305_000)
  expect(commandTimeout({ type: "task.run", sessionId, input: { description: "Review", prompt: "Inspect" } }, 15_000)).toBe(3_600_000)
})
test("background admission, quick status and larger configured deadlines keep the original budget", () => {
  expect(commandTimeout({ type: "task.run", sessionId, input: { description: "Review", prompt: "Inspect", background: true } }, 15_000)).toBe(15_000)
  expect(commandTimeout({ type: "task.status", sessionId, taskId, action: "get" }, 1000)).toBe(1000)
  expect(commandTimeout({ type: "task.status", sessionId, taskId, action: "wait", timeoutMs: 1000 }, 60_000)).toBe(60_000)
})
