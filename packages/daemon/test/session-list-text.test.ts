import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { ageText, compactList, expandSuffix, homeShort, shortSuffix, titleText } from "../src/session-list-text"

describe("session list text", () => {
  test("a short id is the shortest end of at least 8 characters that no other id shares", () => {
    const ids = ["ses_01AAAAAAAAAAXY839KJ", "ses_01BBBBBBBBBBXY839KJ", "ses_01CCCCCCCCCCCCCCCCCC"]
    expect(shortSuffix(ids[2]!, ids)).toBe("CCCCCCCC")
    expect(shortSuffix(ids[0]!, ids)).toBe("AXY839KJ")
    expect(shortSuffix("ses_short", ids)).toBe("es_short")
    expect(shortSuffix("ses_8", ids)).toBe("ses_8")
    // An id that ends the same way as another needs more characters.
    expect(shortSuffix("x12345678", ["x12345678", "y12345678"])).toBe("x12345678")
    expect(shortSuffix("abc", ["abc"])).toBe("abc")
  })

  test("an end of an id names its session when it is unique and is left alone otherwise", () => {
    const ids = ["ses_01AAAAAAAAAAXY839KJ", "ses_01BBBBBBBBBBXY839KJ"]
    expect(expandSuffix("AAXY839KJ", ids)).toBe(ids[0]!)
    expect(expandSuffix("aaxy839kj", ids)).toBe(ids[0]!)
    expect(expandSuffix("XY839KJ", ids)).toBe("XY839KJ")
    expect(expandSuffix("Y839KJ", ids)).toBe("Y839KJ")
    expect(expandSuffix("nothing", ids)).toBe("nothing")
    expect(expandSuffix(ids[1]!, ids)).toBe(ids[1]!)
  })

  test("ages are one unit, titles are cut and the home is a tilde", () => {
    const now = 1_000_000_000_000
    expect(ageText(now, now - 10_000)).toBe("1m")
    expect(ageText(now, now - 3 * 60_000)).toBe("3m")
    expect(ageText(now, now - 4 * 3_600_000)).toBe("4h")
    expect(ageText(now, now - 2 * 86_400_000)).toBe("2d")
    expect(ageText(now, now - 400 * 86_400_000)).toBe("1y")
    expect(titleText("a".repeat(80))).toHaveLength(50)
    expect(titleText("  spaced \n out  ")).toBe("spaced out")
    expect(titleText("")).toBe("untitled")
    expect(homeShort(`${homedir()}/Code/app`)).toBe("~/Code/app")
    expect(homeShort(homedir())).toBe("~")
    expect(homeShort("/srv/app")).toBe("/srv/app")
  })

  test("rows are grouped under their folder once, with the state only when the session is not idle", () => {
    const now = 1_000_000_000_000
    const lines = compactList({ header: "h", now, rows: [
      { id: "aaaaaaaa", state: "idle", at: now - 60_000, title: "one", folder: "/srv/a" },
      { id: "bbbbbbbb", state: "generating", at: now - 120_000, title: "two", folder: "/srv/b" },
      { id: "cccccccc", state: "idle", at: now - 180_000, title: "three", folder: "/srv/a" },
      { id: "dddddddd", at: now - 240_000, title: null },
    ] })
    expect(lines).toEqual(["h", "/srv/a", "  aaaaaaaa · 1m · one", "  cccccccc · 3m · three", "/srv/b", "  bbbbbbbb · generating · 2m · two", "dddddddd · 4m"])
  })
})
