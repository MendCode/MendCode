import { describe, expect, test } from "bun:test"
import { expectedSum, parseSums, sha256Hex, verifyChecksum } from "../src/checksum"
import type { UpgradeError } from "../src/errors"

const bytes = new TextEncoder().encode("binary content")
const digest = sha256Hex(bytes)

function codeOf(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return (error as UpgradeError).code
  }
  return "no error"
}

describe("SHA256SUMS", () => {
  test("sha256Hex matches a known vector", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("parses text and binary mode lines, lowercases digests and ignores junk", () => {
    const sums = parseSums(`${digest.toUpperCase()}  mendcode-linux-x64\n${digest} *mendcode-darwin-arm64\nnot a checksum line\n\n`)
    expect(sums.get("mendcode-linux-x64")).toBe(digest)
    expect(sums.get("mendcode-darwin-arm64")).toBe(digest)
    expect(sums.size).toBe(2)
  })

  test("a matching digest verifies", () => {
    expect(() => verifyChecksum({ name: "mendcode-linux-x64", bytes, expected: digest })).not.toThrow()
  })

  test("a mismatching digest is refused", () => {
    expect(codeOf(() => verifyChecksum({ name: "mendcode-linux-x64", bytes, expected: sha256Hex(new TextEncoder().encode("other")) }))).toBe("checksum-mismatch")
  })

  test("a missing entry is refused", () => {
    expect(codeOf(() => expectedSum(parseSums(`${digest}  something-else\n`), "mendcode-linux-x64"))).toBe("checksum-missing")
  })

  test("a truncated digest line does not count as an entry", () => {
    expect(parseSums(`${digest.slice(0, 40)}  mendcode-linux-x64\n`).size).toBe(0)
  })

  test("duplicate entries are refused even when both digests agree", () => {
    expect(() => parseSums(`${digest}  binary\n${digest} *binary\n`)).toThrow("duplicate entries")
  })
})
