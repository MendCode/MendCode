import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ids = createIdFactory()
const T0 = new Date(2026, 9, 10, 9, 0).getTime()
const DAY = "2026-10-10"

test("auxiliary calls roll up per day, role and model, scope by directory, survive their session and never touch the turn sums", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-aux-"))
  dirs.push(dir)
  let store = openStore({ dir, now: () => T0 })
  const here = ids("session")
  store.createSession({ id: here, directory: "/repo", title: "here" })
  const call = { at: T0, provider: "chatgpt", model: "gpt-6-luna", input: 1_000, output: 20 }
  store.usageAuxiliary.record({ ...call, role: "summary", sessionId: here, directory: "/repo", costMicros: 7 })
  store.usageAuxiliary.record({ ...call, role: "summary", sessionId: here, directory: "/repo", reasoning: 5, cacheRead: 300 })
  store.usageAuxiliary.record({ ...call, role: "setup", directory: "/elsewhere", input: 50, output: 5, costMicros: 2 })
  // The next day is outside the range.
  store.usageAuxiliary.record({ ...call, at: T0 + 86_400_000, role: "title", sessionId: here, directory: "/repo" })

  const summary = { role: "summary", provider: "chatgpt", model: "gpt-6-luna", input: 2_000, output: 40, reasoning: 5, cacheRead: 300, cacheWrite: 0, calls: 2, costMicros: 7, costUnknownCalls: 1 }
  const setup = { role: "setup", provider: "chatgpt", model: "gpt-6-luna", input: 50, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 1, costMicros: 2, costUnknownCalls: 0 }
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY })).toEqual([summary, setup])
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: ["/repo"] })).toEqual([summary])
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: [] })).toEqual([])
  expect(store.usageDaily({ from: DAY, to: DAY })).toEqual([])
  expect(store.usageByModel({ from: DAY, to: DAY })).toEqual([])

  // Rows outlive the session and a reopen.
  store.deleteSession(here)
  store.close()
  store = openStore({ dir, now: () => T0 })
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY })).toEqual([summary, setup])
  store.close()
})
