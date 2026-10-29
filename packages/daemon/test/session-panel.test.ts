import { expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { sessionPanelSavings } from "../src/session-panel"

test("remote and peer panel queries are refused before any session or projection read", () => {
  let reads = 0
  const store = {
    hasSession: () => {
      reads++
      return true
    },
    usageScopes: { sessionSavings: () => {
      reads++
      return []
    } },
  } as unknown as Parameters<typeof sessionPanelSavings>[0]
  const id = createIdFactory()("session")
  for (const connection of [{ remoteAddress: "127.0.0.1" }, { peer: { mode: "full" } }]) {
    expect(sessionPanelSavings(store, id, connection)).toMatchObject({ ok: false, code: "invalid_command" })
    expect(reads).toBe(0)
  }
  expect(sessionPanelSavings(store, id, {})).toEqual({ ok: true, result: { savings: [] } })
  expect(reads).toBe(2)
})
