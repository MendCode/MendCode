import { describe, expect, test } from "bun:test"
import { findSecrets, redactSecrets, replaceSecretMarkers, replaceSecrets, secretMarker } from "../src/wire"

const alnum = (length: number) => "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0".repeat(Math.ceil(length / 30)).slice(0, length)
const openai = "s" + "k-" + alnum(48)
const github = "gh" + "p_" + "a".repeat(36)
const awsKey = "AK" + "IA" + "ABCDEFGHIJKLMNOP"
const jwt = "ey" + "J" + alnum(20) + "." + "ey" + "J" + alnum(30) + "." + alnum(43)

describe("findSecrets", () => {
  test("returns each distinct value once with the kind of its first detection, in order", () => {
    const text = `key ${openai} and ${github} again ${openai} PASSWORD=hunter2hunter2 ${awsKey} token ${jwt}`
    expect(findSecrets(text)).toEqual([
      { kind: "openai-key", value: openai },
      { kind: "github-token", value: github },
      { kind: "aws-access-key-id", value: awsKey },
      { kind: "jwt", value: jwt },
      { kind: "password", value: "hunter2hunter2" },
    ])
  })

  test("finds nothing in prose, placeholders and markers", () => {
    expect(findSecrets("set PASSWORD=<your password> and API_KEY=${KEY}, then use ‹secret:1› or PASSWORD=‹secret:2›")).toEqual([])
  })

  test("the same detection drives redactSecrets, which behaves as before", () => {
    const text = `a ${openai} b PASSWORD=hunter2hunter2`
    expect(redactSecrets(text)).toEqual({ text: "a [redacted:openai-key] b PASSWORD=[redacted:password]", count: 2 })
  })
})

describe("replaceSecrets with markers", () => {
  test("a replacement that is not a secret keeps the pass idempotent", () => {
    const once = replaceSecrets(`x PASSWORD="hunter2hunter2" y ${openai}`, ({ kind }) => secretMarker(kind === "password" ? 1 : 2))
    expect(once).toBe('x PASSWORD="‹secret:1›" y ‹secret:2›')
    expect(replaceSecrets(once, () => "CHANGED")).toBe(once)
  })
})

describe("replaceSecretMarkers", () => {
  test("replaces known numbers and leaves unknown ones as written", () => {
    const values = new Map([[1, "one$&value"]])
    expect(replaceSecretMarkers("a ‹secret:1› b ‹secret:2› c ‹secret:1›", (n) => values.get(n))).toBe("a one$&value b ‹secret:2› c one$&value")
  })

  test("text without a marker comes back untouched", () => {
    expect(replaceSecretMarkers("plain", () => "x")).toBe("plain")
  })
})
