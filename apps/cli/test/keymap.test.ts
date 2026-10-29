import { describe, expect, test } from "bun:test"
import { keymapHelp, LEADER_KEY, LEADER_TIMEOUT_MS, leaderHint, resolveKey, type LeaderState } from "../src/ui/keymap"

describe("keymap", () => {
  test("ctrl+x arms the leader; the next key picks the chord's action and disarms", () => {
    const state: LeaderState = {}
    expect(resolveKey(state, LEADER_KEY, 1_000)).toEqual({ kind: "armed" })
    expect(resolveKey(state, "n", 1_500)).toEqual({ kind: "action", action: "new" })
    expect(state.armedAt).toBeUndefined()
    expect(resolveKey(state, "n", 1_600)).toEqual({ kind: "pass" })
  })

  test("an unknown key while armed cancels and is swallowed; an expired leader lets the key through", () => {
    const state: LeaderState = {}
    resolveKey(state, LEADER_KEY, 0)
    expect(resolveKey(state, "7", 10)).toEqual({ kind: "cancelled" })
    resolveKey(state, LEADER_KEY, 0)
    expect(resolveKey(state, "n", LEADER_TIMEOUT_MS + 1)).toEqual({ kind: "pass" })
  })

  test("chord keys are case-insensitive and cover v1's where MendCode has the action", () => {
    const pick = (key: string) => {
      const state: LeaderState = {}
      resolveKey(state, LEADER_KEY, 0)
      return resolveKey(state, key, 1)
    }
    expect(pick("L")).toEqual({ kind: "action", action: "sessions" })
    expect(pick("m")).toEqual({ kind: "action", action: "model" })
    expect(pick("t")).toEqual({ kind: "action", action: "theme" })
    expect(pick("c")).toEqual({ kind: "action", action: "compact" })
    expect(pick("q")).toEqual({ kind: "action", action: "quit" })
  })

  test("direct keys: ctrl+t, and F2/F3 in both terminal encodings", () => {
    expect(resolveKey({}, "\x14", 0)).toEqual({ kind: "action", action: "dock" })
    for (const f2 of ["\x1bOQ", "\x1b[12~"]) expect(resolveKey({}, f2, 0)).toEqual({ kind: "action", action: "model.next" })
    for (const f3 of ["\x1bOR", "\x1b[13~"]) expect(resolveKey({}, f3, 0)).toEqual({ kind: "action", action: "effort.next" })
    expect(resolveKey({}, "a", 0)).toEqual({ kind: "pass" })
  })

  test("help rows and the armed hint list every binding", () => {
    const help = keymapHelp()
    expect(help).toContainEqual({ keys: "ctrl+x n", label: "new session" })
    expect(help).toContainEqual({ keys: "f2", label: "next model" })
    expect(leaderHint()).toStartWith("ctrl+x · n new session · l sessions")
  })
})
