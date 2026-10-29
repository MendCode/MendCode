import { describe, expect, test } from "bun:test"
import { ptyAvailable } from "../src/pty-native"

describe("pty availability", () => {
  test("needs a runtime terminal", () => {
    expect(ptyAvailable({ platform: "linux", env: {}, terminal: false })).toBe(false)
    expect(ptyAvailable({ platform: "darwin", env: {}, terminal: true })).toBe(true)
  })

  test("Windows ConPTY stays off unless MENDCODE_V2_CONPTY=1 and the runtime exposes a terminal", () => {
    expect(ptyAvailable({ platform: "win32", env: {}, terminal: true })).toBe(false)
    expect(ptyAvailable({ platform: "win32", env: { MENDCODE_V2_CONPTY: "0" }, terminal: true })).toBe(false)
    expect(ptyAvailable({ platform: "win32", env: { MENDCODE_V2_CONPTY: "1" }, terminal: false })).toBe(false)
    expect(ptyAvailable({ platform: "win32", env: { MENDCODE_V2_CONPTY: "1" }, terminal: true })).toBe(true)
  })
})
