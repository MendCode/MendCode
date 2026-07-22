import { describe, expect, test } from "bun:test"
import { parseState } from "../../../src/cli/cmd/tui/shared-server"

const valid = {
  version: 1 as const,
  pid: 123,
  url: "http://127.0.0.1:4096/",
  username: "mendcode",
  password: "local-secret",
  startedAt: "2026-07-19T00:00:00.000Z",
}

describe("shared server state", () => {
  test("accepts a valid loopback server state", () => {
    expect(parseState(valid)).toEqual(valid)
  })

  test("rejects malformed or non-loopback state", () => {
    expect(parseState({ ...valid, pid: 0 })).toBeUndefined()
    expect(parseState({ ...valid, url: "http://user:password@127.0.0.1:4096/" })).toBeUndefined()
    expect(parseState({ ...valid, url: "http://0.0.0.0:4096/" })).toBeUndefined()
  })
})
